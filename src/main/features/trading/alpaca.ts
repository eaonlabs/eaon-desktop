import type { BrokerKind, EquityPoint, OrderStatus } from '@shared/trading'
import type { AlpacaKeys, Broker, BrokerAccount, BrokerClock, BrokerOrder, BrokerPosition, SubmitOrder } from './brokers'

/**
 * Alpaca, a real broker with a free API: the paper account (pretend money,
 * real order handling) and the live account (real money). Same API, two base
 * URLs, separate keys.
 *
 * Keys travel only in the `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` headers;
 * they are never put in an error message or a log line. Every order Eaon
 * places carries `client_order_id = eaon-<uuid>`, which is how the engine
 * ties Alpaca's copy of the order back to who placed it and why.
 */

export type AlpacaKind = Extract<BrokerKind, 'alpaca-paper' | 'alpaca-live'>

export const ALPACA_URLS: Record<AlpacaKind, string> = {
  'alpaca-paper': 'https://paper-api.alpaca.markets',
  'alpaca-live': 'https://api.alpaca.markets'
}

const TIMEOUT_MS = 15_000

/** An HTTP failure from Alpaca, already turned into a sentence for the user. */
export class AlpacaError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}
const time = (value: unknown): number | null => {
  const t = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(t) ? t : null
}

/**
 * Alpaca's order lifecycle, folded onto the desk's seven states. "Pending"
 * is accepted but not yet working at the exchange; "open" is working.
 */
export function mapAlpacaStatus(status: string): OrderStatus {
  switch (status) {
    case 'filled':
      return 'filled'
    case 'partially_filled':
      return 'partially_filled'
    case 'pending_new':
    case 'accepted':
    case 'accepted_for_bidding':
    case 'calculated':
    case 'pending_replace':
      return 'pending'
    case 'canceled':
    case 'replaced':
      return 'canceled'
    case 'expired':
    case 'done_for_day':
      return 'expired'
    case 'rejected':
      return 'rejected'
    default:
      // new, held, stopped, suspended, pending_cancel: still working.
      return 'open'
  }
}

interface RawOrder {
  id?: string
  client_order_id?: string
  symbol?: string
  side?: string
  type?: string
  order_type?: string
  qty?: string | null
  notional?: string | null
  limit_price?: string | null
  status?: string
  filled_qty?: string
  filled_avg_price?: string | null
  submitted_at?: string | null
  created_at?: string
  filled_at?: string | null
}

export function toBrokerOrder(raw: RawOrder): BrokerOrder {
  const type = raw.type ?? raw.order_type ?? 'market'
  const filledQty = num(raw.filled_qty) ?? 0
  return {
    id: String(raw.id ?? ''),
    clientOrderId: raw.client_order_id ?? null,
    symbol: String(raw.symbol ?? ''),
    side: raw.side === 'sell' ? 'sell' : 'buy',
    // Stop and trailing orders placed elsewhere show as the nearest of the two kinds Eaon places.
    type: type === 'limit' || type === 'stop_limit' ? 'limit' : 'market',
    qty: num(raw.qty) ?? filledQty,
    notional: num(raw.notional),
    limitPrice: num(raw.limit_price),
    status: mapAlpacaStatus(String(raw.status ?? '')),
    filledQty,
    filledAvgPrice: num(raw.filled_avg_price),
    submittedAt: time(raw.submitted_at) ?? time(raw.created_at) ?? Date.now(),
    filledAt: time(raw.filled_at),
    error: null
  }
}

export interface AlpacaOptions {
  kind: AlpacaKind
  keys: AlpacaKeys
  /** Overrides the account's base URL; tests point it at a local server. */
  baseUrl?: string
  fetch?: typeof fetch
}

export class AlpacaBroker implements Broker {
  readonly kind: AlpacaKind
  private readonly baseUrl: string
  private readonly keys: AlpacaKeys
  private readonly fetchImpl: typeof fetch

  constructor(options: AlpacaOptions) {
    this.kind = options.kind
    this.keys = options.keys
    this.baseUrl = (options.baseUrl ?? ALPACA_URLS[options.kind]).replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
  }

