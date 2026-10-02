import type { BrokerKind, EquityPoint, OrderSide, OrderStatus, OrderType } from '@shared/trading'

/**
 * The one interface every broker speaks — the local simulator and Alpaca
 * (paper and live) — so the engine places orders, reads the account and
 * applies its guardrails the same way whichever is selected.
 *
 * Brokers only report facts. Who placed an order and why, the realized P&L,
 * the equity curve and the guardrails are the engine's; an order is tied back
 * to that bookkeeping through its client order id (`eaon-<uuid>`).
 */

export interface BrokerAccount {
  equity: number
  cash: number
  buyingPower: number
  /** Equity at the end of the previous trading day. */
  lastEquity: number
  /** The broker's account status (Alpaca: ACTIVE, ACCOUNT_UPDATED…). */
  status: string
  /** The broker won't accept orders on this account at all. */
  blocked: boolean
}

export interface BrokerPosition {
  symbol: string
  /** Negative for a short position (only possible at Alpaca, opened outside Eaon). */
  qty: number
  avgPrice: number
  price: number
  marketValue: number
  unrealizedPl: number
  /** Today's move of the stock, in percent, when known. */
  dayChangePct: number | null
}

export interface BrokerOrder {
  /** The broker's own id; what `cancel` takes. */
  id: string
  /** The id Eaon gave it (`eaon-<uuid>`), or whatever placed it elsewhere. */
  clientOrderId: string | null
  symbol: string
  side: OrderSide
  type: OrderType
  /** Shares asked for; for an order sized in dollars, what filled (0 until then). */
  qty: number
  notional: number | null
  limitPrice: number | null
  status: OrderStatus
  filledQty: number
  filledAvgPrice: number | null
  submittedAt: number
  filledAt: number | null
  /** Why the broker refused or canceled it, when it says. */
  error: string | null
}

export interface BrokerClock {
  isOpen: boolean
  nextOpen: number | null
  nextClose: number | null
}

export interface SubmitOrder {
  symbol: string
  side: OrderSide
  type: OrderType
  /** Shares; give this or `notional`. */
  qty?: number
  /** Dollars, for a market order. */
  notional?: number
  limitPrice?: number
  clientOrderId: string
}

export interface Broker {
  readonly kind: BrokerKind
  account(): Promise<BrokerAccount>
  positions(): Promise<BrokerPosition[]>
  /** Newest first. */
  orders(limit: number): Promise<BrokerOrder[]>
  /** Resolves with the order as the broker accepted it (possibly already filled); throws a sentence when refused. */
  submit(order: SubmitOrder): Promise<BrokerOrder>
  cancel(id: string): Promise<void>
  clock(): Promise<BrokerClock>
  /** The simulator only: fill or expire open limit orders against the latest prices. */
  settle?(): Promise<void>
  /** Earlier equity, to start the desk's chart with something (Alpaca's portfolio history). */
  history?(): Promise<EquityPoint[]>
}

/** Alpaca's keys for one account. Never logged, never sent to the renderer. */
export interface AlpacaKeys {
  keyId: string
  secret: string
}

export const roundQty = (qty: number): number => Math.round(qty * 10_000) / 10_000
export const roundMoney = (value: number): number => Math.round(value * 100) / 100
export const roundPrice = (value: number): number => Math.round(value * 10_000) / 10_000
