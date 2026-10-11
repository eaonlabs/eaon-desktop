import type { BrokerKind, OrderStatus } from '@shared/trading'
import type { AlpacaKeys, Broker, BrokerAccount, BrokerClock, BrokerOrder, BrokerPosition, SubmitOrder } from './brokers'
import { isOpen, nextClose, nextOpen } from './marketHours'
import type { PriceFeed } from './marketData'

/**
 * Tradier, a broker with a plain REST API: the sandbox (pretend money,
 * real order handling against delayed prices) and the brokerage account
 * (real money). Same API, two base URLs, separate access tokens.
 *
 * The token travels only in the `Authorization` header. The account is the
 * first one on the token's profile unless the user named one. Every order
 * Eaon places carries `tag = eaon-<uuid>`, which is how the engine ties
 * Tradier's copy of the order back to who placed it and why.
 *
 * Tradier trades whole shares only and has no orders sized in dollars, so a
 * dollar order is turned into the whole shares it buys at the latest price.
 * Its positions carry no price, so they are priced from Eaon's feed.
 */

export type TradierKind = Extract<BrokerKind, 'tradier-paper' | 'tradier-live'>

export const TRADIER_URLS: Record<TradierKind, string> = {
  'tradier-paper': 'https://sandbox.tradier.com/v1',
  'tradier-live': 'https://api.tradier.com/v1'
}

/** A Tradier link: `secret` is the access token, `keyId` the account number (empty: the profile's first). */
export type TradierKeys = AlpacaKeys

const TIMEOUT_MS = 15_000

export class TradierError extends Error {
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
/** Tradier answers one item as an object and several as an array, and none as "null". */
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : value && typeof value === 'object' ? [value as T] : [])

export function mapTradierStatus(status: string): OrderStatus {
  switch (status) {
    case 'filled':
      return 'filled'
    case 'partially_filled':
      return 'partially_filled'
    case 'pending':
      return 'pending'
    case 'canceled':
      return 'canceled'
    case 'expired':
      return 'expired'
    case 'rejected':
    case 'error':
      return 'rejected'
    default:
      return 'open'
  }
}

interface RawOrder {
  id?: number | string
  type?: string
  symbol?: string
  side?: string
  quantity?: number | string
  status?: string
  price?: number | string
  avg_fill_price?: number | string
  exec_quantity?: number | string
  create_date?: string
  transaction_date?: string
  class?: string
  tag?: string
  reason_description?: string
}

export function toBrokerOrder(raw: RawOrder): BrokerOrder {
  const status = mapTradierStatus(String(raw.status ?? ''))
  const filledQty = num(raw.exec_quantity) ?? 0
  return {
    id: String(raw.id ?? ''),
    clientOrderId: raw.tag ? String(raw.tag) : null,
    symbol: String(raw.symbol ?? '').toUpperCase(),
    // buy_to_cover and sell_short come from orders placed elsewhere.
    side: String(raw.side ?? '').startsWith('sell') ? 'sell' : 'buy',
    type: raw.type === 'limit' || raw.type === 'stop_limit' ? 'limit' : 'market',
    qty: num(raw.quantity) ?? filledQty,
    notional: null,
    limitPrice: raw.type === 'limit' || raw.type === 'stop_limit' ? num(raw.price) : null,
    status,
    filledQty,
    filledAvgPrice: filledQty > 0 ? num(raw.avg_fill_price) : null,
    submittedAt: time(raw.create_date) ?? Date.now(),
    filledAt: status === 'filled' || status === 'partially_filled' ? time(raw.transaction_date) : null,
    error: status === 'rejected' && raw.reason_description ? String(raw.reason_description) : null
  }
}

export interface TradierOptions {
  kind: TradierKind
  keys: TradierKeys
  /** Prices for positions and for turning dollars into shares. */
  prices: PriceFeed
  /** Overrides the base URL; tests point it at a local server. */
  baseUrl?: string
  fetch?: typeof fetch
  now?: () => number
}

