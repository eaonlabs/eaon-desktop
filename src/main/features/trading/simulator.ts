import { randomUUID } from 'node:crypto'
import type { OrderSide } from '@shared/trading'
import { roundMoney, roundPrice, roundQty, type Broker, type BrokerAccount, type BrokerClock, type BrokerOrder, type BrokerPosition, type SubmitOrder } from './brokers'
import { formatMarketTime, isOpen, marketDate, nextClose, nextOpen } from './marketHours'
import type { PriceFeed } from './marketData'

/**
 * The simulator: a practice account kept on this computer, priced with real
 * quotes, so anyone can try agentic trading with nothing at risk.
 *
 * It behaves like a plain cash account at a real broker, which keeps what the
 * agent learns here true at Alpaca:
 * - Market orders fill straight away at the live price plus a little slippage
 *   (0.02%, against you), during market hours only — unless the user turned on
 *   "trade anytime", which fills at the last price whenever.
 * - Limit orders wait, and fill on a later check (`settle`) that sees the price
 *   reach the limit; like a broker's day order, one not filled by the close
 *   expires.
 * - Fractional shares (to 4 decimals) and orders sized in dollars are fine.
 * - No margin and no short selling: buys need the cash, sells need the shares,
 *   counting what open orders have already set aside.
 */

/** Price slippage on every fill, as a fraction: buyers pay a touch more, sellers get a touch less. */
export const SIM_SLIPPAGE = 0.0002
/** Orders kept in the file; open ones are never dropped. */
const MAX_ORDERS = 500
/** Shares and dollars are rounded, so compare with a little room. */
const EPSILON = 1e-6

interface SimHolding {
  qty: number
  avgPrice: number
  /** The last price seen, for valuing the holding when a quote can't be had. */
  lastPrice: number | null
}

interface SimOrder extends BrokerOrder {
  /** A day order: when it lapses unfilled. */
  expiresAt: number
}

export interface SimState {
  cash: number
  startingCash: number
  positions: Record<string, SimHolding>
  /** Newest first. */
  orders: SimOrder[]
  /** The New York date `lastEquity` was rolled on. */
  day: string | null
  /** Equity at the end of the previous day, so the desk can show today's change. */
  lastEquity: number
  /** The latest equity worked out, which becomes `lastEquity` when the date changes. */
  lastSeenEquity: number
  createdAt: number
}

export interface SimulatorDeps {
  load: () => unknown
  save: (state: SimState) => void
  prices: Pick<PriceFeed, 'quote'>
  /** Fill outside market hours, at the last price. */
  anytime: () => boolean
  /** What a new account starts with. */
  startingCash: () => number
  now?: () => number
  slippage?: number
}

function fresh(cash: number, now: number): SimState {
  return { cash, startingCash: cash, positions: {}, orders: [], day: null, lastEquity: cash, lastSeenEquity: cash, createdAt: now }
}

const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** The saved account, or a new one when the file is missing or damaged. */
function normalize(raw: unknown, cash: number, now: number): SimState {
  const v = raw as Partial<SimState> | null
  if (!v || typeof v !== 'object' || typeof v.cash !== 'number' || !Number.isFinite(v.cash)) return fresh(cash, now)
  const positions: Record<string, SimHolding> = {}
  for (const [symbol, h] of Object.entries(v.positions ?? {})) {
    if (h && typeof h.qty === 'number' && h.qty > EPSILON) positions[symbol] = { qty: h.qty, avgPrice: num(h.avgPrice, 0), lastPrice: typeof h.lastPrice === 'number' ? h.lastPrice : null }
  }
  const startingCash = num(v.startingCash, cash)
  return {
    cash: v.cash,
    startingCash,
    positions,
    orders: Array.isArray(v.orders) ? v.orders.filter((o) => o && typeof o.id === 'string' && typeof o.symbol === 'string') : [],
    day: typeof v.day === 'string' ? v.day : null,
    lastEquity: num(v.lastEquity, startingCash),
    lastSeenEquity: num(v.lastSeenEquity, startingCash),
    createdAt: num(v.createdAt, now)
  }
}

