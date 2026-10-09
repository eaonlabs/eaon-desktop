import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, ModelInfo, Settings, StreamEvent, StreamRequest, TokenUsage } from '@shared/types'
import { clampEffort } from '@shared/effort'
import {
  BROKERS,
  DEFAULT_LIMITS,
  EMPTY_STATS,
  LIVE_CONFIRMATION,
  TRADING_DISCLAIMER_VERSION,
  type Bar,
  type BarRange,
  type BrokerKind,
  type EquityPoint,
  type ExitRequest,
  type OrderRequest,
  type OrderSide,
  type OrderType,
  type PositionExit,
  type Quote,
  type SessionDriver,
  type StartSessionRequest,
  type TradingAccount,
  type TradingConfig,
  type TradingLimits,
  type TradingLogEntry,
  type TradingOrder,
  type TradingPosition,
  type TradingSchedule,
  type TradingScheduleDraft,
  type TradingSession,
  type TradingSnapshot,
  type TradingStats
} from '@shared/trading'
import type { RunOptions, RunOutcome, ToolGate } from '../../agent/loop'
import { resolveModel as resolveAppModel, STALL_MS } from '../scheduler/runner'
import { AlpacaBroker, type AlpacaKind } from './alpaca'
import { roundMoney, roundPrice, roundQty, type AlpacaKeys, type Broker, type BrokerOrder } from './brokers'
import { formatMarketTime, marketDate, nextOpen, sessionOn } from './marketHours'
import { normalizeSymbol, type Headline, type PriceFeed, type ScreenKind, type ScreenRow } from './marketData'
import { SimulatorBroker, type SimState } from './simulator'

/**
 * The trading engine: everything about trading that isn't talking to a
 * broker or fetching a price.
 *
 * - **Guardrails.** Every order — the user's from the desk, the agent's from a
 *   chat, a session's — passes `checkLimits` first. A refusal is recorded as
 *   a `rejected` order with the reason, so the desk shows what was stopped.
 * - **The ledger.** Eaon's own record of orders (`trading-orders.json`): who
 *   placed each one and why, merged with the broker's view of it through the
 *   client order id, plus the realized P&L of every sell (first in, first
 *   out). Stats and the equity curve are worked out from it per broker.
 * - **Sessions.** A stretch of the agent trading on its own: every few
 *   minutes it runs one headless agent turn, like a worker's, held to the
 *   trading tools. One at a time; started by hand, by the agent, or by a
 *   schedule's window; it survives a restart.
 *
 * Storage, the brokers, prices, the model and the clock are injected so the
 * tests can drive all of it without Electron, a network or a model.
 */

export type RunAgent = (request: StreamRequest, emit: (event: StreamEvent) => void, options: RunOptions) => Promise<RunOutcome>
export type KeyKind = 'paper' | 'live'
export type OrderSource = TradingOrder['source']
/** What the desk may change; `liveConfirmedAt` only through `confirmLive`. */
export type TradingConfigPatch = Partial<Omit<TradingConfig, 'limits' | 'liveConfirmedAt' | 'disclaimer'>> & { limits?: Partial<TradingLimits> }

/** A ledger entry: the order as the desk shows it, plus how to find it at the broker. */
export interface StoredOrder extends TradingOrder {
  broker: BrokerKind
  /** The broker's id; null when it never reached the broker (refused by a guardrail or by the broker). */
  brokerOrderId: string | null
  clientOrderId: string | null
  notional: number | null
}

interface EquityTrack {
  /** Equity when tracking began (the simulator: its starting cash). */
  start: number | null
  /** Oldest first. */
  points: EquityPoint[]
  /** Alpaca's own history has been asked for once already. */
  seeded?: boolean
}
type EquityBook = Partial<Record<BrokerKind, EquityTrack>>
/** Protective exits per broker, by symbol. */
export type ExitBook = Partial<Record<BrokerKind, Record<string, PositionExit>>>

type Resolved = { ok: true; providerId: string; modelId: string; model: ModelInfo | undefined } | { ok: false; error: string }

export interface TradingDeps {
  prices: PriceFeed
  runAgent: RunAgent
  getSettings: () => Settings
  getKeys: (kind: KeyKind) => AlpacaKeys | null
  saveKeys: (kind: KeyKind, keys: AlpacaKeys | null) => void
  loadConfig: () => unknown
  saveConfig: (config: TradingConfig) => void
  loadOrders: () => unknown
  saveOrders: (orders: StoredOrder[]) => void
  loadEquity: () => unknown
  saveEquity: (equity: EquityBook) => void
  loadSchedules: () => unknown
  saveSchedules: (schedules: TradingSchedule[]) => void
  loadSessions: () => unknown
  saveSessions: (sessions: TradingSession[]) => void
  loadSim: () => unknown
  saveSim: (state: SimState) => void
  /** Protective exits. Optional, so callers that never set one need not store them. */
  loadExits?: () => unknown
  saveExits?: (exits: ExitBook) => void
  /** Something the desk shows changed. Cheap and frequent; the feature throttles what it sends. */
  onChange?: () => void
  /** Every stream event of a session's checks (tool calls, reasoning, text), for a screen that shows the agent at work. */
  onAgentEvent?: (sessionId: string, event: StreamEvent) => void
  now?: () => number
  /** Makes an Alpaca client; tests point it at a fake server. */
  createBroker?: (kind: AlpacaKind, keys: AlpacaKeys) => Broker
  /** The model sessions run on; defaults to the scheduler's resolution against the app's providers. */
  resolveModel?: (target: { model: TradingConfig['model'] }, settings: Settings) => Resolved
  /** Where a session's agent works: `<Work folder>/Trading` by default. */
  workFolder?: () => string
  /** How long a session's "minute" is, in ms; tests shrink it. */
  minuteMs?: number
  stallMs?: number
  refreshFastMs?: number
  refreshSlowMs?: number
  /** How often prices are checked while an exit could fire; 15 s by default. */
  exitRefreshMs?: number
  scheduleTickMs?: number
  /**
   * Orders and sessions wait for the user to accept the trading disclaimer
   * (`acceptDisclaimer`). The CLI asks for it; the desktop doesn't set this.
   */
  requireDisclaimer?: () => boolean
  /** How often a session's prices are watched between checks; 15 s by default. */
  watchMs?: number
  /** The least time between a check and an early one woken by a price alert; 60 s by default. */
  alertGapMs?: number
}

/* ------------------------------------------------------------------ limits */

const MAX_ORDERS_KEPT = 5000
const ORDERS_SHOWN = 200
const MAX_SESSIONS = 50
const MAX_LOG = 200
/** What a summary (`TradingEngine.summary`) keeps of the history only the desk draws whole. */
const BRIEF_EQUITY_POINTS = 200
const BRIEF_ORDERS = 20
const BRIEF_LOG = 10
const MAX_SCHEDULES = 20
const MAX_EQUITY_POINTS = 5000
const MAX_SESSION_DAYS = 7
/** Turns of the session's own conversation the model is shown again. */
const THREAD_TURNS = 6
/** Consecutive failed checks before a session gives up rather than failing forever. */
const MAX_FAILURES = 3
/** A schedule whose session couldn't start tries again this often while its window lasts. */
const SCHEDULE_RETRY_MS = 5 * 60_000
const DESK_SEEN_MS = 2 * 60_000
const EQUITY_SAVE_DELAY_MS = 30_000
const END_WAIT_MS = 10_000
/** Tools a session may use besides its own trading tools. */
const SESSION_EXTRA_TOOLS = new Set(['web_search', 'web_fetch', 'update_plan'])
/** What a session is compared against, and what each check shows of the market. */
const BENCHMARK = 'SPY'
const MARKET_INDEXES = ['SPY', 'QQQ']
/** A slow quote doesn't hold up a check; the line is left out instead. */
const CONTEXT_TIMEOUT_MS = 4000
/** Moves since the last check that wake the agent early: a holding, a watched ticker, the market. */
const ALERT_HOLDING_PCT = 1.5
const ALERT_WATCHED_PCT = 2.5
const ALERT_MARKET_PCT = 0.75
/** A holding this close to its stop wakes the agent too. */
const ALERT_STOP_PCT = 0.5
const DISCLAIMER_REFUSAL = 'Trading hasn’t been switched on yet: accept the trading disclaimer first (on the trading desk, press G or open Setup). Until then no order can be placed and no session can start.'
export const TRADING_CHAT_PREFIX = 'trading:'
const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const OPEN_STATUSES = new Set<TradingOrder['status']>(['pending', 'open', 'partially_filled'])

/* ----------------------------------------------------------------- helpers */

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const finite = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
}
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const clone = <T>(value: T): T => structuredClone(value)

export const money = (value: number): string =>
  `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const signedMoney = (value: number): string => (value > 0 ? `+${money(value)}` : money(value))
export const signedPct = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
const shares = (qty: number): string => `${Number(qty.toFixed(4))}`

export function brokerLabel(kind: BrokerKind): string {
  return BROKERS.find((b) => b.id === kind)?.label ?? kind
}

/** "2h 05m", "45m", "under a minute". */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.round(hours / 24)} days`
}

const localTime = (at: number): string => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

function startOfLocalDay(at: number): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** "Buy 5 AAPL", "Sell $500 of AAPL", "Buy 5 AAPL at $185.00 limit". */
export function describeOrder(order: { side: unknown; symbol: unknown; qty?: unknown; notional?: unknown; type?: unknown; limitPrice?: unknown }): string {
  const side = order.side === 'sell' ? 'Sell' : 'Buy'
  const symbol = str(order.symbol).toUpperCase() || '?'
  const qty = finite(order.qty)
  const notional = finite(order.notional)
  const size = qty !== undefined && qty > 0 ? `${shares(qty)} ${symbol}` : notional !== undefined ? `${money(notional)} of ${symbol}` : symbol
  const limit = finite(order.limitPrice)
  return `${side} ${size}${order.type === 'limit' && limit !== undefined ? ` at ${money(limit)} limit` : ''}`
}

/** One line on what became of an order, for a tool result or a session's log. */
export function orderOutcome(order: TradingOrder & { notional?: number | null }): string {
  const what = describeOrder(order)
  if (order.status === 'rejected') return `Refused: ${what} — ${order.error ?? 'no reason given'}`
  if (order.status === 'filled' || order.status === 'partially_filled') {
    const price = order.filledAvgPrice ?? 0
    const verb = order.side === 'buy' ? 'Bought' : 'Sold'
    const part = order.status === 'partially_filled' ? ` (so far, of ${shares(order.qty)})` : ''
    const pl = order.realizedPl !== null ? `, realized ${signedMoney(order.realizedPl)}` : ''
    return `${verb} ${shares(order.filledQty)} ${order.symbol} at ${money(price)} (${money(order.filledQty * price)})${part}${pl}.`
  }
  if (order.status === 'canceled' || order.status === 'expired') return `${what}: ${order.status}${order.error ? ` — ${order.error}` : ''}.`
  return `Placed: ${what}. It stays open until it fills, you cancel it, or the day ends.`
}

/* ------------------------------------------------------------- normalising */

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = finite(value)
  return n === undefined ? fallback : Math.min(max, Math.max(min, n))
}

/** Limits from a file or a patch. `strict` (a patch from the user) throws on a bad symbol rather than dropping it. */
export function normalizeLimits(raw: unknown, base: TradingLimits = DEFAULT_LIMITS, strict = false): TradingLimits {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof TradingLimits, unknown>>
  const symbols: string[] = []
  const list = Array.isArray(v.allowedSymbols) ? v.allowedSymbols : base.allowedSymbols
  for (const item of list) {
    if (typeof item === 'string' && !item.trim()) continue
    try {
      const symbol = normalizeSymbol(item)
      if (!symbols.includes(symbol)) symbols.push(symbol)
    } catch (error) {
      if (strict) throw error
    }
  }
  return {
    maxOrderUsd: clampNumber(v.maxOrderUsd, 1, 10_000_000, base.maxOrderUsd),
    maxPositionPct: clampNumber(v.maxPositionPct, 1, 100, base.maxPositionPct),
    maxDailyLossPct: clampNumber(v.maxDailyLossPct, 0.1, 100, base.maxDailyLossPct),
    maxOrdersPerDay: Math.round(clampNumber(v.maxOrdersPerDay, 1, 1000, base.maxOrdersPerDay)),
    maxInvestedPct: clampNumber(v.maxInvestedPct, 1, 100, base.maxInvestedPct),
    allowedSymbols: symbols
  }
}

const BROKER_IDS = BROKERS.map((b) => b.id)
const SIM_CASH_MIN = 100
const SIM_CASH_MAX = 100_000_000

export function defaultConfig(): TradingConfig {
  return { broker: 'simulator', limits: { ...DEFAULT_LIMITS, allowedSymbols: [] }, simulatorCash: 100_000, simulatorAnytime: false, liveConfirmedAt: null, model: null, halted: false }
}

function normalizeModel(raw: unknown): TradingConfig['model'] {
  const v = raw as { providerId?: unknown; modelId?: unknown } | null
  return v && typeof v.providerId === 'string' && v.providerId && typeof v.modelId === 'string' && v.modelId ? { providerId: v.providerId, modelId: v.modelId } : null
}

export function normalizeConfig(raw: unknown): TradingConfig {
  const base = defaultConfig()
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof TradingConfig, unknown>>
  return {
    broker: BROKER_IDS.includes(v.broker as BrokerKind) ? (v.broker as BrokerKind) : base.broker,
    limits: normalizeLimits(v.limits, base.limits),
    simulatorCash: clampNumber(v.simulatorCash, SIM_CASH_MIN, SIM_CASH_MAX, base.simulatorCash),
    simulatorAnytime: v.simulatorAnytime === true,
    liveConfirmedAt: typeof v.liveConfirmedAt === 'number' ? v.liveConfirmedAt : null,
    model: normalizeModel(v.model),
    halted: v.halted === true,
    disclaimer: normalizeDisclaimer(v.disclaimer)
  }
}

function normalizeDisclaimer(raw: unknown): TradingConfig['disclaimer'] {
  const v = raw as { version?: unknown; acceptedAt?: unknown } | null
  return v && typeof v.version === 'number' && typeof v.acceptedAt === 'number' ? { version: v.version, acceptedAt: v.acceptedAt } : null
}

const DAYS = new Set([0, 1, 2, 3, 4, 5, 6])
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/

function clockText(value: unknown): string | null {
  const match = CLOCK.exec(str(value))
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null
}

const everyMinutesOf = (value: unknown): number => Math.round(clampNumber(value, 1, 240, 5))

/** A strategy's first words, for a session or schedule with no name. */
function nameFrom(strategy: string): string {
  const words = strategy.replace(/\s+/g, ' ').trim()
  return words.length <= 40 ? words : `${words.slice(0, 39).trimEnd()}…`
}

function normalizeSchedule(raw: unknown, now: number): TradingSchedule | null {
  const v = raw as Partial<TradingSchedule> | null
  if (!v || typeof v.id !== 'string') return null
  const start = clockText(v.start)
  const end = clockText(v.end)
  const strategy = str(v.strategy)
  const days = Array.isArray(v.days) ? [...new Set(v.days.filter((d) => DAYS.has(d)))].sort() : []
  if (!start || !end || !strategy || days.length === 0) return null
  return {
    id: v.id,
    name: str(v.name) || nameFrom(strategy),
    days,
    start,
    end,
    strategy,
    everyMinutes: everyMinutesOf(v.everyMinutes),
    flattenAtEnd: v.flattenAtEnd === true,
    enabled: v.enabled !== false,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : now,
    ...(v.marketHours === true ? { marketHours: true } : {}),
    ...(v.driver === 'claude-code' ? { driver: 'claude-code' as const } : {})
  }
}

const SESSION_STATUSES = new Set(['running', 'done', 'stopped', 'failed'])

