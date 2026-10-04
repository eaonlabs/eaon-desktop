import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultSettings } from '@main/store'
import { brokerLabel, describeOrder, money, signedMoney, signedPct, TradingEngine } from '@main/features/trading/engine'
import { YahooMarketData } from '@main/features/trading/marketData'
import type { Quote, TradingOrder, TradingSnapshot } from '@shared/trading'
import type { Worker } from '@shared/workers'
import { cliHome } from '../runtime/paths'

/**
 * Plain-text views of Eaon's desk, quotes and workers for sessions that
 * aren't Eaon — what the MCP bridge hands Claude Code or Codex. Read-only on
 * purpose: nothing here can place an order or wake a worker.
 */

const TRADING_FILES = {
  config: 'trading-config.json',
  orders: 'trading-orders.json',
  equity: 'trading-equity.json',
  schedules: 'trading-schedules.json',
  sessions: 'trading-sessions.json',
  sim: 'trading-sim.json',
  exits: 'trading-exits.json'
}

function readStore(name: string, fallback: unknown): unknown {
  try {
    const file = join(cliHome(), 'store', name)
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback
  } catch {
    return fallback
  }
}

/**
 * The desk as the CLI last saved it, for when no session runs the engines.
 * The engine is loaded and asked for a snapshot only: never started (that
 * would resume a session) and never refreshed (refreshing fires protective
 * exits, which sell). Null when the profile has never traded.
 */
export function localTradingSnapshot(): TradingSnapshot | null {
  const dir = join(cliHome(), 'store')
  if (!Object.values(TRADING_FILES).some((name) => existsSync(join(dir, name)))) return null
  const noop = (): void => {}
  const engine = new TradingEngine({
    prices: new YahooMarketData(),
    runAgent: async () => ({ text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    getSettings: () => defaultSettings,
    getKeys: () => null,
    saveKeys: noop,
    loadConfig: () => readStore(TRADING_FILES.config, null),
    saveConfig: noop,
    loadOrders: () => readStore(TRADING_FILES.orders, []),
    saveOrders: noop,
    loadEquity: () => readStore(TRADING_FILES.equity, {}),
    saveEquity: noop,
    loadSchedules: () => readStore(TRADING_FILES.schedules, []),
    saveSchedules: noop,
    loadSessions: () => readStore(TRADING_FILES.sessions, []),
    saveSessions: noop,
    loadSim: () => readStore(TRADING_FILES.sim, null),
    saveSim: noop,
    loadExits: () => readStore(TRADING_FILES.exits, {}),
    saveExits: noop
  })
  engine.load()
  return engine.snapshot()
}

const OPEN = new Set<TradingOrder['status']>(['pending', 'open', 'partially_filled'])

function orderLine(order: TradingOrder): string {
  const when = new Date(order.submittedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const fill = order.filledAvgPrice !== null ? ` @ ${money(order.filledAvgPrice)}` : ''
  const pl = order.realizedPl !== null ? `, realised ${signedMoney(order.realizedPl)}` : ''
  const why = order.error ? ` — refused: ${order.error}` : order.reason ? ` — ${order.reason}` : ''
  return `- ${when} ${describeOrder(order)}: ${order.status}${fill}${pl} (${order.source})${why}`
}

/** A readable summary of the desk. `live` false notes that the figures are from the last save. */
export function formatTradingSummary(snapshot: TradingSnapshot, live: boolean): string {
  const lines: string[] = []
  const broker = brokerLabel(snapshot.config.broker)
  const real = snapshot.config.broker === 'alpaca-live' ? ' (real money)' : ''
  lines.push(`Broker: ${broker}${real}${snapshot.config.halted ? ' — kill switch ON, no orders' : ''}`)
  if (!live) lines.push("Eaon isn't running, so these figures are from its last save.")
  const lastPoint = snapshot.equity[snapshot.equity.length - 1]
  const equity = snapshot.account?.equity ?? lastPoint?.equity ?? null
  if (equity !== null) {
    const cash = snapshot.account ? `, cash ${money(snapshot.account.cash)}` : ''
    lines.push(`Equity ${money(equity)}${cash}`)
  }
  const s = snapshot.stats
  lines.push(
    `Today ${signedMoney(s.todayReturn)} (${signedPct(s.todayReturnPct)}), total ${signedMoney(s.totalReturn)} (${signedPct(s.totalReturnPct)}); ` +
      `${s.trades} closed trades, win rate ${Math.round(s.winRate * 100)}%, max drawdown ${s.maxDrawdownPct.toFixed(1)}%`
  )
  if (snapshot.positions.length > 0) {
    lines.push('Positions:')
    for (const p of snapshot.positions) {
      lines.push(`- ${p.symbol} ${Number(p.qty.toFixed(4))} @ avg ${money(p.avgPrice)}, last ${money(p.price)}, P&L ${signedMoney(p.unrealizedPl)} (${signedPct(p.unrealizedPlPct)})`)
    }
  } else if (live) {
    lines.push('No positions.')
  }
  const open = snapshot.orders.filter((o) => OPEN.has(o.status))
  if (open.length > 0) lines.push('Open orders:', ...open.map(orderLine))
  const session = snapshot.activeSession
  if (session) {
    const ends = new Date(session.endsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    lines.push(`Trading session running: “${session.strategy}”, ${session.checks} checks, ${session.orders} orders, ends ${ends}.`)
  } else {
    lines.push('No trading session is running.')
  }
  const recent = snapshot.orders.slice(0, 5)
  if (recent.length > 0) lines.push('Latest orders:', ...recent.map(orderLine))
  if (snapshot.error) lines.push(`Problem: ${snapshot.error}`)
  return lines.join('\n')
}

export function formatQuote(quote: Quote): string {
  const name = quote.name ? `  ${quote.name}` : ''
  const sign = quote.change > 0 ? '+' : ''
  return `${quote.symbol}  ${money(quote.price)}  ${sign}${quote.change.toFixed(2)} (${signedPct(quote.changePct)})${name}`
}

export function formatWorkers(workers: Worker[]): string {
  if (workers.length === 0) return 'No workers yet.'
  return workers
    .map((w) => {
      const next = w.heartbeat.nextAt ? `, next wakes ${new Date(w.heartbeat.nextAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''
      const activity = w.activity ? ` — ${w.activity}` : ''
      const trading = w.trading ? ', trades' : ''
      return `- ${w.name}: ${w.paused ? 'paused' : w.status}${trading}${activity}${next}${w.unread ? `, ${w.unread} unread` : ''}`
    })
    .join('\n')
}
