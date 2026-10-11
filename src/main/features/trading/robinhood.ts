import type { OrderStatus } from '@shared/trading'
import type { Broker, BrokerAccount, BrokerClock, BrokerOrder, BrokerPosition, SubmitOrder } from './brokers'
import { isOpen, nextClose, nextOpen } from './marketHours'
import type { PriceFeed } from './marketData'

/**
 * Robinhood's Agentic account, through Robinhood's own MCP server
 * (agent.robinhood.com/mcp/trading), which the user signs in to from the
 * Trading tab (the `robinhood` plugin: OAuth, Eaon's MCP client).
 *
 * The engine trades it like any other account: every order passes the
 * user's limits and the kill switch first, and goes into Eaon's ledger, so
 * the desk's chart, stats and feed work the same. Robinhood only lets an
 * agent place orders in the separately funded Agentic account; the others
 * are read-only.
 *
 * Robinhood publishes the tools (get_accounts, get_portfolio,
 * get_equity_positions, get_equity_orders, place_equity_order,
 * cancel_equity_order) but not a fixed schema, so this reads each tool's
 * input schema when it runs and fills only the fields it can name. A
 * required field it doesn't know stops the order with a message rather
 * than a guess: this is real money.
 */

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** The Robinhood MCP server as Eaon's MCP client sees it. */
export interface McpLink {
  /** `ready` once signed in and connected. */
  state(): 'ready' | 'needs-auth' | 'starting' | 'error' | 'missing'
  tools(): McpToolInfo[]
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>
}

export const ROBINHOOD_TOOLS = {
  accounts: 'get_accounts',
  portfolio: 'get_portfolio',
  positions: 'get_equity_positions',
  orders: 'get_equity_orders',
  place: 'place_equity_order',
  cancel: 'cancel_equity_order'
} as const

export class RobinhoodError extends Error {}

type Json = Record<string, unknown>

const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value.replace(/[$,]/g, '')) : NaN
  return Number.isFinite(n) ? n : null
}
const time = (value: unknown): number | null => {
  const t = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : NaN
  return Number.isFinite(t) ? t : null
}