function normalizeSession(raw: unknown): TradingSession | null {
  const v = raw as Partial<TradingSession> | null
  if (!v || typeof v.id !== 'string' || typeof v.startedAt !== 'number' || typeof v.endsAt !== 'number') return null
  return {
    id: v.id,
    scheduleId: typeof v.scheduleId === 'string' ? v.scheduleId : null,
    name: str(v.name) || 'Trading session',
    strategy: str(v.strategy),
    startedAt: v.startedAt,
    endsAt: v.endsAt,
    endedAt: typeof v.endedAt === 'number' ? v.endedAt : null,
    status: SESSION_STATUSES.has(v.status as string) ? (v.status as TradingSession['status']) : 'done',
    everyMinutes: everyMinutesOf(v.everyMinutes),
    flattenAtEnd: v.flattenAtEnd === true,
    startEquity: finite(v.startEquity) ?? 0,
    endEquity: finite(v.endEquity) ?? null,
    orders: finite(v.orders) ?? 0,
    checks: finite(v.checks) ?? 0,
    log: Array.isArray(v.log) ? v.log.filter((e) => e && typeof e.text === 'string' && typeof e.at === 'number').slice(-MAX_LOG) : [],
    summary: typeof v.summary === 'string' ? v.summary : null,
    error: typeof v.error === 'string' ? v.error : null,
    benchmark:
      v.benchmark && typeof v.benchmark.symbol === 'string' && finite(v.benchmark.start) !== undefined
        ? { symbol: v.benchmark.symbol, start: finite(v.benchmark.start)!, end: finite(v.benchmark.end) ?? null }
        : null,
    ...(v.driver === 'claude-code' ? { driver: 'claude-code' as const } : {})
  }
}

function normalizeOrder(raw: unknown): StoredOrder | null {
  const v = raw as Partial<StoredOrder> | null
  if (!v || typeof v.id !== 'string' || typeof v.symbol !== 'string' || !BROKER_IDS.includes(v.broker as BrokerKind)) return null
  return {
    id: v.id,
    broker: v.broker as BrokerKind,
    brokerOrderId: typeof v.brokerOrderId === 'string' ? v.brokerOrderId : null,
    clientOrderId: typeof v.clientOrderId === 'string' ? v.clientOrderId : null,
    symbol: v.symbol,
    side: v.side === 'sell' ? 'sell' : 'buy',
    type: v.type === 'limit' ? 'limit' : 'market',
    qty: finite(v.qty) ?? 0,
    notional: finite(v.notional) ?? null,
    limitPrice: finite(v.limitPrice) ?? null,
    status: (v.status as TradingOrder['status']) ?? 'rejected',
    filledQty: finite(v.filledQty) ?? 0,
    filledAvgPrice: finite(v.filledAvgPrice) ?? null,
    submittedAt: finite(v.submittedAt) ?? 0,
    filledAt: finite(v.filledAt) ?? null,
    realizedPl: finite(v.realizedPl) ?? null,
    source: v.source === 'agent' || v.source === 'session' ? v.source : 'user',
    sessionId: typeof v.sessionId === 'string' ? v.sessionId : null,
    reason: typeof v.reason === 'string' ? v.reason : '',
    error: typeof v.error === 'string' ? v.error : null
  }
}

function normalizeEquity(raw: unknown): EquityBook {
  const book: EquityBook = {}
  if (!raw || typeof raw !== 'object') return book
  for (const kind of BROKER_IDS) {
    const track = (raw as Record<string, unknown>)[kind] as Partial<EquityTrack> | undefined
    if (!track || !Array.isArray(track.points)) continue
    book[kind] = {
      start: finite(track.start) ?? null,
      points: track.points.filter((p) => p && typeof p.at === 'number' && typeof p.equity === 'number'),
      ...(track.seeded ? { seeded: true } : {})
    }
  }
  return book
}

function toPublic(order: StoredOrder): TradingOrder {
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    qty: order.qty,
    limitPrice: order.limitPrice,
    status: order.status,
    filledQty: order.filledQty,
    filledAvgPrice: order.filledAvgPrice,
    submittedAt: order.submittedAt,
    filledAt: order.filledAt,
    realizedPl: order.realizedPl,
    source: order.source,
    sessionId: order.sessionId,
    reason: order.reason,
    error: order.error
  }
}

/* --------------------------------------------------------------- the order */

export interface ParsedOrder {
  symbol: string
  side: OrderSide
  type: OrderType
  qty: number | null
  notional: number | null
  limitPrice: number | null
  reason: string
}

/** An order request checked for shape. Throws a sentence for anything that can't be an order at all. */
export function parseOrderRequest(request: Partial<OrderRequest> | Record<string, unknown>): ParsedOrder {
  const r = request as Record<string, unknown>
  const symbol = normalizeSymbol(r.symbol)
  const side = r.side === 'buy' || r.side === 'sell' ? r.side : null
  if (!side) throw new Error('Say whether to buy or sell.')
  const limitPrice = finite(r.limitPrice ?? r.limit_price)
  const type: OrderType = r.type === 'limit' || r.type === 'market' ? r.type : limitPrice !== undefined ? 'limit' : 'market'
  const qtyRaw = finite(r.qty)
  const notionalRaw = finite(r.notional)
  if (qtyRaw !== undefined && notionalRaw !== undefined) throw new Error('Give either a number of shares (qty) or an amount in dollars (notional), not both.')
  if (qtyRaw === undefined && notionalRaw === undefined) throw new Error('Say how many shares (qty) or how many dollars (notional) to trade.')
  const qty = qtyRaw === undefined ? null : roundQty(qtyRaw)
  if (qty !== null && !(qty > 0)) throw new Error('The number of shares has to be above zero (fractions down to 0.0001 are fine).')
  const notional = notionalRaw === undefined ? null : roundMoney(notionalRaw)
  if (notional !== null && !(notional >= 1)) throw new Error('An order in dollars has to be at least $1.')
  if (notional !== null && type === 'limit') throw new Error('An order sized in dollars has to be a market order. Give a number of shares for a limit order.')
  if (type === 'limit' && !(limitPrice !== undefined && limitPrice > 0)) throw new Error('A limit order needs a limit price above zero.')
  return { symbol, side, type, qty, notional, limitPrice: type === 'limit' ? limitPrice! : null, reason: str(r.reason).slice(0, 1000) }
}

/* -------------------------------------------------------------- guardrails */

export interface LimitCheck {
  config: TradingConfig
  account: { equity: number; lastEquity: number }
  positions: { symbol: string; qty: number; marketValue: number }[]
  /** Orders that reached the broker today (local day). */
  ordersToday: number
  order: ParsedOrder
  /** The latest price of the stock. */
  price: number
  /** Selling everything at a session's end: only the kill switch and the no-shorting rule apply. */
  flatten?: boolean
}

/**
 * The guardrails that need no prices: the kill switch, real money not yet
 * confirmed, and the allow-list (which a session's final sell-off skips — it
 * only sells what is already held).
 */
export function checkSwitches(config: TradingConfig, symbol: string, flatten = false): string | null {
  if (config.halted) return 'Trading is halted: the kill switch is on. Nothing can be bought or sold until it is switched off on the trading desk.'
  if (config.broker === 'alpaca-live' && !config.liveConfirmedAt) {
    return 'Real-money trading isn’t confirmed yet. Confirm it on the trading desk (Alpaca live) before any order can go through.'
  }
  const allowed = config.limits.allowedSymbols
  if (!flatten && allowed.length > 0 && !allowed.includes(symbol)) {
    return `${symbol} isn’t on your list of allowed symbols (${allowed.join(', ')}). Add it in the trading limits to trade it.`
  }
  return null
}

/**
 * The guardrails, in the order they are checked. Null when the order may go
 * ahead; otherwise the reason, written for whoever placed it — the user on
 * the desk or the agent, which reads it as its tool result.
 */
export function checkLimits(c: LimitCheck): string | null {
  const { config, order, account } = c
  const limits = config.limits
  const switched = checkSwitches(config, order.symbol, c.flatten)
  if (switched) return switched
  const unit = order.type === 'limit' && order.limitPrice ? order.limitPrice : c.price
  const value = order.notional ?? (order.qty ?? 0) * unit
  const qty = order.qty ?? (c.price > 0 ? (order.notional ?? 0) / c.price : 0)
  const held = c.positions.find((p) => p.symbol === order.symbol)
  if (order.side === 'sell') {
    const have = held?.qty ?? 0
    if (qty > have + 1e-4) {
      return have > 0
        ? `You hold ${shares(have)} ${order.symbol}, so you can’t sell ${shares(qty)}. Short selling isn’t allowed.`
        : `You don’t hold any ${order.symbol}, and short selling isn’t allowed.`
    }
  }
  if (c.flatten) return null
  if (value > limits.maxOrderUsd + 0.005) {
    return `This order comes to about ${money(value)}, over your limit of ${money(limits.maxOrderUsd)} per order. Make it smaller${order.side === 'sell' ? ', or sell in parts' : ''}.`
  }
  if (c.ordersToday >= limits.maxOrdersPerDay) {
    return `${c.ordersToday} orders have gone in today, your daily limit of ${limits.maxOrdersPerDay}. No more orders until tomorrow.`
  }
  if (order.side === 'buy') {
    const equity = account.equity
    if (!(equity > 0)) return 'The account has no equity to buy with.'
    const floor = account.lastEquity * (1 - limits.maxDailyLossPct / 100)
    if (account.lastEquity > 0 && equity < floor) {
      const down = ((account.lastEquity - equity) / account.lastEquity) * 100
      return `Equity is down ${down.toFixed(2)}% today (${money(account.lastEquity)} → ${money(equity)}), past your ${limits.maxDailyLossPct}% daily loss limit, so buying is paused until tomorrow. Selling is still allowed.`
    }
    const holding = Math.max(0, held?.marketValue ?? 0)
    const positionPct = ((holding + value) / equity) * 100
    if (positionPct > limits.maxPositionPct + 1e-9) {
      const room = Math.max(0, (equity * limits.maxPositionPct) / 100 - holding)
      return `That would put ${money(holding + value)} in ${order.symbol}, ${positionPct.toFixed(1)}% of equity; your limit is ${limits.maxPositionPct}% per stock. You can add up to ${money(room)} more.`
    }
    const invested = c.positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0)
    const investedPct = ((invested + value) / equity) * 100
    if (investedPct > limits.maxInvestedPct + 1e-9) {
      const room = Math.max(0, (equity * limits.maxInvestedPct) / 100 - invested)
      return `That would put ${investedPct.toFixed(1)}% of equity in stocks; your limit is ${limits.maxInvestedPct}% invested. You can invest up to ${money(room)} more.`
    }
  }
  return null
}

/** The limits in one line, for the agent. */
export function describeLimits(limits: TradingLimits): string {
  const parts = [
    `at most ${money(limits.maxOrderUsd)} per order`,
    `at most ${limits.maxPositionPct}% of equity in one stock`,
    `at most ${limits.maxInvestedPct}% of equity invested`,
    `${limits.maxOrdersPerDay} orders a day`,
    `no buying after a ${limits.maxDailyLossPct}% loss on the day`,
    'no short selling'
  ]
  if (limits.allowedSymbols.length > 0) parts.push(`only ${limits.allowedSymbols.join(', ')}`)
  return parts.join('; ')
}

/* -------------------------------------------------------- protective exits */

const MIN_TRAIL_PCT = 0.5
const MAX_TRAIL_PCT = 50
/** A refused exit sale is tried again after this, not on every refresh. */
const EXIT_RETRY_MS = 5 * 60_000
/** An exit set with a buy waits this long for the holding to appear before it is dropped. */
const EXIT_GRACE_MS = 2 * 60_000

/** The stop in force: the fixed stop or the trailing one, whichever is higher. */
export function activeStop(exit: Pick<PositionExit, 'stopPrice' | 'trailPct' | 'highWater'>): number | null {
  const trail = exit.trailPct !== null && exit.highWater !== null ? roundPrice(exit.highWater * (1 - exit.trailPct / 100)) : null
  if (exit.stopPrice === null) return trail
  if (trail === null) return exit.stopPrice
  return Math.max(exit.stopPrice, trail)
}

/**
 * A new or changed exit, checked against the price now: a stop must be below
 * it and a target above it, or the exit would fire at once; a trail is
 * 0.5–50%. `undefined` keeps what is set, `null` clears it. Returns the exit,
 * null when nothing is left set, or a sentence saying what is wrong.
 */
export function buildExit(
  request: ExitRequest,
  price: number,
  current: PositionExit | undefined,
  by: PositionExit['setBy'],
  sessionId: string | null,
  now: number
): PositionExit | null | string {
  const pick = (value: number | null | undefined, kept: number | null | undefined): number | null =>
    value === undefined ? (kept ?? null) : value === null ? null : finite(value) ?? NaN
  const stopPrice = pick(request.stopPrice, current?.stopPrice)
  const targetPrice = pick(request.targetPrice, current?.targetPrice)
  const trailPct = pick(request.trailPct, current?.trailPct)
  const symbol = normalizeSymbol(request.symbol)
  if (stopPrice !== null && !(stopPrice > 0 && stopPrice < price)) {
    return `A stop-loss has to be below the price now (${symbol} is at ${money(price)}); ${Number.isNaN(stopPrice) ? 'that isn’t a price' : `${money(stopPrice)} would sell at once`}.`
  }
  if (targetPrice !== null && !(targetPrice > price)) {
    return `A take-profit has to be above the price now (${symbol} is at ${money(price)}); ${Number.isNaN(targetPrice) ? 'that isn’t a price' : `${money(targetPrice)} would sell at once`}.`
  }
  if (trailPct !== null && !(trailPct >= MIN_TRAIL_PCT && trailPct <= MAX_TRAIL_PCT)) {
    return `A trailing stop is a percentage between ${MIN_TRAIL_PCT} and ${MAX_TRAIL_PCT}.`
  }
  if (stopPrice === null && targetPrice === null && trailPct === null) return null
  // A trail set now hangs from the price now; one already running keeps its high.
  const highWater = trailPct === null ? null : Math.max(price, current?.trailPct !== null && current?.highWater ? current.highWater : price)
  const exit: PositionExit = {
    symbol,
    stopPrice: stopPrice === null ? null : roundPrice(stopPrice),
    targetPrice: targetPrice === null ? null : roundPrice(targetPrice),
    trailPct: trailPct === null ? null : Math.round(trailPct * 100) / 100,
    highWater,
    activeStop: null,
    setAt: now,
    setBy: by,
    sessionId
  }
  exit.activeStop = activeStop(exit)
  return exit
}

/** What an exit does at this price: nothing, or sell, and why. Raises the trailing high first. */
export function exitTrigger(exit: PositionExit, price: number): { kind: 'stop' | 'trail' | 'target'; level: number } | null {
  if (exit.trailPct !== null && price > (exit.highWater ?? 0)) exit.highWater = price
  exit.activeStop = activeStop(exit)
  if (exit.activeStop !== null && price <= exit.activeStop) {
    const trailing = exit.trailPct !== null && (exit.stopPrice === null || exit.activeStop > exit.stopPrice)
    return { kind: trailing ? 'trail' : 'stop', level: exit.activeStop }
  }
  if (exit.targetPrice !== null && price >= exit.targetPrice) return { kind: 'target', level: exit.targetPrice }
  return null
}

/** One exit in a few words, for the agent and the log. */
export function describeExit(exit: PositionExit): string {
  const parts: string[] = []
  if (exit.stopPrice !== null) parts.push(`stop ${money(exit.stopPrice)}`)
  if (exit.trailPct !== null) parts.push(`trailing ${exit.trailPct}% (stop now ${money(exit.activeStop ?? 0)})`)
  if (exit.targetPrice !== null) parts.push(`target ${money(exit.targetPrice)}`)
  return parts.join(', ')
}

function normalizeExits(raw: unknown): ExitBook {
  const book: ExitBook = {}
  if (!raw || typeof raw !== 'object') return book
  for (const [kind, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!BROKER_IDS.includes(kind as BrokerKind) || !entries || typeof entries !== 'object') continue
    const out: Record<string, PositionExit> = {}
    for (const value of Object.values(entries as Record<string, Partial<PositionExit>>)) {
      if (!value || typeof value.symbol !== 'string') continue
      const exit: PositionExit = {
        symbol: value.symbol,
        stopPrice: finite(value.stopPrice) ?? null,
        targetPrice: finite(value.targetPrice) ?? null,
        trailPct: finite(value.trailPct) ?? null,
        highWater: finite(value.highWater) ?? null,
        activeStop: null,
        setAt: finite(value.setAt) ?? 0,
        setBy: value.setBy === 'user' || value.setBy === 'session' ? value.setBy : 'agent',
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : null
      }
      exit.activeStop = activeStop(exit)
      if (exit.stopPrice !== null || exit.targetPrice !== null || exit.trailPct !== null) out[exit.symbol] = exit
    }
    book[kind as BrokerKind] = out
  }
  return book
}