  private get label(): string {
    return this.kind === 'alpaca-live' ? 'live' : 'paper'
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'APCA-API-KEY-ID': this.keys.keyId,
          'APCA-API-SECRET-KEY': this.keys.secret,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') throw new AlpacaError('Alpaca took too long to answer. Check your internet connection and try again.', 0)
      throw new AlpacaError(`Couldn’t reach Alpaca (${error instanceof Error ? error.message : String(error)}). Check your internet connection.`, 0)
    }
    const text = await response.text()
    if (!response.ok) throw new AlpacaError(this.explain(response.status, path, text), response.status)
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new AlpacaError('Alpaca sent an answer Eaon couldn’t read. Try again shortly.', response.status)
    }
  }

  /** An HTTP failure as a sentence that says what to do. */
  private explain(status: number, path: string, body: string): string {
    let message = ''
    try {
      message = String((JSON.parse(body) as { message?: unknown }).message ?? '')
    } catch {
      message = ''
    }
    const refused = `Alpaca refused these keys. Check you copied both the key ID and the secret from your Alpaca ${this.label} account (paper and live accounts have different keys), or make new ones in Alpaca’s dashboard.`
    if (status === 401) return refused
    const ordering = path.startsWith('/v2/orders')
    if (status === 403) {
      // 403 is also how Alpaca refuses an order it won't take (not enough
      // buying power, shares it can't short); those say why.
      if (ordering && message && !/forbidden|not authorized|unauthorized/i.test(message)) return `Alpaca refused the order: ${message}.`
      return refused
    }
    if (status === 404 && ordering) return 'Alpaca has no such order. It may have filled or been canceled already.'
    if (status === 422) return `Alpaca rejected the order: ${message || 'it didn’t accept the details'}.`
    if (status === 429) return 'Alpaca is limiting requests right now. Try again in a minute.'
    if (status >= 500) return `Alpaca is having trouble right now (HTTP ${status}). Try again shortly.`
    return `Alpaca answered HTTP ${status}${message ? `: ${message}` : ''}.`
  }

  async account(): Promise<BrokerAccount> {
    const raw = await this.request<Record<string, unknown>>('GET', '/v2/account')
    const equity = num(raw.equity) ?? 0
    return {
      equity,
      cash: num(raw.cash) ?? 0,
      buyingPower: num(raw.buying_power) ?? 0,
      lastEquity: num(raw.last_equity) ?? equity,
      status: String(raw.status ?? ''),
      blocked: raw.trading_blocked === true || raw.account_blocked === true
    }
  }

  async positions(): Promise<BrokerPosition[]> {
    const raw = await this.request<Record<string, unknown>[]>('GET', '/v2/positions')
    return (Array.isArray(raw) ? raw : []).map((p) => {
      const qty = num(p.qty) ?? 0
      const change = num(p.change_today)
      return {
        symbol: String(p.symbol ?? ''),
        qty: p.side === 'short' && qty > 0 ? -qty : qty,
        avgPrice: num(p.avg_entry_price) ?? 0,
        price: num(p.current_price) ?? 0,
        marketValue: num(p.market_value) ?? 0,
        unrealizedPl: num(p.unrealized_pl) ?? 0,
        dayChangePct: change === null ? null : Math.round(change * 100_000) / 1000
      }
    })
  }

  async orders(limit: number): Promise<BrokerOrder[]> {
    const capped = Math.max(1, Math.min(500, Math.floor(limit)))
    const raw = await this.request<RawOrder[]>('GET', `/v2/orders?status=all&limit=${capped}&direction=desc`)
    return (Array.isArray(raw) ? raw : []).map(toBrokerOrder)
  }

  async submit(order: SubmitOrder): Promise<BrokerOrder> {
    const body: Record<string, string> = {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      time_in_force: 'day',
      client_order_id: order.clientOrderId
    }
    if (order.qty !== undefined) body.qty = String(order.qty)
    else if (order.notional !== undefined) body.notional = order.notional.toFixed(2)
    if (order.type === 'limit' && order.limitPrice !== undefined) body.limit_price = String(order.limitPrice)
    const raw = await this.request<RawOrder>('POST', '/v2/orders', body)
    return toBrokerOrder(raw)
  }

  async cancel(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `/v2/orders/${encodeURIComponent(id)}`)
  }

  async clock(): Promise<BrokerClock> {
    const raw = await this.request<Record<string, unknown>>('GET', '/v2/clock')
    return { isOpen: raw.is_open === true, nextOpen: time(raw.next_open), nextClose: time(raw.next_close) }
  }

  /** The last month of daily equity, to start the desk's chart with. */
  async history(): Promise<EquityPoint[]> {
    const raw = await this.request<{ timestamp?: number[]; equity?: (number | null)[] }>('GET', '/v2/account/portfolio/history?period=1M&timeframe=1D')
    const times = raw?.timestamp ?? []
    const values = raw?.equity ?? []
    const points: EquityPoint[] = []
    for (let i = 0; i < times.length; i++) {
      const equity = num(values[i])
      if (equity !== null && equity > 0) points.push({ at: times[i] * 1000, equity })
    }
    return points
  }
}

/** Checks a pair of keys by reading the account; throws a sentence for the user when they don't work. */
export async function verifyAlpacaKeys(kind: AlpacaKind, keys: AlpacaKeys, baseUrl?: string): Promise<BrokerAccount> {
  if (!keys.keyId.trim() || !keys.secret.trim()) throw new Error('Paste both the API key ID and the secret key from your Alpaca dashboard.')
  const broker = new AlpacaBroker({ kind, keys: { keyId: keys.keyId.trim(), secret: keys.secret.trim() }, ...(baseUrl ? { baseUrl } : {}) })
  return broker.account()
}