/** A tool's answer as JSON: the whole text, or the first JSON object or array inside it. */
export function parseAnswer(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.search(/[[{]/)
    if (start < 0) return null
    for (let end = trimmed.length; end > start; end--) {
      const ch = trimmed[end - 1]
      if (ch !== '}' && ch !== ']') continue
      try {
        return JSON.parse(trimmed.slice(start, end))
      } catch {
        /* shorter */
      }
    }
    return null
  }
}

/** The value of the first of `keys` found in `obj` or the objects inside it (a few levels down). */
export function pick(obj: unknown, keys: string[], depth = 3): unknown {
  if (!obj || typeof obj !== 'object' || depth < 0) return undefined
  const record = obj as Json
  for (const key of keys) if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key]
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = pick(value, keys, depth - 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** The list of records in an answer: the answer itself, or the first array of objects inside it. */
export function rows(answer: unknown): Json[] {
  if (Array.isArray(answer)) return answer.filter((r): r is Json => Boolean(r && typeof r === 'object'))
  if (!answer || typeof answer !== 'object') return []
  for (const key of ['results', 'data', 'items', 'positions', 'orders', 'accounts']) {
    const value = (answer as Json)[key]
    if (Array.isArray(value)) return rows(value)
  }
  for (const value of Object.values(answer as Json)) if (Array.isArray(value) && value.some((v) => v && typeof v === 'object')) return rows(value)
  return []
}

const SYMBOL_KEYS = ['symbol', 'ticker', 'instrument_symbol']
const symbolOf = (row: Json): string => String(pick(row, SYMBOL_KEYS, 2) ?? '').toUpperCase()

export function mapRobinhoodStatus(state: string): OrderStatus {
  switch (state.toLowerCase()) {
    case 'filled':
      return 'filled'
    case 'partially_filled':
      return 'partially_filled'
    case 'queued':
    case 'unconfirmed':
    case 'pending':
      return 'pending'
    case 'cancelled':
    case 'canceled':
      return 'canceled'
    case 'rejected':
    case 'failed':
      return 'rejected'
    case 'expired':
      return 'expired'
    default:
      return 'open'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function toBrokerOrder(row: Json): BrokerOrder {
  const ref = String(pick(row, ['ref_id', 'client_order_id', 'idempotency_key'], 1) ?? '')
  const filledQty = num(pick(row, ['cumulative_quantity', 'filled_quantity', 'executed_quantity', 'filled_qty'], 1)) ?? 0
  const type = String(pick(row, ['type', 'order_type'], 1) ?? 'market').toLowerCase()
  const status = mapRobinhoodStatus(String(pick(row, ['state', 'status'], 1) ?? ''))
  return {
    id: String(pick(row, ['id', 'order_id'], 1) ?? ''),
    // Eaon sends the uuid of its `eaon-<uuid>` id as Robinhood's ref_id.
    clientOrderId: ref ? (UUID.test(ref) ? `eaon-${ref}` : ref) : null,
    symbol: symbolOf(row),
    side: String(pick(row, ['side', 'action'], 1) ?? '').toLowerCase().startsWith('sell') ? 'sell' : 'buy',
    type: type.includes('limit') ? 'limit' : 'market',
    qty: num(pick(row, ['quantity', 'qty', 'shares'], 1)) ?? filledQty,
    notional: num(pick(row, ['dollar_based_amount', 'dollar_amount', 'notional'], 2)),
    limitPrice: type.includes('limit') ? num(pick(row, ['limit_price', 'price'], 1)) : null,
    status,
    filledQty,
    filledAvgPrice: filledQty > 0 ? num(pick(row, ['average_price', 'average_fill_price', 'avg_fill_price', 'executed_price'], 1)) : null,
    submittedAt: time(pick(row, ['created_at', 'submitted_at'], 1)) ?? Date.now(),
    filledAt: status === 'filled' || status === 'partially_filled' ? time(pick(row, ['last_transaction_at', 'updated_at', 'filled_at'], 1)) : null,
    error: status === 'rejected' ? (String(pick(row, ['reject_reason', 'reason', 'error'], 1) ?? '') || null) : null
  }
}

interface Schema {
  properties: Record<string, { type?: string; enum?: unknown[]; format?: string }>
  required: string[]
}

const schemaOf = (tool: McpToolInfo | undefined): Schema => {
  const raw = (tool?.inputSchema ?? {}) as { properties?: Schema['properties']; required?: string[] }
  return { properties: raw.properties ?? {}, required: Array.isArray(raw.required) ? raw.required : [] }
}

/**
 * The arguments for an order tool, from its schema: each value goes in the
 * first property named for it. Enum properties get the matching enum value.
 */
export function orderArgs(schema: Schema, order: SubmitOrder, accountNumber: string | null): Json {
  const args: Json = {}
  const has = (key: string): boolean => key in schema.properties
  const first = (keys: string[]): string | null => keys.find(has) ?? null
  const enumValue = (key: string, wanted: string[]): unknown => {
    const options = schema.properties[key]?.enum
    if (!options?.length) return wanted[0]
    for (const w of wanted) {
      const hit = options.find((o) => String(o).toLowerCase() === w)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const set = (keys: string[], value: unknown, wanted?: string[]): boolean => {
    const key = first(keys)
    if (!key || value === undefined) return false
    const v = wanted ? enumValue(key, wanted) : value
    if (v === undefined) throw new RobinhoodError(`Robinhood’s order tool doesn’t take ${wanted?.[0]} for “${key}” (it offers ${(schema.properties[key].enum ?? []).join(', ')}).`)
    args[key] = schema.properties[key]?.type === 'string' && typeof v === 'number' ? String(v) : v
    return true
  }
  if (!set(SYMBOL_KEYS, order.symbol)) throw new RobinhoodError('Robinhood’s order tool has no symbol field Eaon recognises.')
  set(['side', 'action'], order.side, [order.side])
  if (order.qty !== undefined) {
    if (!set(['quantity', 'qty', 'shares'], order.qty)) throw new RobinhoodError('Robinhood’s order tool has no share-quantity field Eaon recognises.')
  } else if (order.notional !== undefined) {
    if (!set(['dollar_amount', 'notional', 'amount', 'dollar_based_amount'], Math.round(order.notional * 100) / 100))
      throw new RobinhoodError('Robinhood’s order tool doesn’t take orders sized in dollars here; give a number of shares.')
  }
  set(['type', 'order_type'], order.type, [order.type])
  if (order.type === 'limit') {
    if (!set(['limit_price', 'price'], order.limitPrice)) throw new RobinhoodError('Robinhood’s order tool has no limit-price field Eaon recognises.')
  }
  set(['time_in_force'], 'gfd', ['gfd', 'day'])
  if (accountNumber) set(['account_number', 'account_id', 'account'], accountNumber)
  const refKey = first(['ref_id', 'client_order_id', 'idempotency_key'])
  if (refKey) args[refKey] = schema.properties[refKey]?.format === 'uuid' || refKey === 'ref_id' ? order.clientOrderId.replace(/^eaon-/, '') : order.clientOrderId
  // An explicit "yes, place it" flag: the user already said yes to real money in Eaon.
  for (const key of ['confirm', 'confirmed', 'acknowledge']) if (has(key) && schema.properties[key].type === 'boolean') args[key] = true
  const missing = schema.required.filter((key) => !(key in args))
  if (missing.length) throw new RobinhoodError(`Robinhood’s order tool needs ${missing.join(', ')}, which Eaon doesn’t know how to fill. Nothing was placed.`)
  return args
}

export interface RobinhoodOptions {
  link: McpLink
  prices: PriceFeed
  now?: () => number
}

export class RobinhoodBroker implements Broker {
  readonly kind = 'robinhood' as const
  private readonly link: McpLink
  private readonly prices: PriceFeed
  private readonly now: () => number
  private cachedAccount: { number: string | null; at: number } | null = null

  constructor(options: RobinhoodOptions) {
    this.link = options.link
    this.prices = options.prices
    this.now = options.now ?? Date.now
  }

  private tool(name: string): McpToolInfo | undefined {
    return this.link.tools().find((t) => t.name === name)
  }

  private async call(name: string, args: Json = {}): Promise<unknown> {
    const state = this.link.state()
    if (state === 'missing' || state === 'needs-auth') throw new RobinhoodError('Robinhood isn’t linked. Sign in to Robinhood from the Trading tab’s account picker.')
    if (state !== 'ready') throw new RobinhoodError('Robinhood is still connecting. Try again in a moment.')
    if (!this.tool(name)) throw new RobinhoodError(`Robinhood’s server doesn’t offer ${name} to this account. Make sure Agentic trading is set up in the Robinhood app.`)
    const result = await this.link.call(name, args)
    if (result.isError) throw new RobinhoodError(`Robinhood: ${result.text.slice(0, 300)}`)
    const answer = parseAnswer(result.text)
    if (answer === null) throw new RobinhoodError(`Robinhood answered ${name} in a way Eaon couldn’t read: ${result.text.slice(0, 160)}`)
    return answer
  }

  /** With the account number, when the tool takes one. */
  private withAccount(name: string, account: string | null, extra: Json = {}): Json {
    const props = schemaOf(this.tool(name)).properties
    const key = ['account_number', 'account_id', 'account'].find((k) => k in props)
    return { ...extra, ...(key && account ? { [key]: account } : {}) }
  }

  /** The Agentic account's number: the account marked agentic, else the only one, else none (the server picks). */
  async accountNumber(): Promise<string | null> {
    if (this.cachedAccount && this.now() - this.cachedAccount.at < 10 * 60_000) return this.cachedAccount.number
    let number: string | null = null
    if (this.tool(ROBINHOOD_TOOLS.accounts)) {
      const accounts = rows(await this.call(ROBINHOOD_TOOLS.accounts))
      const agentic = accounts.find((a) => /agentic/i.test(JSON.stringify(a))) ?? (accounts.length === 1 ? accounts[0] : undefined)
      const value = agentic ? pick(agentic, ['account_number', 'rhs_account_number', 'number', 'account_id', 'id'], 1) : undefined
      number = value === undefined ? null : String(value)
    }
    this.cachedAccount = { number, at: this.now() }
    return number
  }

  async account(): Promise<BrokerAccount> {
    const number = await this.accountNumber()
    const [portfolio, positions] = await Promise.all([
      this.tool(ROBINHOOD_TOOLS.portfolio) ? this.call(ROBINHOOD_TOOLS.portfolio, this.withAccount(ROBINHOOD_TOOLS.portfolio, number)) : Promise.resolve(null),
      this.positions()
    ])
    const held = positions.reduce((sum, p) => sum + p.marketValue, 0)
    const cash = num(pick(portfolio, ['cash', 'cash_balance', 'withdrawable_amount', 'uninvested_cash'])) ?? 0
    const equity = num(pick(portfolio, ['equity', 'total_equity', 'portfolio_value', 'total_value', 'account_value'])) ?? Math.round((cash + held) * 100) / 100
    if (!(equity > 0) && portfolio === null && positions.length === 0) throw new RobinhoodError('Couldn’t read the Robinhood Agentic account’s value.')
    let today = 0
    for (const p of positions) if (p.dayChangePct !== null) today += p.marketValue - p.marketValue / (1 + p.dayChangePct / 100)
    const last = num(pick(portfolio, ['equity_previous_close', 'adjusted_equity_previous_close', 'previous_close', 'last_equity']))
    return {
      equity,
      cash,
      buyingPower: num(pick(portfolio, ['buying_power', 'cash_available_for_trading', 'buying_power_equity'])) ?? cash,
      lastEquity: last ?? Math.round((equity - today) * 100) / 100,
      status: 'agentic',
      blocked: false
    }
  }

  async positions(): Promise<BrokerPosition[]> {
    const number = await this.accountNumber()
    const held = rows(await this.call(ROBINHOOD_TOOLS.positions, this.withAccount(ROBINHOOD_TOOLS.positions, number)))
    const out: BrokerPosition[] = []
    for (const row of held) {
      const symbol = symbolOf(row)
      const qty = num(pick(row, ['quantity', 'qty', 'shares'], 1)) ?? 0
      if (!symbol || qty === 0) continue
      const avgPrice = num(pick(row, ['average_buy_price', 'average_price', 'avg_price', 'cost_basis_per_share'], 1)) ?? 0
      const quote = await this.prices.quote(symbol).catch(() => null)
      const price = quote?.price ?? (num(pick(row, ['price', 'last_trade_price', 'current_price'], 2)) ?? avgPrice)
      const marketValue = Math.round(qty * price * 100) / 100
      out.push({
        symbol,
        qty,
        avgPrice,
        price,
        marketValue,
        unrealizedPl: Math.round((marketValue - qty * avgPrice) * 100) / 100,
        dayChangePct: quote ? quote.changePct : null
      })
    }
    return out
  }

  async orders(limit: number): Promise<BrokerOrder[]> {
    const number = await this.accountNumber()
    const list = rows(await this.call(ROBINHOOD_TOOLS.orders, this.withAccount(ROBINHOOD_TOOLS.orders, number)))
    return list
      .map(toBrokerOrder)
      .filter((o) => o.id && o.symbol)
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .slice(0, Math.max(1, Math.floor(limit)))
  }

  async submit(order: SubmitOrder): Promise<BrokerOrder> {
    const tool = this.tool(ROBINHOOD_TOOLS.place)
    if (!tool) throw new RobinhoodError('Robinhood’s server doesn’t offer place_equity_order to this account. Make sure Agentic trading is set up in the Robinhood app.')
    const args = orderArgs(schemaOf(tool), order, await this.accountNumber())
    const answer = await this.call(ROBINHOOD_TOOLS.place, args)
    const row = (rows(answer)[0] ?? (pick(answer, ['order'], 1) as Json | undefined) ?? answer) as Json
    const placed = toBrokerOrder(row)
    return {
      ...placed,
      id: placed.id || String(pick(answer, ['id', 'order_id']) ?? ''),
      clientOrderId: placed.clientOrderId ?? order.clientOrderId,
      symbol: placed.symbol || order.symbol,
      side: order.side,
      qty: placed.qty || order.qty || 0,
      notional: placed.notional ?? order.notional ?? null
    }
  }

  async cancel(id: string): Promise<void> {
    const schema = schemaOf(this.tool(ROBINHOOD_TOOLS.cancel))
    const key = ['order_id', 'id'].find((k) => k in schema.properties) ?? 'order_id'
    await this.call(ROBINHOOD_TOOLS.cancel, this.withAccount(ROBINHOOD_TOOLS.cancel, await this.accountNumber(), { [key]: id }))
  }

  async clock(): Promise<BrokerClock> {
    const now = this.now()
    return { isOpen: isOpen(now), nextOpen: nextOpen(now), nextClose: nextClose(now) }
  }
}