/**
 * Tickers named in a strategy ("trade NVDA and AMD breakouts"), so each check
 * can show their prices without the agent asking. Words that look like
 * tickers but aren't are skipped; a wrong guess only costs a failed quote.
 */
const NOT_TICKERS = new Set(
  'A I AI AM PM US USA UK EU ETF ETFS IPO CEO CFO EPS PE P/E RSI SMA EMA ATR MACD VWAP GDP CPI FOMC FED SEC NYSE OTC YTD QOQ YOY ATH DD TP SL OK IF OR AND THE BUY SELL HOLD LONG SHORT TO OF IN ON AT BY FOR NOT NO DO MAX MIN API USD'.split(' ')
)
export function tickersIn(text: string, max = 8): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9$])\$?([A-Z]{1,5}(?:\.[A-Z])?)(?![A-Za-z0-9])/g)) {
    const ticker = match[1]
    if (NOT_TICKERS.has(ticker) || found.includes(ticker)) continue
    found.push(ticker)
    if (found.length >= max) break
  }
  return found
}

/* ---------------------------------------------------------- P&L and stats */

type Fill = Pick<TradingOrder, 'id' | 'symbol' | 'side' | 'filledQty' | 'filledAvgPrice' | 'filledAt' | 'submittedAt' | 'realizedPl'>

/**
 * Realized P&L, first in first out: every filled sell is matched against the
 * oldest shares bought before it that haven't been sold yet. Sets
 * `realizedPl` on each sell (null for buys, and for a sell with no recorded
 * buy behind it — shares bought before Eaon was watching). Returns whether
 * any value changed.
 */
export function realizeFifo(orders: Fill[]): boolean {
  // Oldest first; at the same instant a buy goes before a sell (nothing can be sold before it is bought).
  const fills = orders
    .filter((o) => o.filledQty > 0 && o.filledAvgPrice !== null)
    .sort(
      (a, b) =>
        (a.filledAt ?? a.submittedAt) - (b.filledAt ?? b.submittedAt) ||
        a.submittedAt - b.submittedAt ||
        (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1)
    )
  const lots = new Map<string, { qty: number; price: number }[]>()
  const results = new Map<string, number | null>()
  for (const fill of fills) {
    const queue = lots.get(fill.symbol) ?? []
    lots.set(fill.symbol, queue)
    if (fill.side === 'buy') {
      queue.push({ qty: fill.filledQty, price: fill.filledAvgPrice! })
      results.set(fill.id, null)
      continue
    }
    let left = fill.filledQty
    let matched = 0
    let pl = 0
    while (left > 1e-9 && queue.length > 0) {
      const lot = queue[0]
      const take = Math.min(lot.qty, left)
      pl += take * (fill.filledAvgPrice! - lot.price)
      matched += take
      left -= take
      lot.qty -= take
      if (lot.qty <= 1e-9) queue.shift()
    }
    results.set(fill.id, matched > 0 ? roundMoney(pl) : null)
  }
  let changed = false
  for (const order of orders) {
    const next = results.get(order.id) ?? null
    if (order.realizedPl !== next) {
      order.realizedPl = next
      changed = true
    }
  }
  return changed
}

/** At most `max` points of a curve, evenly spaced, from the first to the latest. */
export function thinCurve<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points
  if (max < 2) return max === 1 ? points.slice(-1) : []
  const step = (points.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)])
}

/** Deepest fall from a running peak, in percent (positive). */
export function maxDrawdownPct(points: EquityPoint[]): number {
  let peak = 0
  let worst = 0
  for (const p of points) {
    if (p.equity > peak) peak = p.equity
    else if (peak > 0) worst = Math.max(worst, ((peak - p.equity) / peak) * 100)
  }
  return Math.round(worst * 100) / 100
}

/**
 * Annualised Sharpe ratio (risk-free rate taken as zero) from daily returns:
 * each local day's last equity point is that day's close. Null with fewer
 * than five days, or when the returns never vary.
 */