const money = (value: number): string => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export class SimulatorBroker implements Broker {
  readonly kind = 'simulator' as const
  private state: SimState
  private readonly now: () => number
  private readonly slippage: number

  constructor(private readonly deps: SimulatorDeps) {
    this.now = deps.now ?? Date.now
    this.slippage = deps.slippage ?? SIM_SLIPPAGE
    this.state = normalize(deps.load(), deps.startingCash(), this.now())
  }

  /** Back to a fresh account with this much cash: no positions, no orders. */
  reset(cash: number): void {
    this.state = fresh(roundMoney(cash), this.now())
    this.save()
  }

  get startingCash(): number {
    return this.state.startingCash
  }

  async account(): Promise<BrokerAccount> {
    const marks = await this.marks()
    let value = 0
    for (const [symbol, holding] of Object.entries(this.state.positions)) value += holding.qty * (marks.get(symbol)?.price ?? holding.avgPrice)
    const equity = roundMoney(this.state.cash + value)
    this.rollDay(equity)
    return {
      equity,
      cash: roundMoney(this.state.cash),
      buyingPower: roundMoney(Math.max(0, this.state.cash - this.reservedCash())),
      lastEquity: this.state.lastEquity,
      status: 'ACTIVE',
      blocked: false
    }
  }

  async positions(): Promise<BrokerPosition[]> {
    const marks = await this.marks()
    return Object.entries(this.state.positions)
      .map(([symbol, holding]) => {
        const mark = marks.get(symbol)
        const price = mark?.price ?? holding.avgPrice
        const marketValue = roundMoney(holding.qty * price)
        return {
          symbol,
          qty: holding.qty,
          avgPrice: holding.avgPrice,
          price,
          marketValue,
          unrealizedPl: roundMoney(marketValue - holding.qty * holding.avgPrice),
          dayChangePct: mark?.dayChangePct ?? null
        }
      })
      .sort((a, b) => b.marketValue - a.marketValue)
  }

  async orders(limit: number): Promise<BrokerOrder[]> {
    return this.state.orders.slice(0, limit).map(plain)
  }

  async clock(): Promise<BrokerClock> {
    const now = this.now()
    return { isOpen: isOpen(now), nextOpen: nextOpen(now), nextClose: nextClose(now) }
  }

  async submit(request: SubmitOrder): Promise<BrokerOrder> {
    const now = this.now()
    const { symbol, side, type } = request
    if (type === 'limit' && !(typeof request.limitPrice === 'number' && request.limitPrice > 0)) throw new Error('A limit order needs a limit price above zero.')
    if (request.notional !== undefined && type !== 'market') throw new Error('An order sized in dollars has to be a market order. Give a number of shares for a limit order.')
    const quote = await this.deps.prices.quote(symbol)
    if (quote.currency !== 'USD') throw new Error(`${symbol} is priced in ${quote.currency}. The simulator trades US stocks and ETFs priced in dollars.`)
    this.remember(symbol, quote.price)

    const order: SimOrder = {
      id: randomUUID(),
      clientOrderId: request.clientOrderId,
      symbol,
      side,
      type,
      qty: request.qty !== undefined ? roundQty(request.qty) : 0,
      notional: request.notional ?? null,
      limitPrice: type === 'limit' ? roundPrice(request.limitPrice!) : null,
      status: 'open',
      filledQty: 0,
      filledAvgPrice: null,
      submittedAt: now,
      filledAt: null,
      error: null,
      expiresAt: nextClose(now)
    }

    if (type === 'market') {
      if (!this.canFill()) {
        throw new Error(
          `The market is closed (it opens ${formatMarketTime(nextOpen(now), now)}), so the simulator can’t fill a market order now. Use a limit order to wait for the open, or turn on “Trade anytime” to practise outside market hours.`
        )
      }
      const price = this.slip(quote.price, side)
      const qty = request.qty !== undefined ? roundQty(request.qty) : this.qtyForNotional(symbol, side, request.notional ?? 0, price)
      if (!(qty > 0)) throw new Error('That order is too small: it comes to less than 0.0001 shares.')
      this.ensureFunds(symbol, side, qty, price)
      this.fill(order, qty, price)
    } else {
      if (!(order.qty > 0)) throw new Error('Give a number of shares above zero.')
      this.ensureFunds(symbol, side, order.qty, order.limitPrice!)
      const fillAt = this.canFill() ? this.limitFill(order, quote.price) : null
      if (fillAt !== null) this.fill(order, order.qty, fillAt)
    }

    this.state.orders.unshift(order)
    this.trim()
    this.save()
    return plain(order)
  }

  async cancel(id: string): Promise<void> {
    const order = this.state.orders.find((o) => o.id === id || o.clientOrderId === id)
    if (!order) throw new Error('There is no such order in the simulator.')
    if (order.status !== 'open') throw new Error(`That order isn’t open any more — it was ${order.status === 'filled' ? 'filled' : order.status}.`)
    order.status = 'canceled'
    this.save()
  }

  /**
   * Expires day orders past their close and fills limit orders the price has
   * reached. Called on every refresh; a limit order fills at its limit or
   * better, never worse.
   */
  async settle(): Promise<void> {
    const open = this.state.orders.filter((o) => o.status === 'open')
    if (open.length === 0) return
    const now = this.now()
    let changed = false
    for (const order of open) {
      if (now >= order.expiresAt) {
        order.status = 'expired'
        changed = true
      }
    }
    if (this.canFill()) {
      for (const order of open) {
        if (order.status !== 'open') continue
        let price: number
        try {
          price = (await this.deps.prices.quote(order.symbol)).price
        } catch {
          continue // no price this time; the next check tries again
        }
        this.remember(order.symbol, price)
        const fillAt = this.limitFill(order, price)
        if (fillAt === null) continue
        // What it set aside is its own; only what other orders hold back counts against it.
        const problem = this.fundsProblem(order.symbol, order.side, order.qty, fillAt, order)
        if (problem) {
          order.status = 'canceled'
          order.error = `Canceled when the price reached the limit: ${problem}`
        } else {
          this.fill(order, order.qty, fillAt)
        }
        changed = true
      }
    }
    if (changed) this.save()
  }

  /* ----------------------------------------------------------- internals */

  private canFill(): boolean {
    return this.deps.anytime() || isOpen(this.now())
  }

  private slip(price: number, side: OrderSide): number {
    return roundPrice(side === 'buy' ? price * (1 + this.slippage) : price * (1 - this.slippage))
  }

  /** The fill price for a limit order at this market price, or null while the price hasn't reached the limit. */
  private limitFill(order: SimOrder, price: number): number | null {
    const limit = order.limitPrice!
    if (order.side === 'buy') return price <= limit ? Math.min(this.slip(price, 'buy'), limit) : null
    return price >= limit ? Math.max(this.slip(price, 'sell'), limit) : null
  }

  private qtyForNotional(symbol: string, side: OrderSide, notional: number, price: number): number {
    const qty = roundQty(notional / price)
    if (side === 'sell') {
      // Selling "all of it" in dollars lands a hair over the holding after rounding.
      const free = this.freeShares(symbol)
      if (qty > free && qty - free < 0.001) return free
    }
    return qty
  }

  /** Cash set aside for open limit buys. */
  private reservedCash(except?: SimOrder): number {
    let total = 0
    for (const o of this.state.orders) if (o !== except && o.status === 'open' && o.side === 'buy') total += o.qty * (o.limitPrice ?? 0)
    return total
  }

  /** Shares not already promised to an open sell order. */
  private freeShares(symbol: string, except?: SimOrder): number {
    const held = this.state.positions[symbol]?.qty ?? 0
    let promised = 0
    for (const o of this.state.orders) if (o !== except && o.status === 'open' && o.side === 'sell' && o.symbol === symbol) promised += o.qty
    return roundQty(held - promised)
  }

  private fundsProblem(symbol: string, side: OrderSide, qty: number, price: number, except?: SimOrder): string | null {
    if (side === 'buy') {
      const cost = qty * price
      const free = this.state.cash - this.reservedCash(except)
      return cost > free + 0.005 ? `Not enough cash: this needs ${money(cost)} and ${money(Math.max(0, free))} is free.` : null
    }
    const held = this.state.positions[symbol]?.qty ?? 0
    const free = this.freeShares(symbol, except)
    if (qty <= free + EPSILON) return null
    if (held <= EPSILON) return `You don’t hold any ${symbol}, and short selling isn’t allowed.`
    return `You hold ${held} ${symbol}${free < held ? ` (${roundQty(held - free)} already in open sell orders)` : ''}, so you can’t sell ${qty}. Short selling isn’t allowed.`
  }

  private ensureFunds(symbol: string, side: OrderSide, qty: number, price: number): void {
    const problem = this.fundsProblem(symbol, side, qty, price)
    if (problem) throw new Error(problem)
  }

  private fill(order: SimOrder, qty: number, price: number): void {
    const now = this.now()
    order.qty = qty
    order.filledQty = qty
    order.filledAvgPrice = price
    order.status = 'filled'
    order.filledAt = now
    const amount = qty * price
    const holding = this.state.positions[order.symbol] ?? { qty: 0, avgPrice: 0, lastPrice: price }
    if (order.side === 'buy') {
      this.state.cash = roundMoney(this.state.cash - amount)
      const total = roundQty(holding.qty + qty)
      holding.avgPrice = roundPrice((holding.qty * holding.avgPrice + amount) / total)
      holding.qty = total
      holding.lastPrice = price
      this.state.positions[order.symbol] = holding
    } else {
      this.state.cash = roundMoney(this.state.cash + amount)
      holding.qty = roundQty(holding.qty - qty)
      holding.lastPrice = price
      if (holding.qty <= EPSILON) delete this.state.positions[order.symbol]
      else this.state.positions[order.symbol] = holding
    }
  }

  private remember(symbol: string, price: number): void {
    const holding = this.state.positions[symbol]
    if (holding) holding.lastPrice = price
  }

  /** Current prices for every holding; a failed quote falls back to the last price seen. */
  private async marks(): Promise<Map<string, { price: number; dayChangePct: number | null }>> {
    const marks = new Map<string, { price: number; dayChangePct: number | null }>()
    await Promise.all(
      Object.entries(this.state.positions).map(async ([symbol, holding]) => {
        try {
          const quote = await this.deps.prices.quote(symbol)
          holding.lastPrice = quote.price
          marks.set(symbol, { price: quote.price, dayChangePct: quote.changePct })
        } catch {
          marks.set(symbol, { price: holding.lastPrice ?? holding.avgPrice, dayChangePct: null })
        }
      })
    )
    return marks
  }

  /** On the first look of a new New York date, yesterday's last equity becomes `lastEquity`. */
  private rollDay(equity: number): void {
    const today = marketDate(this.now())
    let changed = false
    if (this.state.day !== today) {
      if (this.state.day !== null) this.state.lastEquity = this.state.lastSeenEquity
      this.state.day = today
      changed = true
    }
    if (this.state.lastSeenEquity !== equity) {
      this.state.lastSeenEquity = equity
      changed = true
    }
    if (changed) this.save()
  }

  private trim(): void {
    if (this.state.orders.length <= MAX_ORDERS) return
    const keep: SimOrder[] = []
    let spare = MAX_ORDERS
    for (const o of this.state.orders) {
      if (o.status === 'open' || spare > 0) {
        keep.push(o)
        spare--
      }
    }
    this.state.orders = keep
  }

  private save(): void {
    this.deps.save(structuredClone(this.state))
  }
}

function plain(order: SimOrder): BrokerOrder {
  const { expiresAt: _expires, ...rest } = order
  return { ...rest }
}