export class TradierBroker implements Broker {
  readonly kind: TradierKind
  private readonly baseUrl: string
  private readonly keys: TradierKeys
  private readonly prices: PriceFeed
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private accountId: string | null

  constructor(options: TradierOptions) {
    this.kind = options.kind
    this.keys = options.keys
    this.prices = options.prices
    this.baseUrl = (options.baseUrl ?? TRADIER_URLS[options.kind]).replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.accountId = options.keys.keyId.trim() || null
  }

  private get label(): string {
    return this.kind === 'tradier-live' ? 'brokerage' : 'sandbox'
  }

  private async request<T>(method: string, path: string, form?: Record<string, string>): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.keys.secret}`,
          Accept: 'application/json',
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') throw new TradierError('Tradier took too long to answer. Check your internet connection and try again.', 0)
      throw new TradierError(`Couldn’t reach Tradier (${error instanceof Error ? error.message : String(error)}). Check your internet connection.`, 0)
    }
    const text = await response.text()
    if (!response.ok) throw new TradierError(this.explain(response.status, path, text), response.status)
    if (!text) return undefined as T
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new TradierError('Tradier sent an answer Eaon couldn’t read. Try again shortly.', response.status)
    }
    // An order Tradier won't take comes back 200 with an `errors` object.
    const errors = (body as { errors?: { error?: unknown } } | null)?.errors?.error
    if (errors) throw new TradierError(`Tradier refused: ${list<string>(errors).join(' ') || 'no reason given'}.`, response.status)
    return body as T
  }

  private explain(status: number, path: string, body: string): string {
    const detail = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (status === 401) return `Tradier refused this access token. Copy your ${this.label} token again from Tradier → Settings → API Access (sandbox and brokerage tokens are different).`
    if (status === 400 && path.includes('/orders')) return `Tradier rejected the order${detail ? `: ${detail}` : ''}.`
    if (status === 404 && path.includes('/orders/')) return 'Tradier has no such order. It may have filled or been canceled already.'
    if (status === 429) return 'Tradier is limiting requests right now. Try again in a minute.'
    if (status >= 500) return `Tradier is having trouble right now (HTTP ${status}). Try again shortly.`
    return `Tradier answered HTTP ${status}${detail ? `: ${detail}` : ''}.`
  }

  /** The account to trade: the one named, or the token's first. */
  async accountNumber(): Promise<string> {
    if (this.accountId) return this.accountId
    const raw = await this.request<{ profile?: { account?: unknown } }>('GET', '/user/profile')
    const accounts = list<{ account_number?: string; status?: string }>(raw?.profile?.account)
    const first = accounts.find((a) => a.status !== 'closed') ?? accounts[0]
    if (!first?.account_number) throw new TradierError(`This Tradier ${this.label} token has no account to trade.`, 0)
    this.accountId = String(first.account_number)
    return this.accountId
  }

  async account(): Promise<BrokerAccount> {
    const id = await this.accountNumber()
    const [raw, positions] = await Promise.all([this.request<{ balances?: Record<string, unknown> }>('GET', `/accounts/${id}/balances`), this.positions()])
    const b = raw?.balances ?? {}
    const equity = num(b.total_equity) ?? 0
    const type = String(b.account_type ?? '')
    const sub = (b[type] as Record<string, unknown> | undefined) ?? {}
    const buyingPower = num(sub.stock_buying_power) ?? num(sub.cash_available) ?? num(b.total_cash) ?? 0
    // Tradier gives no "equity at yesterday's close": take today's move of the holdings off.
    let today = 0
    for (const p of positions) if (p.dayChangePct !== null && p.price > 0) today += p.marketValue - p.marketValue / (1 + p.dayChangePct / 100)
    return {
      equity,
      cash: num(b.total_cash) ?? 0,
      buyingPower,
      lastEquity: Math.round((equity - today) * 100) / 100,
      status: type || 'active',
      blocked: false
    }
  }

  async positions(): Promise<BrokerPosition[]> {
    const id = await this.accountNumber()
    const raw = await this.request<{ positions?: { position?: unknown } | 'null' }>('GET', `/accounts/${id}/positions`)
    const held = list<{ symbol?: string; quantity?: number | string; cost_basis?: number | string }>(typeof raw?.positions === 'object' ? raw.positions?.position : null)
    return Promise.all(
      held.map(async (p) => {
        const symbol = String(p.symbol ?? '').toUpperCase()
        const qty = num(p.quantity) ?? 0
        const cost = num(p.cost_basis) ?? 0
        const avgPrice = qty !== 0 ? Math.abs(cost / qty) : 0
        const quote = await this.prices.quote(symbol).catch(() => null)
        const price = quote?.price ?? avgPrice
        const marketValue = Math.round(qty * price * 100) / 100
        return {
          symbol,
          qty,
          avgPrice: Math.round(avgPrice * 10_000) / 10_000,
          price,
          marketValue,
          unrealizedPl: Math.round((marketValue - cost) * 100) / 100,
          dayChangePct: quote ? quote.changePct : null
        }
      })
    )
  }

  async orders(limit: number): Promise<BrokerOrder[]> {
    const id = await this.accountNumber()
    const raw = await this.request<{ orders?: { order?: unknown } | 'null' }>('GET', `/accounts/${id}/orders`)
    const orders = list<RawOrder>(typeof raw?.orders === 'object' ? raw.orders?.order : null).filter((o) => !o.class || o.class === 'equity')
    return orders
      .map(toBrokerOrder)
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .slice(0, Math.max(1, Math.floor(limit)))
  }

  async submit(order: SubmitOrder): Promise<BrokerOrder> {
    const id = await this.accountNumber()
    let qty = order.qty
    if (qty === undefined && order.notional !== undefined) {
      const price = (await this.prices.quote(order.symbol)).price
      qty = Math.floor(order.notional / price)
      if (qty < 1) throw new TradierError(`Tradier trades whole shares only, and $${order.notional.toFixed(2)} doesn’t buy one share of ${order.symbol} at $${price.toFixed(2)}.`, 0)
    }
    if (qty === undefined || !Number.isInteger(qty)) throw new TradierError(`Tradier trades whole shares only; ${qty ?? '?'} ${order.symbol} isn’t a whole number.`, 0)
    const form: Record<string, string> = {
      class: 'equity',
      symbol: order.symbol,
      side: order.side,
      quantity: String(qty),
      type: order.type,
      duration: 'day',
      tag: order.clientOrderId
    }
    if (order.type === 'limit' && order.limitPrice !== undefined) form.price = String(order.limitPrice)
    const placed = await this.request<{ order?: { id?: number | string; status?: string } }>('POST', `/accounts/${id}/orders`, form)
    const orderId = String(placed?.order?.id ?? '')
    // Tradier only says "ok"; read the order back for its state (a market order may have filled already).
    const back = orderId ? await this.request<{ order?: RawOrder }>('GET', `/accounts/${id}/orders/${orderId}`).catch(() => null) : null
    return toBrokerOrder(
      back?.order ?? { id: orderId, symbol: order.symbol, side: order.side, type: order.type, quantity: qty, status: 'pending', tag: order.clientOrderId, create_date: new Date(this.now()).toISOString() }
    )
  }

  async cancel(orderId: string): Promise<void> {
    const id = await this.accountNumber()
    await this.request<unknown>('DELETE', `/accounts/${id}/orders/${encodeURIComponent(orderId)}`)
  }

  /** The market's hours from Eaon's own calendar: one request fewer on every refresh. */
  async clock(): Promise<BrokerClock> {
    const now = this.now()
    return { isOpen: isOpen(now), nextOpen: nextOpen(now), nextClose: nextClose(now) }
  }
}