export function sharpeRatio(points: EquityPoint[]): number | null {
  const closes = new Map<string, number>()
  for (const p of [...points].sort((a, b) => a.at - b.at)) {
    const d = new Date(p.at)
    closes.set(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`, p.equity)
  }
  const values = [...closes.values()]
  if (values.length < 5) return null
  const returns: number[] = []
  for (let i = 1; i < values.length; i++) if (values[i - 1] > 0) returns.push(values[i] / values[i - 1] - 1)
  if (returns.length < 2) return null
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1)
  const sd = Math.sqrt(variance)
  if (!(sd > 0)) return null
  return Math.round((mean / sd) * Math.sqrt(252) * 100) / 100
}

export interface StatsInput {
  /** This broker's orders, `realizedPl` already worked out. */
  orders: Pick<TradingOrder, 'side' | 'filledQty' | 'realizedPl'>[]
  equity: EquityPoint[]
  account: Pick<TradingAccount, 'equity' | 'lastEquity' | 'startingEquity'> | null
  positions: Pick<TradingPosition, 'marketValue' | 'unrealizedPl'>[]
  ordersToday: number
}

export function computeStats(input: StatsInput): TradingStats {
  const closed = input.orders.filter((o) => o.side === 'sell' && o.filledQty > 0 && o.realizedPl !== null).map((o) => o.realizedPl!)
  const wins = closed.filter((pl) => pl > 0)
  const losses = closed.filter((pl) => pl < 0)
  const grossProfit = wins.reduce((a, b) => a + b, 0)
  const grossLoss = losses.reduce((a, b) => a + b, 0)
  const account = input.account
  const equity = account?.equity ?? 0
  const invested = input.positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0)
  const start = account?.startingEquity ?? 0
  const last = account?.lastEquity ?? 0
  return {
    ...EMPTY_STATS,
    totalReturn: account ? roundMoney(equity - start) : 0,
    totalReturnPct: account && start > 0 ? Math.round(((equity - start) / start) * 10_000) / 100 : 0,
    todayReturn: account ? roundMoney(equity - last) : 0,
    todayReturnPct: account && last > 0 ? Math.round(((equity - last) / last) * 10_000) / 100 : 0,
    realizedPl: roundMoney(closed.reduce((a, b) => a + b, 0)),
    unrealizedPl: roundMoney(input.positions.reduce((a, p) => a + p.unrealizedPl, 0)),
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    avgWin: wins.length > 0 ? roundMoney(grossProfit / wins.length) : 0,
    // Negative, like the trades it averages.
    avgLoss: losses.length > 0 ? roundMoney(grossLoss / losses.length) : 0,
    profitFactor: losses.length > 0 ? Math.round((grossProfit / Math.abs(grossLoss)) * 100) / 100 : null,
    maxDrawdownPct: maxDrawdownPct(input.equity),
    sharpe: sharpeRatio(input.equity),
    bestTrade: closed.length > 0 ? Math.max(...closed) : null,
    worstTrade: closed.length > 0 ? Math.min(...closed) : null,
    investedPct: equity > 0 ? Math.round((invested / equity) * 10_000) / 100 : 0,
    ordersToday: input.ordersToday
  }
}

/* ---------------------------------------------------------------- sessions */

/** Whether a session's turn may use this tool: its own trading tools, web search and fetch, and its checklist. */
export const isSessionTool = (name: string): boolean => name.startsWith('trading_') || SESSION_EXTRA_TOOLS.has(name)

/** Refuses anything else outright; `isSessionTool` also keeps the rest out of the request. */
export const sessionToolGate: ToolGate = (tool) =>
  isSessionTool(tool.name)
    ? null
    : `A trading session can only use the trading tools, web search and web fetch, so ${tool.name} isn’t available here. Carry on with those.`

/** The session a chat id belongs to (`trading:<id>`), or null for any other chat. */
export function sessionIdOf(chatId: string): string | null {
  return chatId.startsWith(TRADING_CHAT_PREFIX) ? chatId.slice(TRADING_CHAT_PREFIX.length) : null
}

interface ActiveSession {
  session: TradingSession
  /** The session's own short conversation: the last few checks and what the agent said. */
  thread: ChatMessage[]
  turnTimer: ReturnType<typeof setTimeout> | null
  endTimer: ReturnType<typeof setTimeout> | null
  controller: AbortController | null
  running: Promise<void> | null
  closedNoted: boolean
  haltNoted: boolean
  failures: number
  /** The agent asked to stop from inside its own turn; done once the turn ends. */
  stopAfterTurn: boolean
  ending: boolean
  /** Eaon is quitting; the session stays `running` on disk and resumes at the next launch. */
  quitting: boolean
  /** When the check in progress started, and when the next one is due (while its timer is set). */
  turnStartedAt: number | null
  nextTurnAt: number | null
  /** Messages the user sent the agent, for its next check. */
  inbox: { at: number; text: string }[]
  /** What woke the agent early, for its next check. */
  alerts: string[]
  /** Prices when the last check began, and the newest the watch has seen. */
  basePrices: Map<string, number>
  latestPrices: Map<string, number>
  watchTimer: ReturnType<typeof setTimeout> | null
  lastWatchAt: number | null
  /** Claude Code sessions: its calls waiting for the next check, and when it last took one or waited. */
  waiters: Set<() => void>
  lastExternalAt: number | null
  /** The check Claude Code is on, for the feed's steps. */
  externalMessageId: string | null
}

/** A market-hours window ends this long before the bell, so the last orders and the sell-off fill. */
export const CLOSE_MARGIN_MS = 5 * 60_000

/** The window a schedule is in at `now` (it may have opened yesterday if it runs past midnight), or null. */
export function scheduleWindow(schedule: Pick<TradingSchedule, 'days' | 'start' | 'end' | 'marketHours'>, now: number): { start: number; end: number } | null {
  if (schedule.marketHours) {
    const session = sessionOn(marketDate(now))
    const end = session ? session.close - CLOSE_MARGIN_MS : 0
    return session && now >= session.open && now < end ? { start: session.open, end } : null
  }
  const at = (day: Date, clock: string, plusDays = 0): number => {
    const [h, m] = clock.split(':').map(Number)
    // The local Date constructor, never "+24 h": a day across a DST change is 23 or 25 hours.
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() + plusDays, h, m, 0, 0).getTime()
  }
  for (const back of [0, 1]) {
    const today = new Date(now)
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)
    if (!schedule.days.includes(day.getDay())) continue
    const start = at(day, schedule.start)
    let end = at(day, schedule.end)
    if (end <= start) end = at(day, schedule.end, 1)
    if (now >= start && now < end) return { start, end }
  }
  return null
}

/* ------------------------------------------------------------------ engine */

export class TradingEngine {
  private config: TradingConfig
  private orders: StoredOrder[] = []
  private equity: EquityBook = {}
  private exits: ExitBook = {}
  /** When a refused exit sale may be tried again, by `broker:symbol`. */
  private exitRetryAt = new Map<string, number>()
  private exitWork: Promise<void> | null = null
  private schedules: TradingSchedule[] = []
  private sessions: TradingSession[] = []
  private account: TradingAccount | null = null
  private positions: TradingPosition[] = []
  private error: string | null = null
  private readonly simulator: SimulatorBroker
  private readonly alpaca = new Map<AlpacaKind, Broker>()
  private keyState = { paper: false, live: false }
  private active: ActiveSession | null = null
  /** Claude Code's pending waits for a mission's next session, and when the last one returned. */
  private missionWaiters = 0
  private missionWaitedAt: number | null = null
  /** When each session's latest check began, for spacing early checks. */
  private lastTurnAt = new Map<string, number>()
  /** The quotes the latest check's market lines came from. */
  private contextQuotes: Quote[] = []
  private syncing: Promise<void> | null = null
  /**
   * Bumped when the account underneath changes wholesale (a simulator reset,
   * another broker): a refresh that started before must not write what it
   * read back into the new account's ledger.
   */
  private epoch = 0
  private syncQueued: Promise<void> | null = null
  private orderChain: Promise<unknown> = Promise.resolve()
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private scheduleTimer: ReturnType<typeof setInterval> | null = null
  private equitySaveTimer: ReturnType<typeof setTimeout> | null = null
  private scheduleTries = new Map<string, { windowStart: number; at: number; sessionId: string }>()
  private deskOpen = false
  private deskSeenAt = 0
  private started = false
  private disposed = false
  private readonly now: () => number
  private readonly minuteMs: number

  constructor(private readonly deps: TradingDeps) {
    this.now = deps.now ?? Date.now
    this.minuteMs = deps.minuteMs ?? 60_000
    this.config = normalizeConfig(deps.loadConfig())
    this.simulator = new SimulatorBroker({
      load: deps.loadSim,
      save: deps.saveSim,
      prices: deps.prices,
      now: this.now,
      anytime: () => this.config.simulatorAnytime,
      startingCash: () => this.config.simulatorCash
    })
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Reads everything from disk. A session still `running` in the file was cut
   * off by a quit or a crash: one whose end is still ahead picks up again
   * (once `start` arms the timers); one whose end passed is closed as done.
   */
  load(): void {
    const now = this.now()
    this.config = normalizeConfig(this.deps.loadConfig())
    const orders = this.deps.loadOrders()
    this.orders = (Array.isArray(orders) ? orders : []).map(normalizeOrder).filter((o): o is StoredOrder => o !== null)
    this.equity = normalizeEquity(this.deps.loadEquity())
    this.exits = normalizeExits(this.deps.loadExits?.())
    const schedules = this.deps.loadSchedules()
    this.schedules = (Array.isArray(schedules) ? schedules : []).map((s) => normalizeSchedule(s, now)).filter((s): s is TradingSchedule => s !== null)
    const sessions = this.deps.loadSessions()
    this.sessions = (Array.isArray(sessions) ? sessions : [])
      .map(normalizeSession)
      .filter((s): s is TradingSession => s !== null)
      .sort((a, b) => b.startedAt - a.startedAt)
    this.keyState = { paper: this.deps.getKeys('paper') !== null, live: this.deps.getKeys('live') !== null }

    let repaired = false
    for (const session of this.sessions) {
      if (session.status !== 'running') continue
      repaired = true
      if (!this.active && session.endsAt > now && !this.config.halted) {
        this.active = this.makeActive(session)
        this.log(session, 'note', 'Eaon restarted; the session carries on.', false)
        continue
      }
      session.status = this.config.halted ? 'stopped' : 'done'
      session.endedAt = Math.min(session.endsAt, now)
      session.summary =
        session.summary ??
        `Eaon was closed when this session was due to end, so it ended without a last check.${session.flattenAtEnd ? ' Its positions were not sold.' : ''}`
    }
    if (repaired) this.deps.saveSessions(this.sessions)
  }

  /** Arms the timers: refreshing the account, opening schedule windows, and a session that was running. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.scheduleTimer = setInterval(() => void this.tickSchedules(), this.deps.scheduleTickMs ?? 30_000)
    this.scheduleTimer.unref?.()
    if (this.active) this.armSession(this.active, this.minuteMs / 6)
    this.armRefresh(0)
    void this.tickSchedules()
  }

  /**
   * Quitting: every timer stops and a running turn is aborted. The session is
   * recorded as interrupted, not failed, and stays `running` on disk so the
   * next launch picks it up if its window hasn't ended.
   */
  stop(): void {
    this.disposed = true
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    this.refreshTimer = null
    this.scheduleTimer = null
    this.flushEquity()
    const active = this.active
    if (active) {
      this.clearSessionTimers(active)
      active.quitting = true
      if (active.running) {
        this.log(active.session, 'note', 'Interrupted when Eaon quit. The session picks up again when Eaon reopens, if it hasn’t ended by then.', false)
        active.controller?.abort()
      }
      this.deps.saveSessions(this.sessions)
    }
  }

  /** Settles once no turn, order or refresh is in flight. For tests and orderly shutdowns. */
  async whenIdle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const pending = [this.active?.running, this.orderChain, this.syncing, this.syncQueued, this.exitWork].filter(Boolean)
      if (pending.length === 0) return
      await Promise.all(pending.map((p) => p!.catch(() => undefined)))
    }
  }

  /** The desk is on screen: refresh every 30 s rather than every 5 minutes. */
  setDeskOpen(open: boolean): void {
    const was = this.fastRefresh()
    this.deskOpen = open
    if (open) this.deskSeenAt = this.now()
    if (this.started && !this.disposed && open && !was) this.armRefresh(0)
  }

  /** Someone looked at the desk (asked for a snapshot); keeps refreshes fast for a while. */
  touch(): void {
    const was = this.fastRefresh()
    this.deskSeenAt = this.now()
    if (this.started && !this.disposed && !was) this.armRefresh(0)
  }

  /* ------------------------------------------------------------- snapshot */

  getConfig(): TradingConfig {
    return clone(this.config)
  }

  /** The selected broker, without copying the whole config (tools ask on every call). */
  get brokerKind(): BrokerKind {
    return this.config.broker
  }

  activeSession(): TradingSession | null {
    return this.active ? clone(this.active.session) : null
  }

  /** Whether a desk is on screen (the app's or the CLI's), so the app knows whether to push it whole snapshots. */
  get deskShown(): boolean {
    return this.deskOpen
  }

  snapshot(): TradingSnapshot {
    return this.view(false)
  }

  /**
   * The snapshot with its history cut short — the equity curve thinned to a
   * sketch of itself, the latest orders, the latest few entries of each log —
   * for the pushes made while no desk is on screen. A running session
   * changes something many times a second, and a whole snapshot (up to 5,000
   * equity points and fifty sessions' logs) copied and sent each time, to
   * windows not showing it, kept the app busy. Everything a banner or a
   * status line reads is whole, stats included; a desk that opens is sent
   * the full snapshot.
   */
  summary(): TradingSnapshot {
    return this.view(true)
  }

  private view(brief: boolean): TradingSnapshot {
    const kind = this.config.broker
    const mine = this.orders.filter((o) => o.broker === kind)
    const equity = this.equity[kind]?.points ?? []
    const session = (s: TradingSession): TradingSession => clone(brief ? { ...s, log: s.log.slice(-BRIEF_LOG) } : s)
    return {
      config: clone(this.config),
      keys: { ...this.keyState },
      account: this.account && this.account.broker === kind ? { ...this.account } : null,
      positions: this.account?.broker === kind ? this.positions.map((p) => ({ ...p, exit: p.exit ? { ...p.exit } : null })) : [],
      orders: mine.slice(0, brief ? BRIEF_ORDERS : ORDERS_SHOWN).map(toPublic),
      equity: (brief ? thinCurve(equity, BRIEF_EQUITY_POINTS) : equity).map((p) => ({ ...p })),
      stats: computeStats({
        orders: mine,
        equity,
        account: this.account?.broker === kind ? this.account : null,
        positions: this.account?.broker === kind ? this.positions : [],
        ordersToday: this.ordersToday(kind)
      }),
      schedules: clone(this.schedules),
      sessions: this.sessions.slice(0, MAX_SESSIONS).map(session),
      activeSession: this.active ? session(this.active.session) : null,
      agent: this.active ? this.agentState(this.active) : null,
      ...(this.claudeWaiting() ? { claudeWaiting: true } : {}),
      needsDisclaimer: this.needsDisclaimer(),
      error: this.error,
      dataSource: this.deps.prices.source
    }
  }

  /** Pulls the account, positions and orders from the broker, settles the simulator's limit orders, records equity. */
  async refresh(): Promise<TradingSnapshot> {
    await this.sync()
    return this.snapshot()
  }

  /* --------------------------------------------------------------- config */

  async setConfig(patch: TradingConfigPatch): Promise<TradingSnapshot> {
    const p = (patch ?? {}) as Partial<Record<keyof TradingConfig, unknown>>
    const next = clone(this.config)
    if (p.broker !== undefined) {
      if (!BROKER_IDS.includes(p.broker as BrokerKind)) throw new Error(`Pick a broker: ${BROKER_IDS.join(', ')}.`)
      next.broker = p.broker as BrokerKind
    }
    if (p.limits !== undefined) next.limits = normalizeLimits({ ...next.limits, ...(p.limits as object) }, next.limits, true)
    if (p.simulatorCash !== undefined) {
      const cash = finite(p.simulatorCash)
      if (cash === undefined || cash < SIM_CASH_MIN || cash > SIM_CASH_MAX) throw new Error(`The simulator can start with between ${money(SIM_CASH_MIN)} and ${money(SIM_CASH_MAX)}.`)
      next.simulatorCash = roundMoney(cash)
    }
    if (p.simulatorAnytime !== undefined) next.simulatorAnytime = p.simulatorAnytime === true
    if (p.model !== undefined) next.model = normalizeModel(p.model)
    if (p.halted !== undefined) next.halted = p.halted === true
    // `liveConfirmedAt` only changes through confirmLive, where the user types the phrase.

    const brokerChanged = next.broker !== this.config.broker
    const halting = next.halted && !this.config.halted
    if (brokerChanged) this.epoch++
    this.config = next
    this.deps.saveConfig(this.config)
    if (this.active && (halting || brokerChanged)) {
      // A session started on practice money must never carry on with real money.
      await this.endSession(this.active, 'stopped', halting ? 'Stopped by the kill switch.' : `Stopped because the broker changed to ${brokerLabel(next.broker)}.`)
    }
    if (brokerChanged) {
      this.account = null
      this.positions = []
      this.error = null
      await this.sync()
    }
    this.changed()
    return this.snapshot()
  }

  /** Checks a pair of Alpaca keys against the account, then saves them in the vault. */
  async setKeys(kind: KeyKind, keyId: string, secret: string): Promise<TradingSnapshot> {
    if (kind !== 'paper' && kind !== 'live') throw new Error('Say which keys these are: paper or live.')
    const keys = { keyId: str(keyId), secret: str(secret) }
    if (!keys.keyId || !keys.secret) throw new Error('Paste both the API key ID and the secret key from your Alpaca dashboard.')
    const brokerKind: AlpacaKind = kind === 'live' ? 'alpaca-live' : 'alpaca-paper'
    const account = await this.makeAlpaca(brokerKind, keys).account()
    if (account.blocked) throw new Error(`Alpaca accepted the keys, but trading is blocked on this account (status: ${account.status || 'unknown'}). Check your Alpaca dashboard.`)
    this.deps.saveKeys(kind, keys)
    this.keyState[kind] = true
    this.alpaca.delete(brokerKind)
    if (this.config.broker === brokerKind) await this.sync()
    this.changed()
    return this.snapshot()
  }

  async clearKeys(kind: KeyKind): Promise<TradingSnapshot> {
    if (kind !== 'paper' && kind !== 'live') throw new Error('Say which keys to remove: paper or live.')
    const brokerKind: AlpacaKind = kind === 'live' ? 'alpaca-live' : 'alpaca-paper'
    this.deps.saveKeys(kind, null)
    this.keyState[kind] = false
    this.alpaca.delete(brokerKind)
    if (this.config.broker === brokerKind) {
      if (this.active) await this.endSession(this.active, 'stopped', 'Stopped because the Alpaca keys were removed.')
      this.account = null
      this.positions = []
      await this.sync()
    }
    this.changed()
    return this.snapshot()
  }

  confirmLive(phrase: string): TradingSnapshot {
    if (phrase !== LIVE_CONFIRMATION) throw new Error(`Type “${LIVE_CONFIRMATION}” exactly to confirm real-money trading.`)
    this.config.liveConfirmedAt = this.now()
    this.deps.saveConfig(this.config)
    this.changed()
    return this.snapshot()
  }

  /* --------------------------------------------------------------- orders */

  /**
   * Places an order after the guardrails. Orders go one at a time: two
   * checked side by side would both see the same room under a limit.
   * Resolves with the order as recorded — `rejected` with the reason when a
   * guardrail or the broker refused it. Throws only for a request that isn't
   * an order at all (no symbol, no size).
   */
  placeOrder(request: OrderRequest, source: OrderSource, options: { sessionId?: string | null; flatten?: boolean } = {}): Promise<TradingOrder> {
    const run = this.orderChain.then(() => this.placeNow(request, source, options))
    this.orderChain = run.catch(() => undefined)
    return run
  }

  /** The guardrails for this order against the account as it is now; null when it would pass. Records nothing. */
  async check(request: OrderRequest): Promise<string | null> {
    const order = parseOrderRequest(request)
    const broker = this.broker()
    if (!broker) return this.missingKeys(this.config.broker)
    const state = await this.limitState(broker, order.symbol)
    return checkLimits({ config: this.config, account: state.account, positions: state.positions, ordersToday: this.ordersToday(this.config.broker), order, price: state.price })
  }

  private async placeNow(request: OrderRequest, source: OrderSource, options: { sessionId?: string | null; flatten?: boolean }): Promise<TradingOrder> {
    const order = parseOrderRequest(request)
    if (source !== 'user' && !order.reason) throw new Error('Give a reason for the order. It is shown on the trading desk next to it.')
    const kind = this.config.broker
    const sessionId = options.sessionId ?? null
    const session = sessionId ? this.sessions.find((s) => s.id === sessionId) : undefined
    const entry: StoredOrder = {
      id: `eaon-${randomUUID()}`,
      broker: kind,
      brokerOrderId: null,
      clientOrderId: null,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      qty: order.qty ?? 0,
      notional: order.notional,
      limitPrice: order.limitPrice,
      status: 'pending',
      filledQty: 0,
      filledAvgPrice: null,
      submittedAt: this.now(),
      filledAt: null,
      realizedPl: null,
      source,
      sessionId,
      reason: order.reason,
      error: null
    }
    entry.clientOrderId = entry.id

    const refuse = (error: string): TradingOrder => {
      entry.status = 'rejected'
      entry.error = error
      this.addOrder(entry)
      if (session) this.log(session, 'order', orderOutcome(entry))
      this.changed()
      return toPublic(entry)
    }

    const broker = this.broker()
    if (!broker) return refuse(this.missingKeys(kind))
    // The switches first: they need no prices, and a halted desk shouldn't even ask.
    const early = checkSwitches(this.config, order.symbol, options.flatten) ?? (this.needsDisclaimer() && !options.flatten ? DISCLAIMER_REFUSAL : null)
    if (early) return refuse(early)
    let state: Awaited<ReturnType<TradingEngine['limitState']>>
    try {
      state = await this.limitState(broker, order.symbol)
    } catch (error) {
      return refuse(`Couldn’t check the order against your limits: ${errorText(error)}`)
    }
    if (state.blocked) return refuse(state.blocked)
    if (order.qty === null && order.notional !== null && state.price > 0) entry.qty = roundQty(order.notional / state.price)
    const refusal = checkLimits({
      config: this.config,
      account: state.account,
      positions: state.positions,
      ordersToday: this.ordersToday(kind),
      order,
      price: state.price,
      flatten: options.flatten
    })
    if (refusal) return refuse(refusal)
    if (this.config.broker !== kind) return refuse('The broker changed while the order was being checked. Place it again.')
    // A protective exit asked for with a buy is checked before the buy goes in,
    // so a bad stop can't leave a new holding unprotected.
    const wantsExit = request.stopLoss !== undefined || request.takeProfit !== undefined || request.trailPct !== undefined
    let exit: PositionExit | null = null
    if (wantsExit) {
      if (order.side !== 'buy') return refuse('A stop-loss, take-profit or trailing stop goes with a buy. To protect a holding you already have, set its exit instead.')
      const reference = order.type === 'limit' && order.limitPrice ? Math.min(order.limitPrice, state.price) : state.price
      const built = buildExit(
        { symbol: order.symbol, stopPrice: request.stopLoss, targetPrice: request.takeProfit, trailPct: request.trailPct },
        reference,
        this.exits[kind]?.[order.symbol],
        source,
        sessionId,
        this.now()
      )
      if (typeof built === 'string') return refuse(built)
      exit = built
    }

    entry.status = 'pending'
    this.addOrder(entry)
    try {
      const placed = await broker.submit({
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        ...(order.qty !== null ? { qty: order.qty } : { notional: order.notional! }),
        ...(order.limitPrice !== null ? { limitPrice: order.limitPrice } : {}),
        clientOrderId: entry.clientOrderId!
      })
      applyBrokerOrder(entry, placed)
    } catch (error) {
      entry.status = 'rejected'
      entry.error = errorText(error)
    }
    if (exit && entry.status !== 'rejected') this.storeExit(kind, exit)
    realizeFifo(this.orders.filter((o) => o.broker === kind))
    this.deps.saveOrders(this.orders)
    if (session) {
      if (entry.brokerOrderId) session.orders++
      this.log(
        session,
        'order',
        `${orderOutcome(entry)}${exit && entry.status !== 'rejected' ? ` Protected: ${describeExit(exit)}.` : ''}${entry.status !== 'rejected' && entry.reason ? ` Why: ${entry.reason}` : ''}`
      )
    }
    this.changed()
    // The account moved; the desk and the next check should see it.
    void this.sync()
    return toPublic(entry)
  }

  /**
   * Sets, changes or clears the protective exit on a holding. Values left out
   * stay as they are; null clears one. Returns the exit now in force, or null
   * when none is left. Throws a sentence when it can't be set.
   */
  async setExit(request: ExitRequest, by: PositionExit['setBy'] = 'user', sessionId: string | null = null): Promise<PositionExit | null> {
    const symbol = normalizeSymbol(request?.symbol)
    const kind = this.config.broker
    await this.sync()
    const held = this.positions.find((p) => p.symbol === symbol && p.qty > 0)
    const buying = this.orders.some((o) => o.broker === kind && o.symbol === symbol && o.side === 'buy' && OPEN_STATUSES.has(o.status))
    const current = this.exits[kind]?.[symbol]
    if (!held && !buying && !current) throw new Error(`You don’t hold any ${symbol}, so there is nothing to protect.`)
    const price = held?.price ?? (await this.deps.prices.quote(symbol)).price
    const built = buildExit({ ...request, symbol }, price, current, by, sessionId, this.now())
    if (typeof built === 'string') throw new Error(built)
    if (built) this.storeExit(kind, built)
    else this.dropExit(kind, symbol)
    // A stop that is already through the price is the next refresh's to act on.
    this.armRefresh(0)
    return built ? { ...built } : null
  }

  /** The exits on the selected broker's holdings. */
  exitsNow(): PositionExit[] {
    return Object.values(this.exits[this.config.broker] ?? {}).map((e) => ({ ...e }))
  }

  private storeExit(kind: BrokerKind, exit: PositionExit): void {
    const book = (this.exits[kind] ??= {})
    book[exit.symbol] = exit
    const position = this.positions.find((p) => p.symbol === exit.symbol)
    if (position && kind === this.config.broker) position.exit = exit
    this.exitRetryAt.delete(`${kind}:${exit.symbol}`)
    this.deps.saveExits?.(this.exits)
    this.changed()
  }

  private dropExit(kind: BrokerKind, symbol: string): void {
    const book = this.exits[kind]
    if (!book?.[symbol]) return
    delete book[symbol]
    const position = this.positions.find((p) => p.symbol === symbol)
    if (position && kind === this.config.broker) position.exit = null
    this.exitRetryAt.delete(`${kind}:${symbol}`)
    this.deps.saveExits?.(this.exits)
    this.changed()
  }

  /**
   * Runs after every refresh: raises trailing stops, drops exits whose
   * holding is gone, and sells a holding at market when its stop or target is
   * reached — while orders would fill. The sale goes through the guardrails
   * like a session's final sell-off: the kill switch still stops it, the size
   * and count limits don't (a stop that can't sell protects nothing).
   */
  private async watchExits(kind: BrokerKind): Promise<void> {
    const book = this.exits[kind]
    const account = this.account
    if (!book || !account || account.broker !== kind || this.config.broker !== kind) return
    const now = this.now()
    let dirty = false
    for (const symbol of Object.keys(book)) {
      const held = this.positions.some((p) => p.symbol === symbol && p.qty > 0)
      const buying = this.orders.some((o) => o.broker === kind && o.symbol === symbol && o.side === 'buy' && OPEN_STATUSES.has(o.status))
      if (!held && !buying && now - book[symbol].setAt > EXIT_GRACE_MS) {
        delete book[symbol]
        dirty = true
      }
    }
    const fills = account.marketOpen || (kind === 'simulator' && this.config.simulatorAnytime)
    const due: { position: TradingPosition; exit: PositionExit; hit: NonNullable<ReturnType<typeof exitTrigger>> }[] = []
    for (const position of this.positions) {
      const exit = book[position.symbol]
      if (!exit || position.qty <= 0) continue
      const high = exit.highWater
      const hit = exitTrigger(exit, position.price)
      if (exit.highWater !== high) dirty = true
      position.exit = exit
      if (!hit || !fills || this.config.halted) continue
      if ((this.exitRetryAt.get(`${kind}:${position.symbol}`) ?? 0) > now) continue
      due.push({ position, exit, hit })
    }
    if (dirty) {
      this.deps.saveExits?.(this.exits)
      this.changed()
    }
    for (const { position, exit, hit } of due) {
      const what = hit.kind === 'target' ? 'Take-profit' : hit.kind === 'trail' ? `Trailing stop (${exit.trailPct}% under ${money(exit.highWater ?? 0)})` : 'Stop-loss'
      const reason = `${what} reached: ${position.symbol} at ${money(position.price)}, ${hit.kind === 'target' ? 'target' : 'stop'} ${money(hit.level)}.`
      const session = this.active && (exit.sessionId === this.active.session.id || exit.setBy !== 'user') ? this.active.session : null
      const source: OrderSource = exit.setBy === 'user' ? 'user' : session ? 'session' : 'agent'
      const placed = await this.placeOrder({ symbol: position.symbol, side: 'sell', qty: position.qty, type: 'market', reason }, source, {
        sessionId: source === 'session' ? session!.id : null,
        flatten: true
      })
      if (placed.status === 'rejected') {
        this.exitRetryAt.set(`${kind}:${position.symbol}`, this.now() + EXIT_RETRY_MS)
        if (this.active) this.log(this.active.session, 'error', `${what} for ${position.symbol} couldn’t sell: ${placed.error ?? 'refused'}. Trying again in 5 minutes.`)
      } else {
        this.dropExit(kind, position.symbol)
        if (this.active && source !== 'session') this.log(this.active.session, 'order', `${reason} ${orderOutcome(placed)}`)
      }
    }
  }

  async cancelOrder(id: string): Promise<TradingSnapshot> {
    const entry = this.orders.find((o) => o.id === id || o.brokerOrderId === id)
    if (!entry) throw new Error('There is no such order.')
    if (!OPEN_STATUSES.has(entry.status)) throw new Error(`That order isn’t open any more — it was ${entry.status.replace('_', ' ')}.`)
    const broker = this.broker(entry.broker)
    if (!broker || !entry.brokerOrderId) throw new Error(entry.brokerOrderId ? this.missingKeys(entry.broker) : 'That order never reached the broker, so there is nothing to cancel.')
    await broker.cancel(entry.brokerOrderId)
    entry.status = 'canceled'
    this.deps.saveOrders(this.orders)
    this.changed()
    if (entry.broker === this.config.broker) await this.sync()
    return this.snapshot()
  }

  /** Sells the whole holding at market. */
  async closePosition(symbol: string): Promise<TradingOrder> {
    const wanted = normalizeSymbol(symbol)
    await this.sync()
    const position = this.positions.find((p) => p.symbol === wanted)
    if (!position || position.qty <= 0) throw new Error(`You don’t hold any ${wanted}.`)
    return this.placeOrder({ symbol: wanted, side: 'sell', qty: position.qty, type: 'market', reason: 'Closed the position from the desk.' }, 'user')
  }

  async resetSimulator(cash?: number): Promise<TradingSnapshot> {
    if (this.active && this.config.broker === 'simulator') throw new Error('Stop the trading session before resetting the simulator.')
    const amount = cash === undefined || cash === null ? this.config.simulatorCash : finite(cash)
    if (amount === undefined || amount < SIM_CASH_MIN || amount > SIM_CASH_MAX) throw new Error(`The simulator can start with between ${money(SIM_CASH_MIN)} and ${money(SIM_CASH_MAX)}.`)
    await this.orderChain
    this.epoch++
    this.config.simulatorCash = roundMoney(amount)
    this.deps.saveConfig(this.config)
    this.simulator.reset(this.config.simulatorCash)
    // A fresh account: its history goes too, or the stats would mix the two.
    this.orders = this.orders.filter((o) => o.broker !== 'simulator')
    this.deps.saveOrders(this.orders)
    this.equity.simulator = { start: this.config.simulatorCash, points: [] }
    this.flushEquity()
    if (this.config.broker === 'simulator') {
      this.account = null
      this.positions = []
      await this.sync()
    }
    this.changed()
    return this.snapshot()
  }

  /* --------------------------------------------------------------- prices */

  quote(symbol: string): Promise<Quote> {
    return this.deps.prices.quote(normalizeSymbol(symbol))
  }

  /** Today's movers, from the price feed's screener. */
  screen(kind: ScreenKind, count: number): Promise<ScreenRow[]> {
    if (!this.deps.prices.screen) return Promise.reject(new Error('The market screener isn’t available with this price feed.'))
    return this.deps.prices.screen(kind, count)
  }

  /** A stock's latest headlines. */
  news(symbol: string, count: number): Promise<Headline[]> {
    if (!this.deps.prices.news) return Promise.reject(new Error('News isn’t available with this price feed.'))
    return this.deps.prices.news(symbol, count)
  }

  bars(symbol: string, range: BarRange): Promise<Bar[]> {
    return this.deps.prices.bars(normalizeSymbol(symbol), range)
  }

  /* ------------------------------------------------------------ schedules */

  saveSchedule(draft: TradingScheduleDraft): TradingSchedule {
    const now = this.now()
    const strategy = str(draft?.strategy)
    if (!strategy) throw new Error('Describe the strategy: what to trade and how.')
    // A mission follows the market's own hours; its clock times and days are only for show.
    const market = draft.marketHours === true
    if (market) draft = { ...draft, start: '09:30', end: '16:00', days: [1, 2, 3, 4, 5] }
    const start = clockText(draft.start)
    const end = clockText(draft.end)
    if (!start || !end) throw new Error('Give the window as 24-hour times, like 09:30 and 16:00.')
    if (start === end) throw new Error('The window has to end at a different time from when it starts.')
    const days = Array.isArray(draft.days) ? [...new Set(draft.days.filter((d) => DAYS.has(d)))].sort() : []
    if (days.length === 0) throw new Error('Pick at least one day for the schedule.')
    const existing = draft.id ? this.schedules.find((s) => s.id === draft.id) : undefined
    if (!existing && this.schedules.length >= MAX_SCHEDULES) throw new Error(`You can have up to ${MAX_SCHEDULES} schedules. Remove one first.`)
    const schedule: TradingSchedule = {
      id: existing?.id ?? randomUUID(),
      name: str(draft.name).slice(0, 80) || nameFrom(strategy),
      days,
      start,
      end,
      strategy,
      everyMinutes: everyMinutesOf(draft.everyMinutes),
      flattenAtEnd: draft.flattenAtEnd === true,
      enabled: draft.enabled !== false,
      createdAt: existing?.createdAt ?? now,
      ...(market ? { marketHours: true } : {}),
      ...(draft.driver === 'claude-code' ? { driver: 'claude-code' as const } : {})
    }
    if (existing) this.schedules[this.schedules.indexOf(existing)] = schedule
    else this.schedules.push(schedule)
    this.deps.saveSchedules(this.schedules)
    this.changed()
    // A window that is open right now starts straight away.
    if (this.started) void this.tickSchedules()
    return clone(schedule)
  }

  removeSchedule(id: string): TradingSnapshot {
    const before = this.schedules.length
    this.schedules = this.schedules.filter((s) => s.id !== id)
    if (this.schedules.length === before) throw new Error('There is no such schedule.')
    this.scheduleTries.delete(id)
    this.deps.saveSchedules(this.schedules)
    this.changed()
    return this.snapshot()
  }

  /**
   * Starts a session for an enabled schedule whose window is open now, once
   * per window: one the user stopped stays stopped until the next window.
   * One that couldn't start (no keys, the network down) is shown as a failed
   * session and tried again every few minutes while the window lasts.
   */
  async tickSchedules(): Promise<void> {
    if (this.disposed || this.config.halted || this.active) return
    const now = this.now()
    for (const schedule of this.schedules) {
      if (!schedule.enabled) continue
      const window = scheduleWindow(schedule, now)
      if (!window || window.end - now < this.minuteMs) continue
      const tried = this.scheduleTries.get(schedule.id)
      const failedId = tried && tried.windowStart === window.start ? tried.sessionId : null
      const ran = this.sessions.some((s) => s.scheduleId === schedule.id && s.startedAt >= window.start && s.startedAt < window.end && s.id !== failedId)
      if (ran) continue
      if (failedId && tried && now - tried.at < SCHEDULE_RETRY_MS) continue
      try {
        await this.startSession(
          {
            strategy: schedule.strategy,
            until: window.end,
            everyMinutes: schedule.everyMinutes,
            flattenAtEnd: schedule.flattenAtEnd,
            name: schedule.name,
            ...(schedule.driver === 'claude-code' ? { driver: 'claude-code' as const } : {})
          },
          schedule.id
        )
        this.scheduleTries.delete(schedule.id)
      } catch (error) {
        if (this.active) return // someone else started one meanwhile
        this.recordStartFailure(schedule, window.start, failedId, errorText(error))
      }
      return
    }
  }

  private recordStartFailure(schedule: TradingSchedule, windowStart: number, failedId: string | null, error: string): void {
    const now = this.now()
    let session = failedId ? this.sessions.find((s) => s.id === failedId) : undefined
    if (!session) {
      session = {
        id: randomUUID(),
        scheduleId: schedule.id,
        name: schedule.name,
        strategy: schedule.strategy,
        startedAt: now,
        endsAt: now,
        endedAt: now,
        status: 'failed',
        everyMinutes: schedule.everyMinutes,
        flattenAtEnd: schedule.flattenAtEnd,
        startEquity: 0,
        endEquity: null,
        orders: 0,
        checks: 0,
        log: [],
        summary: 'The scheduled session couldn’t start.',
        error
      }
      this.sessions.unshift(session)
      this.trimSessions()
    }
    session.error = error
    session.endedAt = now
    this.log(session, 'error', `Couldn’t start: ${error}`)
    this.scheduleTries.set(schedule.id, { windowStart, at: now, sessionId: session.id })
  }

  /* ------------------------------------------------------------- sessions */

  async startSession(request: StartSessionRequest, scheduleId: string | null = null): Promise<TradingSession> {
    const now = this.now()
    if (this.config.halted) throw new Error('Trading is halted (the kill switch is on). Switch it off on the trading desk before starting a session.')
    if (this.needsDisclaimer()) throw new Error(DISCLAIMER_REFUSAL)
    this.ensureNoSession()
    const strategy = str(request?.strategy).slice(0, 4000)
    if (!strategy) throw new Error('Describe the strategy for the session: what to trade and how.')
    const until = finite(request.until)
    if (until === undefined || until < now + this.minuteMs) throw new Error('Pick an end time at least a minute from now.')
    if (until > now + MAX_SESSION_DAYS * 24 * 3600_000) throw new Error(`A session can run for at most ${MAX_SESSION_DAYS} days. Use a schedule for a window that repeats.`)
    if (this.config.broker === 'alpaca-live' && !this.config.liveConfirmedAt) {
      throw new Error('Real-money trading isn’t confirmed yet. Confirm it on the trading desk before starting a session on Alpaca live.')
    }
    if (!this.broker()) throw new Error(this.missingKeys(this.config.broker))
    await this.sync()
    if (!this.account) throw new Error(this.error ?? 'Couldn’t read the account from the broker. Try again shortly.')
    // Another start may have slipped in while the account loaded.
    this.ensureNoSession()

    const everyMinutes = everyMinutesOf(request.everyMinutes)
    const benchmark = await this.benchmarkPrice()
    const session: TradingSession = {
      id: randomUUID(),
      scheduleId,
      name: str(request.name).slice(0, 80) || nameFrom(strategy),
      strategy,
      startedAt: now,
      endsAt: until,
      endedAt: null,
      status: 'running',
      everyMinutes,
      flattenAtEnd: request.flattenAtEnd === true,
      startEquity: this.account.equity,
      endEquity: null,
      orders: 0,
      checks: 0,
      log: [],
      summary: null,
      error: null,
      benchmark: benchmark === null ? null : { symbol: BENCHMARK, start: benchmark, end: null },
      ...(request.driver === 'claude-code' ? { driver: 'claude-code' as const } : {})
    }
    this.sessions.unshift(session)
    this.trimSessions()
    const active = this.makeActive(session)
    this.active = active
    this.log(
      session,
      'note',
      `Started on ${brokerLabel(this.config.broker)}: a check every ${everyMinutes} min until ${localTime(until)}${session.flattenAtEnd ? ', selling everything at the end' : ''}.${
        session.driver === 'claude-code' ? ' Claude Code makes the decisions; it takes the first check when you hand it the session.' : ''
      }`
    )
    this.armSession(active, 0)
    this.armRefresh()
    return clone(session)
  }

  /** Stops a session by hand. Positions are kept (only a session's natural end sells them); its open orders are canceled. */
  async stopSession(id: string, note = 'Stopped by you.'): Promise<TradingSnapshot> {
    const active = this.active
    if (active && active.session.id === id) {
      await this.endSession(active, 'stopped', note)
      return this.snapshot()
    }
    const stale = this.sessions.find((s) => s.id === id && s.status === 'running')
    if (!stale) throw new Error('That session isn’t running.')
    stale.status = 'stopped'
    stale.endedAt = this.now()
    this.log(stale, 'note', note)
    return this.snapshot()
  }

  /**
   * The agent asked to stop the session it is running in. Ending it here
   * would abort the very turn making the call, so it ends when that turn does.
   */
  stopFromInside(id: string): boolean {
    if (!this.active || this.active.session.id !== id || !this.active.running) return false
    this.active.stopAfterTurn = true
    return true
  }

  private ensureNoSession(): void {
    const active = this.active
    if (!active) return
    throw new Error(`A trading session is already running (“${active.session.name}”, until ${localTime(active.session.endsAt)}). Stop it first, or wait for it to end.`)
  }

  private makeActive(session: TradingSession): ActiveSession {
    // After a restart the conversation is gone; the decisions in the log stand in for it.
    const thread: ChatMessage[] = []
    for (const entry of session.log.filter((e) => e.kind === 'decision').slice(-THREAD_TURNS)) {
      thread.push(
        { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: `[Earlier check, ${new Date(entry.at).toLocaleString('en-US')}]` }], createdAt: entry.at },
        { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: entry.text }], createdAt: entry.at }
      )
    }
    return {
      session,
      thread,
      turnTimer: null,
      endTimer: null,
      controller: null,
      running: null,
      closedNoted: false,
      haltNoted: false,
      failures: 0,
      stopAfterTurn: false,
      ending: false,
      quitting: false,
      turnStartedAt: null,
      nextTurnAt: null,
      inbox: [],
      alerts: [],
      basePrices: new Map(),
      latestPrices: new Map(),
      watchTimer: null,
      lastWatchAt: null,
      waiters: new Set(),
      lastExternalAt: null,
      externalMessageId: null
    }
  }

  private armSession(active: ActiveSession, firstTurnDelay: number): void {
    this.clearSessionTimers(active)
    const left = Math.max(0, active.session.endsAt - this.now())
    active.endTimer = setTimeout(() => void this.endSession(active, 'done', 'The session’s time is up.'), left)
    active.endTimer.unref?.()
    // Claude Code takes its checks itself (waitForCheck); the first is due now.
    if (active.session.driver === 'claude-code') active.nextTurnAt = this.now() + firstTurnDelay
    else this.scheduleTurn(active, firstTurnDelay)
    this.scheduleWatch(active)
  }

  private clearSessionTimers(active: ActiveSession): void {
    if (active.turnTimer) clearTimeout(active.turnTimer)
    if (active.endTimer) clearTimeout(active.endTimer)
    if (active.watchTimer) clearTimeout(active.watchTimer)
    active.turnTimer = null
    active.endTimer = null
    active.watchTimer = null
    active.nextTurnAt = null
  }

  /* ---------------------------------------------------------- live watch */

  private scheduleWatch(active: ActiveSession): void {
    if (active.watchTimer) clearTimeout(active.watchTimer)
    active.watchTimer = setTimeout(() => {
      active.watchTimer = null
      void this.watchTick(active).finally(() => {
        if (this.active === active && !active.ending && !this.disposed) this.scheduleWatch(active)
      })
    }, this.deps.watchMs ?? 15_000)
    active.watchTimer.unref?.()
  }

  /** The symbols a session watches between checks: its holdings, the tickers in its strategy, and the market. */
  private watchedSymbols(session: TradingSession): string[] {
    return [...new Set([...this.positions.map((p) => p.symbol), ...tickersIn(session.strategy), BENCHMARK])].slice(0, 12)
  }

  /**
   * Between checks, prices every few seconds: the agent's next check learns
   * what moved, and a sharp move — a holding, a ticker the strategy names,
   * the market — or a holding nearing its stop wakes it early.
   */
  private async watchTick(active: ActiveSession): Promise<void> {
    if (this.active !== active || active.ending || active.running || this.disposed || this.config.halted) return
    const session = active.session
    const quoteOf = (symbol: string): Promise<Quote | null> =>
      Promise.race([
        this.deps.prices.quote(symbol).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CONTEXT_TIMEOUT_MS).unref?.())
      ])
    const symbols = this.watchedSymbols(session)
    const quotes = (await Promise.all(symbols.map(quoteOf))).filter((q): q is Quote => q !== null)
    if (this.active !== active || active.ending || active.running) return
    active.lastWatchAt = this.now()
    const held = new Map(this.positions.map((p) => [p.symbol, p]))
    const alerts: string[] = []
    for (const q of quotes) {
      active.latestPrices.set(q.symbol, q.price)
      const base = active.basePrices.get(q.symbol)
      if (base === undefined) {
        active.basePrices.set(q.symbol, q.price)
        continue
      }
      const move = base > 0 ? ((q.price - base) / base) * 100 : 0
      const position = held.get(q.symbol)
      const limit = q.symbol === BENCHMARK ? ALERT_MARKET_PCT : position ? ALERT_HOLDING_PCT : ALERT_WATCHED_PCT
      if (Math.abs(move) >= limit) alerts.push(`${q.symbol} ${signedPct(move)} since the last check (${money(base)} → ${money(q.price)})${position ? ', which you hold' : ''}.`)
      const stop = position?.exit?.activeStop
      if (stop && q.price > stop && (q.price - stop) / q.price <= ALERT_STOP_PCT / 100) alerts.push(`${q.symbol} is ${(((q.price - stop) / q.price) * 100).toFixed(2)}% above its stop (${money(stop)}).`)
    }
    this.changed()
    if (alerts.length === 0) return
    const anytime = this.config.broker === 'simulator' && this.config.simulatorAnytime
    if (!this.account?.marketOpen && !anytime) return
    if (this.now() - (this.lastTurnAt.get(session.id) ?? 0) < (this.deps.alertGapMs ?? 60_000)) return
    // The check this wakes starts the next baseline, so each move alerts once.
    active.alerts.push(...alerts)
    this.log(session, 'note', `⚡ ${alerts.join(' ')} Checking now.`)
    if (session.driver === 'claude-code') return this.wake(active)
    if (active.turnTimer) clearTimeout(active.turnTimer)
    active.turnTimer = null
    active.nextTurnAt = null
    void this.runTurn(active)
  }

  /** Lines for a check: what moved since the last one, from the watch. */
  private liveLines(active: ActiveSession): string[] {
    const moves: string[] = []
    for (const [symbol, base] of active.basePrices) {
      const latest = active.latestPrices.get(symbol)
      if (latest === undefined || base <= 0 || latest === base) continue
      moves.push(`${symbol} ${money(base)} → ${money(latest)} (${signedPct(((latest - base) / base) * 100)})`)
    }
    return moves.length ? [`Since your last check (Eaon watches prices every ${Math.round((this.deps.watchMs ?? 15_000) / 1000)} s): ${moves.join(' · ')}.`] : []
  }

  /* ---------------------------------------------------- talking to the agent */

  /**
   * A message from the user to the session's agent. It is logged, and the
   * agent reads it in a check that starts now — or as soon as the one under
   * way ends.
   */
  tellSession(id: string, text: string): TradingSnapshot {
    const active = this.active
    if (!active || active.session.id !== id) throw new Error('That session isn’t running.')
    const message = str(text).slice(0, 2000)
    if (!message) throw new Error('Write something to send.')
    active.inbox.push({ at: this.now(), text: message })
    this.log(active.session, 'message', message)
    if (active.session.driver === 'claude-code') {
      this.wake(active)
      return this.snapshot()
    }
    if (!active.running && !active.ending && !this.config.halted) {
      if (active.turnTimer) clearTimeout(active.turnTimer)
      active.turnTimer = null
      active.nextTurnAt = null
      void this.runTurn(active)
    }
    return this.snapshot()
  }

  /* ------------------------------------------------- Claude Code as the agent */

  private agentState(active: ActiveSession): NonNullable<TradingSnapshot['agent']> {
    const external = active.session.driver === 'claude-code'
    const every = active.session.everyMinutes * this.minuteMs
    return {
      checking: external ? active.turnStartedAt !== null : Boolean(active.running),
      checkStartedAt: active.turnStartedAt,
      nextCheckAt: external ? active.nextTurnAt : active.turnTimer ? active.nextTurnAt : null,
      watchedAt: active.lastWatchAt,
      watching: this.watchedSymbols(active.session),
      driver: external ? 'claude-code' : 'eaon',
      ...(external ? { connected: active.waiters.size > 0 || (active.lastExternalAt !== null && this.now() - active.lastExternalAt < every + 120_000) } : {})
    }
  }

  private wake(active: ActiveSession): void {
    for (const fn of [...active.waiters]) fn()
  }

  private externalSession(id: string): ActiveSession {
    const active = this.active
    if (!active || active.session.id !== id) throw new Error('That session isn’t running.')
    if (active.session.driver !== 'claude-code') throw new Error('That session is run by Eaon’s own agent, not Claude Code.')
    return active
  }

  /** Stream events for a Claude Code session's checks, so the desk's feed shows its steps like Eaon's agent's. */
  private externalEvent(active: ActiveSession, event: Omit<StreamEvent, 'messageId'> & { type: StreamEvent['type'] }): void {
    if (!active.externalMessageId) return
    try {
      this.deps.onAgentEvent?.(active.session.id, { ...event, messageId: active.externalMessageId } as StreamEvent)
    } catch (error) {
      console.error('[trading] agent event listener failed:', error)
    }
  }

  /**
   * Claude Code taking the next check of the session it runs: waits until
   * it is due — the interval, a message from the user, a price alert, or
   * "check now" — then returns the same brief Eaon's own agent would get.
   * Returns `waiting` when nothing came due within `maxWaitMs` (ask again),
   * and `ended` once the session is over.
   */
  async waitForCheck(
    id: string,
    maxWaitMs = 9 * 60_000
  ): Promise<{ state: 'check'; check: number; brief: string; endsAt: number } | { state: 'waiting'; nextCheckAt: number | null } | { state: 'ended'; status: string; summary: string | null }> {
    const ended = () => {
      const s = this.sessions.find((x) => x.id === id)
      return { state: 'ended' as const, status: s?.status ?? 'over', summary: s?.summary ?? null }
    }
    if (!this.active || this.active.session.id !== id || this.active.ending) return ended()
    const active = this.externalSession(id)
    const session = active.session
    const every = session.everyMinutes * this.minuteMs
    // A check Claude Code left without logging a decision is over now.
    if (active.turnStartedAt !== null) {
      active.turnStartedAt = null
      this.externalEvent(active, { type: 'done' } as never)
    }
    const deadline = this.now() + Math.max(0, maxWaitMs)
    for (;;) {
      if (this.active !== active || active.ending) return ended()
      active.lastExternalAt = this.now()
      const due = active.inbox.length > 0 || active.alerts.length > 0 || (active.nextTurnAt !== null && this.now() >= active.nextTurnAt)
      if (due && !this.config.halted) {
        const brief = await this.externalBrief(active)
        if (this.active !== active || active.ending) return ended()
        if ('brief' in brief) {
          const now = this.now()
          session.checks++
          active.turnStartedAt = now
          active.nextTurnAt = now + every
          this.lastTurnAt.set(id, now)
          active.externalMessageId = `claude-code:${id}:${session.checks}`
          // Opens the check in the desk's feed.
          this.externalEvent(active, { type: 'usage', usage: EMPTY_USAGE } as never)
          this.deps.saveSessions(this.sessions)
          this.changed()
          return { state: 'check', check: session.checks, brief: brief.brief, endsAt: session.endsAt }
        }
        // Closed market, or the broker didn't answer: try again at the next interval.
        active.nextTurnAt = this.now() + every
        if ('error' in brief) this.log(session, 'error', brief.error)
        else if (!active.closedNoted) {
          this.log(session, 'note', 'The market is closed, so there is nothing to do until it opens.')
          active.closedNoted = true
        }
      }
      if (this.now() >= deadline) return { state: 'waiting', nextCheckAt: active.nextTurnAt }
      const until = Math.min(deadline, active.nextTurnAt ?? deadline)
      this.changed()
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          active.waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, Math.max(20, until - this.now()))
        active.waiters.add(done)
      })
    }
  }

  /** When the next session of an enabled schedule run by `driver` starts, if any is enabled. */
  nextScheduledStart(driver: SessionDriver = 'claude-code', at = this.now()): number | null {
    let best: number | null = null
    for (const schedule of this.schedules) {
      if (!schedule.enabled || (schedule.driver ?? 'eaon') !== driver) continue
      // A window that already had its session (even one stopped by hand) doesn't start another.
      const fresh = (w: { start: number; end: number } | null): boolean =>
        w !== null && !this.sessions.some((s) => s.scheduleId === schedule.id && s.startedAt >= w.start && s.startedAt < w.end && s.status !== 'failed')
      let next: number | null = null
      if (schedule.marketHours) next = fresh(scheduleWindow(schedule, at)) ? at : nextOpen(at)
      else
        for (let i = 0; i < 8 * 24 * 60 && next === null; i += 15) {
          const t = at + i * 60_000
          if (fresh(scheduleWindow(schedule, t))) next = t
        }
      if (next !== null && (best === null || next < best)) best = next
    }
    return best
  }

  /**
   * Claude Code waiting between sessions of a mission it runs (overnight,
   * over a weekend): resolves with the session once one it drives is
   * running, `waiting` with when the next starts if none did by
   * `maxWaitMs`, or `none` when no mission is left for it.
   */
  async waitForSession(maxWaitMs = 4 * 3_600_000): Promise<{ state: 'session'; id: string } | { state: 'waiting'; nextAt: number | null } | { state: 'none' }> {
    const deadline = this.now() + Math.max(0, maxWaitMs)
    // The desk shows Claude Code as waiting for the open while one of these is pending.
    this.missionWaiters++
    if (this.missionWaiters === 1) this.changed()
    try {
      for (;;) {
        const active = this.active
        if (active && active.session.driver === 'claude-code' && !active.ending) return { state: 'session', id: active.session.id }
        const next = this.nextScheduledStart('claude-code')
        if (next === null) return { state: 'none' }
        if (this.now() >= deadline) return { state: 'waiting', nextAt: next }
        // Sessions start from the schedule tick; looking twice a minute is plenty. (Not unref'd: someone is waiting on it.)
        await new Promise((resolve) => setTimeout(resolve, Math.max(20, Math.min(30_000, deadline - this.now()))))
      }
    } finally {
      this.missionWaiters--
      this.missionWaitedAt = this.now()
      if (this.missionWaiters === 0) this.changed()
    }
  }

  /** Whether Claude Code is waiting for its mission's next session (between calls of a long wait counts too). */
  private claudeWaiting(): boolean {
    return this.missionWaiters > 0 || (this.missionWaitedAt !== null && this.now() - this.missionWaitedAt < 2 * 60_000)
  }

  /** The brief for a Claude Code check, built as `turn` builds Eaon's agent's. */
  private async externalBrief(active: ActiveSession): Promise<{ brief: string } | { closed: true } | { error: string }> {
    const session = active.session
    await this.sync()
    const account = this.account
    if (!account) return { error: this.error ?? 'Couldn’t read the account from the broker.' }
    const anytime = this.config.broker === 'simulator' && this.config.simulatorAnytime
    if (!account.marketOpen && !anytime && active.inbox.length === 0) return { closed: true }
    active.closedNoted = false
    const market = await this.marketContext(session)
    const now = this.now()
    const inbox = active.inbox.splice(0)
    const alerts = active.alerts.splice(0)
    const live = this.liveLines(active)
    const lead = [
      ...inbox.map((m) => `MESSAGE FROM THE USER (${localTime(m.at)}): ${m.text}\nAnswer it in your decision, and act on it where it fits your limits; it overrides the strategy.`),
      ...alerts.map((a) => `ALERT: ${a}`)
    ]
    active.basePrices = new Map([...this.positions.map((p) => [p.symbol, p.price] as const), ...this.contextQuotes.map((q) => [q.symbol, q.price] as const)])
    active.latestPrices = new Map(active.basePrices)
    const brief = [
      ...lead,
      this.turnMessage(session, account, now, [...market, ...live]),
      'When you are done, call eaon_log_decision with that one line, then eaon_wait_for_check for the next check.'
    ].join('\n\n')
    return { brief }
  }

  /** Claude Code's one line at the end of a check. */
  logDecision(id: string, text: string): TradingSnapshot {
    const active = this.externalSession(id)
    const line = str(text).slice(0, 1200)
    if (!line) throw new Error('Write the decision: one line on what you did and why.')
    this.log(active.session, 'decision', line)
    this.externalEvent(active, { type: 'delta', text: line } as never)
    this.externalEvent(active, { type: 'done' } as never)
    active.turnStartedAt = null
    this.changed()
    return this.snapshot()
  }

  /** An order Claude Code places for the session it runs: the session's, with every limit checked. */
  sessionOrder(id: string, request: OrderRequest): Promise<TradingOrder> {
    this.externalSession(id)
    return this.placeOrder(request, 'session', { sessionId: id })
  }

  /** A tool Claude Code used during a check, for the desk's feed (named as Eaon's agent's tools, so it reads the same). */
  recordExternalTool(name: string, input: Record<string, unknown>, output: string, ok: boolean): void {
    const active = this.active
    if (!active || active.session.driver !== 'claude-code' || !active.externalMessageId) return
    const toolId = randomUUID()
    this.externalEvent(active, { type: 'tool-call', toolId, name, input } as never)
    this.externalEvent(active, { type: 'tool-result', toolId, output, status: ok ? 'done' : 'error' } as never)
  }

  /* ----------------------------------------------------------- disclaimer */

  /** Whether orders and sessions still wait for the disclaimer. */
  needsDisclaimer(): boolean {
    return Boolean(this.deps.requireDisclaimer?.()) && (this.config.disclaimer?.version ?? 0) < TRADING_DISCLAIMER_VERSION
  }

  /** The user ticked the box under the trading disclaimer (this version of it). */
  acceptDisclaimer(version: number): TradingSnapshot {
    if (version !== TRADING_DISCLAIMER_VERSION) throw new Error('That isn’t the current disclaimer. Read it again and accept it.')
    this.config.disclaimer = { version, acceptedAt: this.now() }
    this.deps.saveConfig(this.config)
    this.changed()
    return this.snapshot()
  }

  private scheduleTurn(active: ActiveSession, delay: number): void {
    if (active.turnTimer) clearTimeout(active.turnTimer)
    active.nextTurnAt = this.now() + Math.max(0, delay)
    active.turnTimer = setTimeout(() => {
      active.turnTimer = null
      active.nextTurnAt = null
      void this.runTurn(active)
    }, Math.max(0, delay))
    active.turnTimer.unref?.()
    this.changed()
  }

  /**
   * Runs the running session's next check now instead of waiting for its
   * timer; the one after is timed from this one. Does nothing while a check
   * is already under way.
   */
  checkNow(id: string): TradingSnapshot {
    const active = this.active
    if (!active || active.session.id !== id) throw new Error('That session isn’t running.')
    if (this.config.halted) throw new Error('The kill switch is on; nothing runs until it is off.')
    if (active.session.driver === 'claude-code') {
      active.nextTurnAt = this.now()
      this.wake(active)
      return this.snapshot()
    }
    if (!active.running && !active.ending) {
      if (active.turnTimer) clearTimeout(active.turnTimer)
      active.turnTimer = null
      active.nextTurnAt = null
      void this.runTurn(active)
    }
    return this.snapshot()
  }

  /** One check, then the next is scheduled — only once this one has finished, so two never overlap. */
  private async runTurn(active: ActiveSession): Promise<void> {
    if (this.active !== active || active.running || active.ending || this.disposed) return
    const started = this.now()
    const every = active.session.everyMinutes * this.minuteMs
    active.turnStartedAt = started
    this.lastTurnAt.set(active.session.id, started)
    this.changed()
    active.running = this.turn(active)
      .catch((error) => {
        console.error('[trading] session check failed:', error)
      })
      .finally(() => {
        active.running = null
        active.controller = null
        active.turnStartedAt = null
        this.changed()
        if (this.active !== active || active.ending || this.disposed) return
        if (active.stopAfterTurn) {
          void this.endSession(active, 'stopped', 'The agent stopped the session.')
          return
        }
        // A message that came in during the check is read straight away; otherwise
        // every N minutes from the start of the last check, never back to back.
        if (active.inbox.length > 0) this.scheduleTurn(active, 0)
        else this.scheduleTurn(active, Math.max(every / 4, started + every - this.now()))
      })
    await active.running
  }

  private async turn(active: ActiveSession): Promise<void> {
    const session = active.session
    if (this.now() >= session.endsAt) return // the end timer takes it from here
    if (this.config.halted) {
      if (!active.haltNoted) this.log(session, 'note', 'Trading is halted; the agent waits until the kill switch is off.')
      active.haltNoted = true
      return
    }
    active.haltNoted = false

    await this.sync()
    if (this.active !== active || active.ending) return
    const account = this.account
    if (!account) {
      this.turnFailed(active, this.error ?? 'Couldn’t read the account from the broker.')
      return
    }
    const anytime = this.config.broker === 'simulator' && this.config.simulatorAnytime
    // The user writing to the agent gets an answer even while the market is closed.
    if (!account.marketOpen && !anytime && active.inbox.length === 0) {
      if (!active.closedNoted) {
        const opens = account.nextOpen ? ` Waiting for the open at ${formatMarketTime(account.nextOpen, this.now())}.` : ''
        this.log(session, 'note', `The market is closed, so there is nothing to do.${opens}`)
      }
      active.closedNoted = true
      return
    }
    active.closedNoted = false

    const settings = this.deps.getSettings()
    const target = (this.deps.resolveModel ?? ((t, s) => resolveAppModel(t, s, undefined, 'trading desk')))({ model: this.config.model }, settings)
    if (!target.ok) {
      this.turnFailed(active, target.error)
      return
    }
    // The app's level, clamped down to what the model takes, as the composer shows it.
    // (Bumping to the model's highest level made a five-minute check run at Max.)
    const effort = clampEffort(settings.effort, target.model?.efforts) ?? settings.effort
    const market = await this.marketContext(session)
    if (this.active !== active || active.ending) return
    const now = this.now()
    // What the user wrote and what woke the agent early come first; what moved since the last check after the market.
    const inbox = active.inbox.splice(0)
    const alerts = active.alerts.splice(0)
    const live = this.liveLines(active)
    const lead = [
      ...inbox.map((m) => `MESSAGE FROM THE USER (${localTime(m.at)}): ${m.text}\nAnswer it in your final line, and act on it where it fits your limits; it overrides the strategy.`),
      ...alerts.map((a) => `ALERT: ${a}`)
    ]
    // The prices this check starts from are the baseline for the next alert.
    active.basePrices = new Map([...this.positions.map((p) => [p.symbol, p.price] as const), ...this.contextQuotes.map((q) => [q.symbol, q.price] as const)])
    active.latestPrices = new Map(active.basePrices)
    const brief = [...lead, this.turnMessage(session, account, now, [...market, ...live])].join('\n\n')
    const userMessage: ChatMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: brief }], createdAt: now }
    const assistantId = randomUUID()
    const request: StreamRequest = {
      chatId: `${TRADING_CHAT_PREFIX}${session.id}`,
      chatTitle: `Trading: ${session.name}`,
      messageId: assistantId,
      providerId: target.providerId,
      modelId: target.modelId,
      effort,
      mode: 'work',
      history: [...active.thread, userMessage],
      summary: null,
      projectInstructions: '',
      cwd: this.workFolder(settings),
      // Swarm sub-agents build their own approval gate, which knows nothing of
      // the unattended policy, and plan mode would stop at a plan nobody can
      // approve — the same reasons workers and scheduled runs use neither.
      work: { swarm: false, plan: false },
      goal: null,
      persona: this.persona(session)
    }

    const outcome = await this.runWatched(active, request)
    if (active.quitting) return
    if (outcome.cancelled && !outcome.error) return // stopped or ended; that path writes the log
    if (outcome.error) {
      this.turnFailed(active, outcome.error)
      return
    }
    active.failures = 0
    session.checks++
    const text = outcome.text.trim()
    this.log(session, 'decision', text ? (text.length > 1200 ? `${text.slice(0, 1199)}…` : text) : 'The agent ended the check without a word.')
    active.thread.push(userMessage, { id: assistantId, role: 'assistant', parts: [{ type: 'text', text: text || '(no reply)' }], createdAt: this.now(), model: target.modelId })
    active.thread = active.thread.slice(-THREAD_TURNS * 2)
  }

  /** Runs the agent with a stall watchdog, like a worker's turn: no sign of life for too long and it is stopped. */
  private async runWatched(active: ActiveSession, request: StreamRequest): Promise<RunOutcome & { stalled?: boolean }> {
    const controller = new AbortController()
    active.controller = controller
    const stallMs = this.deps.stallMs ?? STALL_MS
    let stalled = false
    // Monotonic, so time the computer spent asleep does not count as silence.
    let lastSign = performance.now()
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const check = (): void => {
      const quiet = performance.now() - lastSign
      if (quiet < stallMs) {
        watchdog = setTimeout(check, stallMs - quiet)
        return
      }
      stalled = true
      controller.abort()
    }
    let outcome: RunOutcome
    try {
      watchdog = setTimeout(check, stallMs)
      outcome = await this.deps.runAgent(
        request,
        (event) => {
          lastSign = performance.now()
          try {
            this.deps.onAgentEvent?.(active.session.id, event)
          } catch (error) {
            console.error('[trading] agent event listener failed:', error)
          }
        },
        {
          signal: controller.signal,
          // Every tool runs on its own except what can't be undone; the trading
          // tools themselves only ask for real money placed from a chat.
          unattended: 'autonomous',
          approver: async () => false,
          toolGate: sessionToolGate,
          offer: isSessionTool
        }
      )
    } catch (error) {
      outcome = { text: '', usage: EMPTY_USAGE, error: errorText(error) }
    } finally {
      clearTimeout(watchdog)
    }
    if (stalled) {
      return {
        ...outcome,
        error: `No progress for ${Math.max(1, Math.round(stallMs / 60_000))} minutes, so the check was stopped. The model or a tool stopped responding.`,
        stalled: true
      }
    }
    return outcome
  }

  private turnFailed(active: ActiveSession, error: string): void {
    active.failures++
    this.log(active.session, 'error', error)
    if (active.failures >= MAX_FAILURES) void this.endSession(active, 'failed', `Stopped after ${MAX_FAILURES} failed checks in a row.`, error)
  }

  /**
   * Ends the session: no more checks, its open orders canceled (they would
   * fill with nobody watching), everything sold if it ran its course with
   * `flattenAtEnd`, and a summary of how it went.
   */
  private async endSession(active: ActiveSession, status: 'done' | 'stopped' | 'failed', note: string, error?: string): Promise<void> {
    if (active.ending) return
    active.ending = true
    // Claude Code waiting for a check hears that the session is over.
    this.wake(active)
    this.clearSessionTimers(active)
    active.controller?.abort()
    if (active.running) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([active.running, new Promise<void>((resolve) => (timer = setTimeout(resolve, END_WAIT_MS)))])
      clearTimeout(timer)
    }
    const session = active.session
    this.log(session, 'note', note, false)
    await this.cancelSessionOrders(session)
    if (status === 'done' && session.flattenAtEnd) await this.flatten(session)
    await this.sync()
    session.endEquity = this.account?.equity ?? null
    if (session.benchmark) session.benchmark.end = await this.benchmarkPrice()
    session.endedAt = this.now()
    session.status = status
    session.error = error ?? null
    session.summary = this.summarize(session)
    if (this.active === active) this.active = null
    this.deps.saveSessions(this.sessions)
    this.changed()
    this.armRefresh()
  }

  private async cancelSessionOrders(session: TradingSession): Promise<void> {
    const open = this.orders.filter((o) => o.sessionId === session.id && OPEN_STATUSES.has(o.status) && o.brokerOrderId)
    for (const order of open) {
      try {
        await this.cancelOrder(order.id)
        this.log(session, 'order', `Canceled at the end of the session: ${describeOrder(order)}.`)
      } catch (error) {
        this.log(session, 'error', `Couldn’t cancel ${describeOrder(order)}: ${errorText(error)}`)
      }
    }
  }

  private async flatten(session: TradingSession): Promise<void> {
    await this.sync()
    const holdings = this.positions.filter((p) => p.qty > 0)
    if (holdings.length === 0) return
    for (const position of holdings) {
      await this.placeOrder({ symbol: position.symbol, side: 'sell', qty: position.qty, type: 'market', reason: 'Session ended' }, 'session', { sessionId: session.id, flatten: true })
    }
  }

  private summarize(session: TradingSession): string {
    const elapsed = duration((session.endedAt ?? this.now()) - session.startedAt)
    const trades = `${session.orders} ${session.orders === 1 ? 'order' : 'orders'} in ${elapsed}`
    if (session.endEquity === null) return `${trades}. The final equity couldn’t be read from the broker.`
    const change = session.endEquity - session.startEquity
    const pct = session.startEquity > 0 ? (change / session.startEquity) * 100 : 0
    const realized = this.orders.filter((o) => o.sessionId === session.id && o.realizedPl !== null).reduce((sum, o) => sum + (o.realizedPl ?? 0), 0)
    const b = session.benchmark
    const market = b && b.end !== null && b.start > 0 ? ` ${b.symbol} moved ${signedPct(((b.end - b.start) / b.start) * 100)} over the same time.` : ''
    const exits = this.exitsNow().length
    return `${trades}. Equity ${money(session.startEquity)} → ${money(session.endEquity)} (${signedMoney(roundMoney(change))}, ${signedPct(pct)}).${
      realized !== 0 ? ` Realized ${signedMoney(roundMoney(realized))} on closed trades.` : ''
    }${market}${session.status !== 'running' && exits > 0 && this.positions.length > 0 ? ` ${exits} protective ${exits === 1 ? 'exit stays' : 'exits stay'} on while Eaon runs.` : ''}`
  }

  /** SPY now, for comparing a session with simply holding the market; null when the feed can't say. */
  private async benchmarkPrice(): Promise<number | null> {
    try {
      return (await this.deps.prices.quote(BENCHMARK)).price
    } catch {
      return null
    }
  }

  /**
   * What the market is doing, for the top of each check: SPY and QQQ today
   * (and SPY since the session began), and the tickers the strategy names. It
   * saves the agent a round of quote calls every check. Anything the feed
   * can't price is left out.
   */
  private async marketContext(session: TradingSession): Promise<string[]> {
    const held = new Set(this.positions.map((p) => p.symbol))
    const watch = tickersIn(session.strategy).filter((t) => !held.has(t) && !MARKET_INDEXES.includes(t))
    const quoteOf = (symbol: string): Promise<Quote | null> =>
      Promise.race([
        this.deps.prices.quote(symbol).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CONTEXT_TIMEOUT_MS).unref?.())
      ])
    const [indexes, watched] = await Promise.all([Promise.all(MARKET_INDEXES.map(quoteOf)), Promise.all(watch.map(quoteOf))])
    this.contextQuotes = [...indexes, ...watched].filter((q): q is Quote => q !== null)
    const lines: string[] = []
    const shown = indexes.filter((q): q is Quote => q !== null)
    if (shown.length > 0) {
      const spy = shown.find((q) => q.symbol === BENCHMARK)
      const since =
        spy && session.benchmark && session.benchmark.start > 0 ? `; ${BENCHMARK} since the session began ${signedPct(((spy.price - session.benchmark.start) / session.benchmark.start) * 100)}` : ''
      lines.push(`Market today: ${shown.map((q) => `${q.symbol} ${money(q.price)} (${signedPct(q.changePct)})`).join(' · ')}${since}.`)
    }
    const list = watched.filter((q): q is Quote => q !== null)
    if (list.length > 0) lines.push(`Watchlist: ${list.map((q) => `${q.symbol} ${money(q.price)} (${signedPct(q.changePct)})`).join(' · ')}.`)
    return lines
  }

  /** The agent's standing brief for a session. Changes only with the strategy or the limits, so the prompt stays cached. */
  private persona(session: TradingSession): string {
    const broker = BROKERS.find((b) => b.id === this.config.broker)
    return [
      `You are Eaon's trading agent. You trade US stocks and ETFs for the user in their ${broker?.label ?? 'broker'} account${
        broker?.real ? ' — real money: every loss is the user’s own money' : ' (practice money)'
      }, following their strategy, within their limits. Nobody is watching live.`,
      '',
      'The strategy, in the user’s words:',
      session.strategy,
      '',
      'How you work:',
      `- Every ${session.everyMinutes} minutes you get a check: the time, whether the market is open, the account, positions and open orders. Look, decide, act, then stop. Doing nothing is often the right call; never trade for the sake of it.`,
      '- trading_history gives trend and indicators (averages, RSI, ATR, MACD, volume) for up to 5 stocks at once, trading_scan today’s movers, trading_news a stock’s headlines, trading_quote prices, trading_account the full account and statistics.',
      '- You place orders only with trading_order, and you always say why in its reason. Never chase a price that has run away; prefer limit orders for thinly traded stocks.',
      '',
      'Risk, unless the strategy says otherwise:',
      '- Every new position gets a stop_loss in the same trading_order: under a recent swing low, or about 2×ATR below the entry. Add a take_profit or a trailing stop when the strategy has a target. Eaon sells at the stop between checks, so a position is never left unwatched.',
      `- Size from the stop: risk about 1% of equity per trade, so shares ≈ (equity × 1%) ÷ (entry − stop), then cut it to fit the limits.`,
      '- Cut losers at the stop; never average down. Raise stops on winners with trading_exits rather than selling early. Respect the market: be slower to buy when SPY and QQQ are falling.',
      this.config.broker === 'simulator' && this.config.simulatorAnytime
        ? '- The simulator fills orders even while the market is closed, at the last price, so trade as you would in market hours.'
        : '- When the market is closed, orders don’t fill: do nothing and say so.',
      '- Nobody can answer questions or approve anything: decide on your own and never ask.',
      `- Between checks Eaon watches your holdings, the tickers in the strategy and the market every few seconds. A sharp move or a holding near its stop wakes you early; those checks start with ALERT. Each check also lists what moved since the last one.`,
      '- The user may write to you during the session. Their message starts the check as MESSAGE FROM THE USER: answer it in your final line and act on it where it fits your limits.',
      '- End every check with one line: what you did and why.',
      '',
      `Your limits (orders past them are refused): ${describeLimits(this.config.limits)}.`
    ].join('\n')
  }

  /** The facts for one check: the time, the market, the account, positions and open orders. */
  private turnMessage(session: TradingSession, account: TradingAccount, now: number, market: string[] = []): string {
    const local = new Date(now).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    const lines = [`[${local} · ${formatMarketTime(now, now)}]`]
    if (account.marketOpen) {
      lines.push(`Market: open${account.nextClose ? `, closes ${formatMarketTime(account.nextClose, now)} (in ${duration(account.nextClose - now)})` : ''}.`)
    } else {
      lines.push(
        `Market: closed${account.nextOpen ? `, opens ${formatMarketTime(account.nextOpen, now)}` : ''}. The simulator is set to fill orders anyway, at the last price.`
      )
    }
    lines.push(...market)
    lines.push(
      `Session: ${duration(session.endsAt - now)} left (ends ${localTime(session.endsAt)})${session.flattenAtEnd ? '; everything is sold at the end' : ''}. Check ${session.checks + 1}; ${session.orders} ${session.orders === 1 ? 'order' : 'orders'} so far.`
    )
    const today = account.equity - account.lastEquity
    const todayPct = account.lastEquity > 0 ? (today / account.lastEquity) * 100 : 0
    const sinceStart = account.equity - session.startEquity
    lines.push(
      `Account (${brokerLabel(account.broker)}): equity ${money(account.equity)} · cash ${money(account.cash)} · buying power ${money(account.buyingPower)} · today ${signedMoney(roundMoney(today))} (${signedPct(todayPct)}) · this session ${signedMoney(roundMoney(sinceStart))}.`
    )
    if (this.positions.length === 0) lines.push('Positions: none.')
    else {
      lines.push('Positions:')
      for (const p of this.positions) {
        lines.push(
          `- ${p.symbol}: ${shares(p.qty)} @ ${money(p.avgPrice)} avg, now ${money(p.price)} = ${money(p.marketValue)} (${signedMoney(p.unrealizedPl)}, ${signedPct(p.unrealizedPlPct)}${p.dayChangePct !== null ? `; today ${signedPct(p.dayChangePct)}` : ''}) · ${
            p.exit ? describeExit(p.exit) : 'NO STOP SET'
          }`
        )
      }
    }
    const open = this.orders.filter((o) => o.broker === account.broker && OPEN_STATUSES.has(o.status))
    if (open.length > 0) {
      lines.push('Open orders:')
      for (const o of open.slice(0, 20)) lines.push(`- ${describeOrder(o)} (id ${o.id}, placed ${localTime(o.submittedAt)})`)
    }
    lines.push(`Orders today: ${this.ordersToday(account.broker)} of ${this.config.limits.maxOrdersPerDay}.`)
    lines.push(this.roomLine(account))
    lines.push('Decide what to do now, act with the trading tools, and end with one line: what you did and why.')
    return lines.join('\n')
  }

  /**
   * How big the next buy can be, worked out from the limits, so the agent
   * sizes it right the first time instead of learning the cap from a refusal.
   */
  private roomLine(account: TradingAccount): string {
    const limits = this.config.limits
    const equity = account.equity
    if (!(equity > 0)) return 'Buying room: none — the account has no equity.'
    const floor = account.lastEquity * (1 - limits.maxDailyLossPct / 100)
    if (account.lastEquity > 0 && equity < floor) return `Buying room: none today — equity is past the ${limits.maxDailyLossPct}% daily loss limit. Selling is still allowed.`
    const invested = this.positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0)
    const investRoom = Math.max(0, (equity * limits.maxInvestedPct) / 100 - invested)
    const perStock = (equity * limits.maxPositionPct) / 100
    const largest = Math.min(limits.maxOrderUsd, investRoom, perStock, account.buyingPower)
    return `Buying room: the next buy can be at most ${money(roundMoney(largest))} (per order ${money(limits.maxOrderUsd)}; ${money(roundMoney(investRoom))} left before ${limits.maxInvestedPct}% invested; ${money(roundMoney(perStock))} in any one stock). 1% of equity, the usual risk per trade, is ${money(roundMoney(equity / 100))}.`
  }

  private workFolder(settings: Settings): string {
    return this.deps.workFolder?.() ?? join(settings.work.defaultFolder || join(homedir(), 'Eaon'), 'Trading')
  }

  /* ----------------------------------------------------------- refreshing */

  private fastRefresh(): boolean {
    return this.active !== null || this.deskOpen || this.now() - this.deskSeenAt < DESK_SEEN_MS || this.exitsLive()
  }

  /** An exit could fire now: one is set on the selected broker and orders would fill. */
  private exitsLive(): boolean {
    const kind = this.config.broker
    if (Object.keys(this.exits[kind] ?? {}).length === 0) return false
    return Boolean(this.account?.marketOpen) || (kind === 'simulator' && this.config.simulatorAnytime)
  }

  private armRefresh(delay?: number): void {
    if (!this.started || this.disposed) return
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    const fast = this.exitsLive() ? Math.min(this.deps.exitRefreshMs ?? 15_000, this.deps.refreshFastMs ?? 30_000) : (this.deps.refreshFastMs ?? 30_000)
    const wait = delay ?? (this.fastRefresh() ? fast : (this.deps.refreshSlowMs ?? 5 * 60_000))
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.sync().finally(() => this.armRefresh())
    }, wait)
    this.refreshTimer.unref?.()
  }

  /**
   * One refresh at a time. A caller arriving while one is in flight gets the
   * one queued after it, so a change it just made (a fill) is always seen.
   */
  private sync(): Promise<void> {
    if (!this.syncing) {
      this.syncing = this.doSync().finally(() => {
        this.syncing = null
      })
      return this.syncing
    }
    if (!this.syncQueued) {
      this.syncQueued = this.syncing.then(() => {
        this.syncQueued = null
        return this.sync()
      })
    }
    return this.syncQueued
  }

  private async doSync(): Promise<void> {
    const kind = this.config.broker
    const epoch = this.epoch
    const broker = this.broker(kind)
    if (!broker) {
      this.account = null
      this.positions = []
      this.error = this.missingKeys(kind)
      this.changed()
      return
    }
    try {
      await broker.settle?.()
      const [account, positions, orders, clock] = await Promise.all([broker.account(), broker.positions(), broker.orders(100), broker.clock()])
      if (this.config.broker !== kind || this.epoch !== epoch) return // the account changed meanwhile; the next refresh covers it
      if (this.mergeOrders(kind, orders)) this.deps.saveOrders(this.orders)
      const track = this.track(kind)
      if (kind === 'simulator') track.start = this.simulator.startingCash
      else if (track.start === null) track.start = account.equity
      if (!track.seeded && broker.history) {
        track.seeded = true
        await this.seedHistory(track, broker)
      }
      this.account = {
        broker: kind,
        equity: account.equity,
        cash: account.cash,
        buyingPower: account.buyingPower,
        lastEquity: account.lastEquity,
        startingEquity: track.start ?? account.equity,
        marketOpen: clock.isOpen,
        nextOpen: clock.nextOpen,
        nextClose: clock.nextClose,
        updatedAt: this.now()
      }
      this.positions = positions.map((p) => {
        const cost = Math.abs(p.qty) * p.avgPrice
        return { ...p, unrealizedPlPct: cost > 0 ? Math.round((p.unrealizedPl / cost) * 10_000) / 100 : 0, exit: this.exits[kind]?.[p.symbol] ?? null }
      })
      this.recordEquity(kind, account.equity)
      if (!this.exitWork) {
        this.exitWork = this.watchExits(kind).finally(() => {
          this.exitWork = null
        })
      }
      this.error = account.blocked ? `${brokerLabel(kind)} has blocked trading on this account (status: ${account.status || 'unknown'}). Check your Alpaca dashboard.` : null
    } catch (error) {
      if (this.config.broker === kind && this.epoch === epoch) this.error = errorText(error)
    }
    this.changed()
  }

  /** Alpaca's last month of equity, so a newly connected account's chart doesn't start empty. */
  private async seedHistory(track: EquityTrack, broker: Broker): Promise<void> {
    try {
      const history = await broker.history!()
      const first = track.points[0]?.at ?? Infinity
      const earlier = history.filter((p) => p.at < first)
      if (earlier.length > 0) {
        track.points = [...earlier, ...track.points]
        this.saveEquityLater()
      }
    } catch {
      /* the chart simply starts now */
    }
  }

  private track(kind: BrokerKind): EquityTrack {
    let track = this.equity[kind]
    if (!track) {
      track = { start: null, points: [] }
      this.equity[kind] = track
    }
    return track
  }

  /**
   * A point per minute at most: a refresh within the same minute as the last
   * point replaces it. Past the cap, the older half is thinned to every other
   * point, so the recent past stays detailed and the distant past coarse.
   */
  private recordEquity(kind: BrokerKind, equity: number): void {
    if (!(equity > 0)) return
    const track = this.track(kind)
    const now = this.now()
    const last = track.points[track.points.length - 1]
    if (last && Math.floor(last.at / 60_000) === Math.floor(now / 60_000)) {
      last.at = now
      last.equity = equity
    } else {
      track.points.push({ at: now, equity })
    }
    while (track.points.length > MAX_EQUITY_POINTS) {
      const half = Math.floor(track.points.length / 2)
      track.points = [...track.points.slice(0, half).filter((_, i) => i % 2 === 0), ...track.points.slice(half)]
    }
    this.saveEquityLater()
  }

  private saveEquityLater(): void {
    if (this.equitySaveTimer || this.disposed) return
    this.equitySaveTimer = setTimeout(() => this.flushEquity(), EQUITY_SAVE_DELAY_MS)
    this.equitySaveTimer.unref?.()
  }

  private flushEquity(): void {
    if (this.equitySaveTimer) clearTimeout(this.equitySaveTimer)
    this.equitySaveTimer = null
    this.deps.saveEquity(this.equity)
  }

  /* -------------------------------------------------------------- brokers */

  private makeAlpaca(kind: AlpacaKind, keys: AlpacaKeys): Broker {
    return this.deps.createBroker?.(kind, keys) ?? new AlpacaBroker({ kind, keys })
  }

  /** The broker for an account, or null when it needs keys that aren't saved. */
  private broker(kind: BrokerKind = this.config.broker): Broker | null {
    if (kind === 'simulator') return this.simulator
    const cached = this.alpaca.get(kind)
    if (cached) return cached
    const keys = this.deps.getKeys(kind === 'alpaca-live' ? 'live' : 'paper')
    if (!keys) return null
    const broker = this.makeAlpaca(kind, keys)
    this.alpaca.set(kind, broker)
    return broker
  }

  private missingKeys(kind: BrokerKind): string {
    return `Add your Alpaca ${kind === 'alpaca-live' ? 'live' : 'paper'} keys on the trading desk to use ${brokerLabel(kind)}.`
  }

  /** What the guardrails need, fresh from the broker. */
  private async limitState(broker: Broker, symbol: string): Promise<{ account: { equity: number; lastEquity: number }; positions: TradingPosition[]; price: number; blocked: string | null }> {
    const [account, positions, quote] = await Promise.all([broker.account(), broker.positions(), this.deps.prices.quote(symbol)])
    return {
      account,
      positions: positions.map((p) => ({ ...p, unrealizedPlPct: 0, exit: null })),
      price: quote.price,
      blocked: account.blocked ? `${brokerLabel(broker.kind)} has blocked trading on this account (status: ${account.status || 'unknown'}). Check your Alpaca dashboard.` : null
    }
  }

  /* --------------------------------------------------------------- ledger */

  private ordersToday(kind: BrokerKind): number {
    const since = startOfLocalDay(this.now())
    return this.orders.filter((o) => o.broker === kind && o.brokerOrderId !== null && o.submittedAt >= since).length
  }

  private addOrder(entry: StoredOrder): void {
    if (!this.orders.includes(entry)) this.orders.unshift(entry)
    if (this.orders.length > MAX_ORDERS_KEPT) {
      // Refusals and orders that never filled go first; fills carry the cost basis of later sells.
      const unfilled = (o: StoredOrder): boolean => o.filledQty === 0 && !OPEN_STATUSES.has(o.status)
      let excess = this.orders.length - MAX_ORDERS_KEPT
      for (let i = this.orders.length - 1; i >= 0 && excess > 0; i--) {
        if (unfilled(this.orders[i])) {
          this.orders.splice(i, 1)
          excess--
        }
      }
      if (excess > 0) this.orders.splice(this.orders.length - excess, excess)
    }
    this.deps.saveOrders(this.orders)
  }

  /** Folds the broker's view of its orders into the ledger, keeping who placed each and why. */
  private mergeOrders(kind: BrokerKind, incoming: BrokerOrder[]): boolean {
    let changed = false
    for (const order of incoming) {
      let entry = this.orders.find(
        (o) => o.broker === kind && (o.brokerOrderId === order.id || (order.clientOrderId !== null && o.clientOrderId === order.clientOrderId))
      )
      if (!entry) {
        // Placed outside Eaon (Alpaca's dashboard, another app): the user's, with no reason recorded.
        entry = {
          id: order.clientOrderId?.startsWith('eaon-') ? order.clientOrderId : `${kind}:${order.id}`,
          broker: kind,
          brokerOrderId: order.id,
          clientOrderId: order.clientOrderId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          qty: order.qty,
          notional: order.notional,
          limitPrice: order.limitPrice,
          status: order.status,
          filledQty: order.filledQty,
          filledAvgPrice: order.filledAvgPrice,
          submittedAt: order.submittedAt,
          filledAt: order.filledAt,
          realizedPl: null,
          source: 'user',
          sessionId: null,
          reason: '',
          error: order.error
        }
        this.orders.push(entry)
        changed = true
        continue
      }
      changed = applyBrokerOrder(entry, order) || changed
    }
    if (changed) this.orders.sort((a, b) => b.submittedAt - a.submittedAt)
    const realized = realizeFifo(this.orders.filter((o) => o.broker === kind))
    return changed || realized
  }

  /* -------------------------------------------------------------- logging */

  private log(session: TradingSession, kind: TradingLogEntry['kind'], text: string, save = true): void {
    session.log.push({ at: this.now(), kind, text })
    if (session.log.length > MAX_LOG) session.log.splice(0, session.log.length - MAX_LOG)
    if (save) {
      this.deps.saveSessions(this.sessions)
      this.changed()
    }
  }

  private trimSessions(): void {
    if (this.sessions.length <= MAX_SESSIONS) return
    const running = this.sessions.filter((s) => s.status === 'running')
    const rest = this.sessions.filter((s) => s.status !== 'running').slice(0, MAX_SESSIONS - running.length)
    this.sessions = [...running, ...rest].sort((a, b) => b.startedAt - a.startedAt)
  }

  private changed(): void {
    if (this.disposed) return
    try {
      this.deps.onChange?.()
    } catch (error) {
      console.error('[trading] change listener failed:', error)
    }
  }
}

/** Copies the broker's facts onto a ledger entry; whether anything changed. */
function applyBrokerOrder(entry: StoredOrder, order: BrokerOrder): boolean {
  const before = JSON.stringify(entry)
  entry.brokerOrderId = order.id
  entry.clientOrderId = order.clientOrderId ?? entry.clientOrderId
  entry.symbol = order.symbol || entry.symbol
  entry.side = order.side
  entry.type = order.type
  if (order.qty > 0) entry.qty = order.qty
  entry.notional = order.notional ?? entry.notional
  entry.limitPrice = order.limitPrice
  entry.status = order.status
  entry.filledQty = order.filledQty
  entry.filledAvgPrice = order.filledAvgPrice
  entry.submittedAt = order.submittedAt
  entry.filledAt = order.filledAt
  entry.error = order.error ?? entry.error
  return JSON.stringify(entry) !== before
}
