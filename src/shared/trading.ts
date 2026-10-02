/**
 * Agentic trading: an agent that trades US stocks for the user, inside limits
 * the user sets, on a schedule the user picks — with a desk in the ADE that
 * shows the money, the trades and the statistics.
 *
 * Three brokers. The **simulator** is the default: a local virtual account
 * priced with real market quotes, so anyone can try it with no account and
 * no risk. **Alpaca paper** is a real broker's practice account. **Alpaca
 * live** is real money, and only works once the user has typed a
 * confirmation; every order — the agent's or the user's — goes through the
 * same guardrails (`TradingLimits`) first.
 *
 * Main owns trading (`features/trading/`); the renderer shows snapshots and
 * sends commands. Alpaca keys live in the secrets vault and never reach the
 * renderer.
 */

export type BrokerKind = 'simulator' | 'alpaca-paper' | 'alpaca-live'

export const BROKERS: { id: BrokerKind; label: string; description: string; real: boolean }[] = [
  {
    id: 'simulator',
    label: 'Simulator',
    description: 'Practice money in a local account, priced with real market quotes. No account needed and nothing is at risk.',
    real: false
  },
  {
    id: 'alpaca-paper',
    label: 'Alpaca paper',
    description: 'A practice account at Alpaca, a real broker: real order handling, pretend money. Free with an Alpaca account.',
    real: false
  },
  {
    id: 'alpaca-live',
    label: 'Alpaca live',
    description: 'Real money in your Alpaca brokerage account. You can lose money. Every order still has to pass your limits.',
    real: true
  }
]

/** Guardrails every order must pass, whoever places it. */
export interface TradingLimits {
  /** The largest single order, in dollars. */
  maxOrderUsd: number
  /** The largest holding in one stock, as a percentage of equity. */
  maxPositionPct: number
  /** Stop buying for the rest of the day once equity is down this much from the day's start, in percent. Selling stays allowed. */
  maxDailyLossPct: number
  maxOrdersPerDay: number
  /** At most this share of equity invested at once, in percent; the rest stays cash. */
  maxInvestedPct: number
  /** Only these symbols, upper case. Empty means any US stock or ETF. */
  allowedSymbols: string[]
}

export const DEFAULT_LIMITS: TradingLimits = {
  maxOrderUsd: 2_000,
  maxPositionPct: 20,
  maxDailyLossPct: 3,
  maxOrdersPerDay: 30,
  maxInvestedPct: 80,
  allowedSymbols: []
}

export interface TradingConfig {
  broker: BrokerKind
  limits: TradingLimits
  /** What the simulator starts with, and goes back to on reset. */
  simulatorCash: number
  /** Let the simulator fill orders outside market hours, at the last price — for practice. */
  simulatorAnytime: boolean
  /** When the user confirmed real-money trading. Alpaca live refuses every order until it is set. */
  liveConfirmedAt: number | null
  /** The model trading sessions run on; null follows the app's selected model. */
  model: { providerId: string; modelId: string } | null
  /** The kill switch: no orders at all and no sessions, until switched off. */
  halted: boolean
}

export interface TradingAccount {
  broker: BrokerKind
  equity: number
  cash: number
  buyingPower: number
  /** Equity at the end of the previous trading day — today's change is measured from it. */
  lastEquity: number
  /** Equity when this account started being tracked (or the simulator was reset). */
  startingEquity: number
  marketOpen: boolean
  nextOpen: number | null
  nextClose: number | null
  updatedAt: number
}

export interface TradingPosition {
  symbol: string
  qty: number
  avgPrice: number
  price: number
  marketValue: number
  unrealizedPl: number
  unrealizedPlPct: number
  /** Today's move of the stock itself, in percent, when known. */
  dayChangePct: number | null
  /** The protective exit watching this holding, if any. */
  exit: PositionExit | null
}

/**
 * A protective exit on a holding: Eaon sells it all at market when the price
 * falls to the stop (or the trailing stop) or rises to the target. Eaon
 * watches it, not the broker, so it works the same on every broker and with
 * fractional shares — and only while Eaon is running.
 */
export interface PositionExit {
  symbol: string
  /** Sell if the price falls to this. */
  stopPrice: number | null
  /** Sell if the price rises to this. */
  targetPrice: number | null
  /** Sell if the price falls this many percent below its highest since the exit was set. */
  trailPct: number | null
  /** The highest price seen since the exit was set; what the trailing stop hangs from. */
  highWater: number | null
  /** The stop in force right now: the higher of `stopPrice` and the trailing stop. */
  activeStop: number | null
  setAt: number
  setBy: 'user' | 'agent' | 'session'
  sessionId: string | null
}

export interface ExitRequest {
  symbol: string
  stopPrice?: number | null
  targetPrice?: number | null
  trailPct?: number | null
}

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'market' | 'limit'
export type OrderStatus = 'pending' | 'open' | 'filled' | 'partially_filled' | 'canceled' | 'rejected' | 'expired'

export interface TradingOrder {
  id: string
  symbol: string
  side: OrderSide
  type: OrderType
  qty: number
  limitPrice: number | null
  status: OrderStatus
  filledQty: number
  filledAvgPrice: number | null
  submittedAt: number
  filledAt: number | null
  /** The profit or loss a filled sell realised, matched first-in first-out against earlier buys. Null for buys. */
  realizedPl: number | null
  /** Who placed it: the user, the agent in a chat, or a trading session. */
  source: 'user' | 'agent' | 'session'
  sessionId: string | null
  /** Why, in the words of whoever placed it. */
  reason: string
  /** Why it was refused — a guardrail, or the broker. */
  error: string | null
}

export interface EquityPoint {
  at: number
  equity: number
}

export interface TradingStats {
  totalReturn: number
  totalReturnPct: number
  todayReturn: number
  todayReturnPct: number
  realizedPl: number
  unrealizedPl: number
  /** Closed trades: filled sells, each matched against the buys it closed. */
  trades: number
  wins: number
  losses: number
  /** 0–1; 0 when there are no closed trades. */
  winRate: number
  avgWin: number
  avgLoss: number
  /** Gross profit / gross loss; null with no losing trade yet. */
  profitFactor: number | null
  /** Deepest fall from a peak of the equity curve, in percent (a positive number). */
  maxDrawdownPct: number
  /** Annualised, from daily returns; null with fewer than five days of history. */
  sharpe: number | null
  bestTrade: number | null
  worstTrade: number | null
  /** Share of equity in stocks right now, in percent. */
  investedPct: number
  ordersToday: number
}

/** A window the trading agent works in, repeating on the chosen days. Times are the user's local clock. */
export interface TradingSchedule {
  id: string
  name: string
  /** 0 = Sunday … 6 = Saturday. */
  days: number[]
  /** "HH:MM", local time. */
  start: string
  end: string
  /** The strategy, in the user's words. */
  strategy: string
  /** How often the agent looks at the market and decides, in minutes. */
  everyMinutes: number
  /** Sell everything when the window closes. */
  flattenAtEnd: boolean
  enabled: boolean
  createdAt: number
}

export type TradingScheduleDraft = Omit<TradingSchedule, 'id' | 'createdAt'> & { id?: string }

export type SessionStatus = 'running' | 'done' | 'stopped' | 'failed'

export interface TradingLogEntry {
  at: number
  kind: 'decision' | 'order' | 'note' | 'error'
  text: string
}

/** One stretch of the agent trading: from a schedule's window, or started by hand or by the agent. */
export interface TradingSession {
  id: string
  scheduleId: string | null
  /** Shown in lists: the schedule's name, or the start of the strategy. */
  name: string
  strategy: string
  startedAt: number
  endsAt: number
  endedAt: number | null
  status: SessionStatus
  everyMinutes: number
  flattenAtEnd: boolean
  startEquity: number
  endEquity: number | null
  orders: number
  /** How many times the agent has looked at the market and decided. */
  checks: number
  /** Newest last, at most 200. */
  log: TradingLogEntry[]
  summary: string | null
  error: string | null
  /** SPY at the start and the end, so the result can be compared with simply holding the market. */
  benchmark?: { symbol: string; start: number; end: number | null } | null
}

export interface StartSessionRequest {
  strategy: string
  /** When to stop, as a timestamp. */
  until: number
  everyMinutes?: number
  flattenAtEnd?: boolean
  name?: string
}

export interface TradingSnapshot {
  config: TradingConfig
  /** Which Alpaca keys are saved. The keys themselves never leave main. */
  keys: { paper: boolean; live: boolean }
  account: TradingAccount | null
  positions: TradingPosition[]
  /** Newest first, at most 200. */
  orders: TradingOrder[]
  /** Oldest first. */
  equity: EquityPoint[]
  stats: TradingStats
  schedules: TradingSchedule[]
  /** Newest first, at most 50. */
  sessions: TradingSession[]
  activeSession: TradingSession | null
  /** The last problem talking to the broker or the price feed, if it hasn't recovered. */
  error: string | null
  /** Where prices come from, for the desk's footnote. */
  dataSource: string
}

export interface OrderRequest {
  symbol: string
  side: OrderSide
  /** Shares; give this or `notional`. */
  qty?: number
  /** Dollars, for a market order sized by money rather than shares. */
  notional?: number
  type?: OrderType
  limitPrice?: number
  reason: string
  /** Buys only: a protective exit set on the holding with the order. */
  stopLoss?: number
  takeProfit?: number
  trailPct?: number
}

export interface Quote {
  symbol: string
  name: string | null
  price: number
  change: number
  changePct: number
  prevClose: number
  dayHigh: number | null
  dayLow: number | null
  volume: number | null
  currency: string
  at: number
}

export interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export type BarRange = '1d' | '5d' | '1mo' | '6mo' | '1y'

/** Typed to confirm real-money trading. */
export const LIVE_CONFIRMATION = 'I understand this trades real money'

export const EMPTY_STATS: TradingStats = {
  totalReturn: 0,
  totalReturnPct: 0,
  todayReturn: 0,
  todayReturnPct: 0,
  realizedPl: 0,
  unrealizedPl: 0,
  trades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  avgWin: 0,
  avgLoss: 0,
  profitFactor: null,
  maxDrawdownPct: 0,
  sharpe: null,
  bestTrade: null,
  worstTrade: null,
  investedPct: 0,
  ordersToday: 0
}
