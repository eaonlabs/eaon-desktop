import { BROKERS, isRealMoney, type Bar, type BarRange, type TradingSnapshot } from '@shared/trading'
import type { AgentTool, ToolContext, ToolSource } from '../../agent/tools'
import { parseWakeTime } from '../workers/tools'
import {
  brokerLabel,
  describeExit,
  describeLimits,
  describeOrder,
  duration,
  money,
  orderOutcome,
  sessionIdOf,
  signedMoney,
  signedPct,
  type TradingEngine
} from './engine'
import { TRADING_DESK } from '@shared/workers'
import { tradingFor } from './access'
import { formatMarketTime } from './marketHours'
import { BAR_RANGES, indicators, RANGE_INTERVAL, SCREEN_KINDS, type ScreenKind } from './marketData'

/**
 * The agent's trading tools, offered to the main agent in Work mode (a chat,
 * a worker, or a trading session's own turns):
 *
 * - `trading_account`, `trading_quote`, `trading_history`, `trading_scan` and
 *   `trading_news` only look.
 * - `trading_order` goes through the engine's guardrails like every order.
 *   It is risky, so a chat in "Ask" or "Approve for me" asks the user first;
 *   and on Alpaca live it is catastrophic outside a trading session, so real
 *   money placed from a chat is never placed without the user, however
 *   autonomous the run. An armed session (`trading:<id>` chat) may trade
 *   within its limits — that is what the user set it up to do.
 * - `trading_exits` sets the stop-loss, take-profit or trailing stop Eaon
 *   watches on a holding (an order can set them as it buys).
 * - `trading_session` starts, stops, schedules and reports on sessions.
 *
 * Descriptions are short on purpose: they are sent with every request.
 */

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const num = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** Tickers from `symbols` (array or "A, B") or a lone `symbol`, as models send them. */
function tickers(input: Record<string, unknown>): string[] {
  const list = Array.isArray(input.symbols) ? input.symbols : typeof input.symbols === 'string' ? input.symbols.split(/[\s,]+/) : [input.symbol]
  return [...new Set(list.map(str).filter(Boolean).map((t) => t.toUpperCase()))]
}

/** The scanner skips what a limit-bound account shouldn't chase: sub-$5 shares and companies under $2B. */
const MIN_SCAN_PRICE = 5
const MIN_SCAN_CAP = 2_000_000_000
const capText = (cap: number): string => (cap >= 1e12 ? `$${(cap / 1e12).toFixed(1)}T` : cap >= 1e9 ? `$${Math.round(cap / 1e9)}B` : `$${Math.round(cap / 1e6)}M`)

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const WEEKDAYS = [1, 2, 3, 4, 5]

/** Days as a model writes them: [1,2,3], ["mon","tue"], "weekdays", "every day". Weekdays when unset. */
export function parseDays(value: unknown): number[] {
  if (value === undefined || value === null || value === '') return WEEKDAYS
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (/^(weekdays?|mon(day)?\s*[-–]\s*fri(day)?)$/.test(text)) return WEEKDAYS
    if (/^(every ?day|daily|all)$/.test(text)) return [0, 1, 2, 3, 4, 5, 6]
    return parseDays(text.split(/[\s,]+/))
  }
  if (!Array.isArray(value)) return []
  const days = new Set<number>()
  for (const item of value) {
    const n = num(item)
    if (n !== undefined && Number.isInteger(n) && n >= 0 && n <= 6) days.add(n)
    else if (typeof item === 'string') {
      const index = DAY_NAMES.indexOf(item.trim().toLowerCase().slice(0, 3))
      if (index !== -1) days.add(index)
    }
  }
  return [...days].sort()
}

function describeDays(days: number[]): string {
  const key = days.join(',')
  if (key === '1,2,3,4,5') return 'weekdays'
  if (key === '0,1,2,3,4,5,6') return 'every day'
  return days.map((d) => DAY_NAMES[d][0].toUpperCase() + DAY_NAMES[d].slice(1)).join(', ')
}

const localTime = (at: number): string => new Date(at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })

/** The account in a compact few lines: what a model needs to decide, nothing more. */
export function accountText(snap: TradingSnapshot, now = Date.now()): string {
  const broker = BROKERS.find((b) => b.id === snap.config.broker)
  const lines = [`Broker: ${broker?.label ?? snap.config.broker}${broker?.real ? ' — REAL MONEY' : ' (practice money)'}`]
  if (snap.config.halted) lines.push('TRADING IS HALTED: the kill switch is on, so every order is refused.')
  if (snap.error) lines.push(`Problem: ${snap.error}`)
  const a = snap.account
  if (a) {
    const market = a.marketOpen
      ? `open${a.nextClose ? `, closes ${formatMarketTime(a.nextClose, now)}` : ''}`
      : `closed${a.nextOpen ? `, opens ${formatMarketTime(a.nextOpen, now)}` : ''}`
    lines.push(`Equity ${money(a.equity)} · cash ${money(a.cash)} · buying power ${money(a.buyingPower)} · market ${market}`)
    lines.push(`Today ${signedMoney(snap.stats.todayReturn)} (${signedPct(snap.stats.todayReturnPct)}) · since start ${signedMoney(snap.stats.totalReturn)} (${signedPct(snap.stats.totalReturnPct)})`)
  }
  if (snap.positions.length === 0) lines.push('Positions: none')
  else {
    lines.push(`Positions (${snap.positions.length}):`)
    for (const p of snap.positions) {
      lines.push(
        `- ${p.symbol}: ${p.qty} @ ${money(p.avgPrice)} avg, now ${money(p.price)} = ${money(p.marketValue)} (${signedMoney(p.unrealizedPl)}, ${signedPct(p.unrealizedPlPct)}${
          p.dayChangePct !== null ? `; today ${signedPct(p.dayChangePct)}` : ''
        }) · ${p.exit ? describeExit(p.exit) : 'no stop'}`
      )
    }
  }
  const open = snap.orders.filter((o) => o.status === 'open' || o.status === 'pending' || o.status === 'partially_filled')
  if (open.length > 0) {
    lines.push('Open orders:')
    for (const o of open.slice(0, 20)) lines.push(`- ${describeOrder(o)} (id ${o.id})`)
  }
  const s = snap.stats
  lines.push(
    `Stats: ${s.trades} closed trades${s.trades > 0 ? `, ${Math.round(s.winRate * 100)}% won` : ''} · realized ${signedMoney(s.realizedPl)} · unrealized ${signedMoney(s.unrealizedPl)} · max drawdown ${s.maxDrawdownPct}%${
      s.sharpe !== null ? ` · Sharpe ${s.sharpe}` : ''
    } · ${s.investedPct}% invested · ${s.ordersToday}/${snap.config.limits.maxOrdersPerDay} orders today`
  )
  const session = snap.activeSession
  lines.push(
    session
      ? `Session running: "${session.name}" until ${localTime(session.endsAt)}, a check every ${session.everyMinutes} min (${session.checks} checks, ${session.orders} orders so far).`
      : 'No trading session is running.'
  )
  lines.push(`Limits: ${describeLimits(snap.config.limits)}.`)
  return lines.join('\n')
}

function barTime(bar: Bar, intraday: boolean): string {
  return new Date(bar.t).toLocaleString('en-US', intraday ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' })
}

const vsPrice = (price: number, level: number | null): string => (level === null ? 'n/a' : `${money(level)} (price ${signedPct(((price - level) / level) * 100)} vs it)`)

function sessionStatus(engine: TradingEngine): string {
  const snap = engine.snapshot()
  const lines: string[] = []
  const active = snap.activeSession
  if (active) {
    lines.push(
      `Running: "${active.name}" since ${localTime(active.startedAt)}, until ${localTime(active.endsAt)} (${duration(active.endsAt - Date.now())} left); a check every ${active.everyMinutes} min; ${active.checks} checks, ${active.orders} orders.${active.flattenAtEnd ? ' Sells everything at the end.' : ''}`,
      `Strategy: ${active.strategy}`
    )
    const recent = active.log.slice(-5)
    if (recent.length > 0) lines.push('Latest:', ...recent.map((e) => `- [${e.kind}] ${e.text}`))
  } else lines.push('No session is running.')
  if (snap.schedules.length > 0) {
    lines.push('Schedules:')
    for (const s of snap.schedules) {
      lines.push(`- ${s.name}: ${describeDays(s.days)} ${s.start}–${s.end}, every ${s.everyMinutes} min${s.flattenAtEnd ? ', sells all at the end' : ''}${s.enabled ? '' : ' (off)'}`)
    }
  }
  const past = snap.sessions.filter((s) => s.status !== 'running').slice(0, 3)
  if (past.length > 0) lines.push('Recent sessions:', ...past.map((s) => `- ${s.name} (${s.status}): ${s.summary ?? s.error ?? ''}`))
  return lines.join('\n')
}

export function tradingToolSource(engine: TradingEngine): ToolSource {
  const live = (): boolean => isRealMoney(engine.brokerKind)
  const fromSession = (ctx: ToolContext): boolean => sessionIdOf(ctx.request.chatId) !== null

  const account: AgentTool = {
    name: 'trading_account',
    description: 'Your trading account: equity, cash, positions, open orders, P&L statistics, the running session and the limits.',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    run: async () => accountText(await engine.refresh())
  }

  const quote: AgentTool = {
    name: 'trading_quote',
    description: 'Current price and today’s move for up to 10 US stocks or ETFs.',
    inputSchema: {
      type: 'object',
      properties: { symbols: { type: 'array', items: { type: 'string' }, description: 'Tickers, e.g. ["AAPL", "SPY"]' } },
      required: ['symbols']
    },
    mutating: false,
    describe: (input) => (Array.isArray(input.symbols) ? input.symbols.join(', ') : str(input.symbol)),
    run: async (input) => {
      const list = Array.isArray(input.symbols) ? input.symbols : typeof input.symbols === 'string' ? input.symbols.split(/[\s,]+/) : [input.symbol]
      const symbols = list.map(str).filter(Boolean).slice(0, 10)
      if (symbols.length === 0) throw new Error('Give at least one ticker in symbols, like ["AAPL"].')
      const results = await Promise.all(
        symbols.map(async (symbol) => {
          try {
            const q = await engine.quote(symbol)
            const range = q.dayLow !== null && q.dayHigh !== null ? ` · day ${money(q.dayLow)}–${money(q.dayHigh)}` : ''
            const volume = q.volume !== null ? ` · volume ${q.volume.toLocaleString('en-US')}` : ''
            return `${q.symbol}${q.name ? ` (${q.name})` : ''}: ${money(q.price)}, ${signedPct(q.changePct)} today (${signedMoney(q.change)})${range}${volume} · as of ${formatMarketTime(q.at)}`
          } catch (error) {
            return `${symbol.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`
          }
        })
      )
      return results.join('\n')
    }
  }

  const history: AgentTool = {
    name: 'trading_history',
    description:
      'Trend and indicators for up to 5 US stocks or ETFs over a range: moving averages, RSI, ATR (typical move per bar), MACD momentum, volume vs average, the range high and low.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' }, description: 'Tickers, e.g. ["NVDA", "AMD"]' },
        range: { type: 'string', enum: BAR_RANGES, description: 'Default 6mo, daily bars (use it for 20/50-day averages); 1d and 5d are intraday bars' }
      },
      required: ['symbols']
    },
    mutating: false,
    describe: (input) => `${tickers(input).join(', ')} ${str(input.range) || '6mo'}`,
    run: async (input) => {
      const range = (BAR_RANGES.includes(input.range as BarRange) ? input.range : '6mo') as BarRange
      const symbols = tickers(input).slice(0, 5)
      if (symbols.length === 0) throw new Error('Give at least one ticker in symbols, like ["AAPL"].')
      const intraday = range === '1d' || range === '5d'
      // Say which: a model asked for "the 50-day average" must not read 50 five-minute bars as one.
      const unit = (n: number): string => (intraday ? `${n}-bar (${RANGE_INTERVAL[range].replace('m', '-min')})` : `${n}-day`)
      const blocks = await Promise.all(
        symbols.map(async (raw) => {
          const symbol = raw.toUpperCase()
          try {
            const bars = await engine.bars(symbol, range)
            const s = indicators(bars)
            if (!s) return `${symbol}: no trading over ${range}.`
            const momentum =
              s.macdHist === null ? 'n/a' : `${s.macdHist > 0 ? 'positive' : 'negative'}, ${s.macdHistPrev !== null && Math.abs(s.macdHist) > Math.abs(s.macdHistPrev) ? 'strengthening' : 'fading'}`
            const lines = [
              `${symbol} over ${range} (${s.bars} ${intraday ? 'intraday' : 'daily'} bars): last ${money(s.last)}, ${signedPct(s.changePct)} over the range; range high ${money(s.high)} (${signedPct(((s.last - s.high) / s.high) * 100)}), low ${money(s.low)}.`,
              `${unit(20)} avg ${vsPrice(s.last, s.sma20)} · ${unit(50)} avg ${vsPrice(s.last, s.sma50)} · RSI14 ${s.rsi14 ?? 'n/a'} · ATR14 ${s.atr14 !== null ? `${money(s.atr14)} (${((s.atr14 / s.last) * 100).toFixed(1)}% of price)` : 'n/a'} · MACD ${momentum} · last bar volume ${s.volumeRatio !== null ? `${s.volumeRatio}× its 20-bar average` : 'n/a'} · last-20-bar high ${money(s.high20)}, low ${money(s.low20)}.`
            ]
            // The raw closes only when looking at one stock: five stocks' worth is noise.
            if (symbols.length === 1) lines.push(`Recent closes: ${bars.slice(-10).map((b) => `${barTime(b, intraday)} ${money(b.c)}`).join(', ')}`)
            return lines.join('\n')
          } catch (error) {
            return `${symbol}: ${error instanceof Error ? error.message : String(error)}`
          }
        })
      )
      return blocks.join('\n')
    }
  }

  const scan: AgentTool = {
    name: 'trading_scan',
    description: 'Today’s biggest US stock movers — gainers, losers or most active — with relative volume, to find what to trade. Skips penny stocks and tiny companies.',
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'string', enum: SCREEN_KINDS, description: 'Default gainers' },
        count: { type: 'number', description: 'Default 10, at most 25' }
      }
    },
    mutating: false,
    describe: (input) => `Market ${str(input.list) || 'gainers'}`,
    run: async (input) => {
      const kind = (SCREEN_KINDS.includes(input.list as ScreenKind) ? input.list : 'gainers') as ScreenKind
      const count = Math.max(1, Math.min(25, Math.round(num(input.count) ?? 10)))
      const rows = (await engine.screen(kind, 100)).filter((r) => r.price >= MIN_SCAN_PRICE && (r.marketCap === null || r.marketCap >= MIN_SCAN_CAP)).slice(0, count)
      if (rows.length === 0) return `No ${kind} above ${money(MIN_SCAN_PRICE)} a share and ${capText(MIN_SCAN_CAP)} market value right now.`
      return [
        `Today’s ${kind} (over ${money(MIN_SCAN_PRICE)} a share and ${capText(MIN_SCAN_CAP)} market value):`,
        ...rows.map(
          (r) =>
            `- ${r.symbol}${r.name ? ` (${r.name})` : ''}: ${money(r.price)}, ${signedPct(r.changePct)}${r.relativeVolume !== null ? ` · volume ${r.relativeVolume}× normal` : ''}${r.marketCap ? ` · ${capText(r.marketCap)}` : ''}`
        )
      ].join('\n')
    }
  }

  const news: AgentTool = {
    name: 'trading_news',
    description: 'The latest headlines about up to 3 stocks, newest first, with how old each is.',
    inputSchema: {
      type: 'object',
      properties: { symbols: { type: 'array', items: { type: 'string' }, description: 'Tickers, e.g. ["TSLA"]' } },
      required: ['symbols']
    },
    mutating: false,
    describe: (input) => tickers(input).join(', '),
    run: async (input) => {
      const symbols = tickers(input).slice(0, 3)
      if (symbols.length === 0) throw new Error('Give at least one ticker in symbols, like ["TSLA"].')
      const now = Date.now()
      const blocks = await Promise.all(
        symbols.map(async (raw) => {
          const symbol = raw.toUpperCase()
          try {
            const items = await engine.news(symbol, 6)
            if (items.length === 0) return `${symbol}: no recent headlines.`
            return [`${symbol}:`, ...items.map((h) => `- ${h.title}${h.publisher ? ` (${h.publisher})` : ''} · ${h.at ? `${duration(Math.max(0, now - h.at))} ago` : 'undated'}`)].join('\n')
          } catch (error) {
            return `${symbol}: ${error instanceof Error ? error.message : String(error)}`
          }
        })
      )
      return blocks.join('\n')
    }
  }

  const order: AgentTool = {
    name: 'trading_order',
    description: 'Buy or sell a US stock or ETF. Checked against the user’s limits first. Give shares (qty) or dollars (notional, market orders only), and always a reason.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        qty: { type: 'number', description: 'Shares; fractions allowed' },
        notional: { type: 'number', description: 'Dollars, instead of qty' },
        type: { type: 'string', enum: ['market', 'limit'], description: 'Default market' },
        limit_price: { type: 'number' },
        stop_loss: { type: 'number', description: 'Buys: sell if the price falls to this' },
        take_profit: { type: 'number', description: 'Buys: sell if the price rises to this' },
        trailing_stop_pct: { type: 'number', description: 'Buys: sell if the price falls this % below its high since buying' },
        reason: { type: 'string', description: 'Why, in a sentence; shown to the user' }
      },
      required: ['symbol', 'side', 'reason']
    },
    mutating: true,
    risky: () => true,
    catastrophic: (_input, ctx) => {
      if (fromSession(ctx)) return false
      // A worker the user set up to trade on the desk: its "place orders on
      // its own" switch decides, practice money or real.
      const plan = tradingFor(ctx.request.chatId)
      if (plan && plan.via === TRADING_DESK) return !plan.autoPlace
      return live()
    },
    describe: (input) =>
      `${describeOrder({ side: input.side, symbol: input.symbol, qty: input.qty, notional: input.notional, type: input.type ?? (input.limit_price !== undefined ? 'limit' : 'market'), limitPrice: input.limit_price })}${live() ? ' (real money)' : ''}`,
    run: async (input, ctx) => {
      if (!str(input.reason)) throw new Error('Give a reason for the order in one sentence. It is shown to the user next to it.')
      const sessionId = sessionIdOf(ctx.request.chatId)
      const placed = await engine.placeOrder(
        {
          symbol: str(input.symbol),
          side: input.side as 'buy' | 'sell',
          ...(input.qty !== undefined ? { qty: num(input.qty) } : {}),
          ...(input.notional !== undefined ? { notional: num(input.notional) } : {}),
          ...(input.type !== undefined ? { type: input.type as 'market' | 'limit' } : {}),
          ...(input.limit_price !== undefined ? { limitPrice: num(input.limit_price) } : {}),
          ...(input.stop_loss !== undefined ? { stopLoss: num(input.stop_loss) ?? NaN } : {}),
          ...(input.take_profit !== undefined ? { takeProfit: num(input.take_profit) ?? NaN } : {}),
          ...(input.trailing_stop_pct !== undefined ? { trailPct: num(input.trailing_stop_pct) ?? NaN } : {}),
          reason: str(input.reason)
        },
        sessionId ? 'session' : 'agent',
        { sessionId }
      )
      if (placed.status === 'rejected') return orderOutcome(placed)
      const exit = engine.exitsNow().find((e) => e.symbol === placed.symbol)
      return `${orderOutcome(placed)} Order id: ${placed.id}.${exit ? ` Protected: ${describeExit(exit)}.` : placed.side === 'buy' ? ' No stop is set on it.' : ''}`
    }
  }

  const exits: AgentTool = {
    name: 'trading_exits',
    description:
      'The protective exit on a holding, which Eaon watches and sells at market between checks: stop_loss, take_profit and trailing_stop_pct. Omitted values stay; 0 clears one. No symbol lists them all.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        stop_loss: { type: 'number' },
        take_profit: { type: 'number' },
        trailing_stop_pct: { type: 'number' },
        clear: { type: 'boolean', description: 'Remove every exit on the symbol' }
      }
    },
    mutating: (input) => Boolean(str(input.symbol)),
    describe: (input) => (str(input.symbol) ? `Exits on ${str(input.symbol).toUpperCase()}` : 'List exits'),
    run: async (input, ctx) => {
      const symbol = str(input.symbol)
      if (!symbol) {
        const all = engine.exitsNow()
        return all.length ? all.map((e) => `- ${e.symbol}: ${describeExit(e)}`).join('\n') : 'No exits are set.'
      }
      // 0 reads as "clear" — models rarely send null.
      const value = (raw: unknown): number | null | undefined => (raw === undefined ? undefined : raw === null || num(raw) === 0 ? null : (num(raw) ?? NaN))
      const sessionId = sessionIdOf(ctx.request.chatId)
      const exit = await engine.setExit(
        input.clear === true
          ? { symbol, stopPrice: null, targetPrice: null, trailPct: null }
          : { symbol, stopPrice: value(input.stop_loss), targetPrice: value(input.take_profit), trailPct: value(input.trailing_stop_pct) },
        sessionId ? 'session' : 'agent',
        sessionId
      )
      return exit ? `${exit.symbol} protected: ${describeExit(exit)}. Eaon sells at market when it is reached, while it is running.` : `No exit on ${symbol.toUpperCase()} now.`
    }
  }

  const cancel: AgentTool = {
    name: 'trading_cancel',
    description: 'Cancel an open order by its id.',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    mutating: true,
    describe: (input) => `Cancel order ${str(input.order_id)}`,
    run: async (input) => {
      const id = str(input.order_id)
      if (!id) throw new Error('Give the order_id to cancel (trading_account lists open orders with their ids).')
      const snap = await engine.cancelOrder(id)
      const canceled = snap.orders.find((o) => o.id === id)
      return `Canceled${canceled ? `: ${describeOrder(canceled)}` : ` order ${id}`}.`
    }
  }

  const starting = (input: Record<string, unknown>): boolean => input.action === 'start' || input.action === 'schedule'
  const session: AgentTool = {
    name: 'trading_session',
    description:
      'Trading sessions: the agent trades on its own every few minutes until an end time, following a strategy. action: status, start (strategy, until), stop, or schedule (a repeating window: days, start, end, strategy).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop', 'schedule'] },
        strategy: { type: 'string', description: 'What to trade and how' },
        until: { type: 'string', description: 'start: when to stop — a local time like "15:45" or an ISO date-time' },
        every_minutes: { type: 'number', description: 'How often to check; default 5' },
        flatten_at_end: { type: 'boolean', description: 'Sell everything when it ends' },
        name: { type: 'string' },
        days: { type: 'array', items: { type: 'string' }, description: 'schedule: e.g. ["mon","tue"]; default weekdays' },
        start: { type: 'string', description: 'schedule: "HH:MM" local' },
        end: { type: 'string', description: 'schedule: "HH:MM" local' }
      },
      required: ['action']
    },
    mutating: (input) => input.action !== 'status',
    risky: (input) => starting(input),
    // A session on real money trades unattended, so arming one from a chat is as serious as an order.
    catastrophic: (input, ctx) => starting(input) && live() && !fromSession(ctx),
    describe: (input) => {
      const action = str(input.action)
      if (action === 'start') return `Start a trading session until ${str(input.until)}${live() ? ' (real money)' : ''}`
      if (action === 'schedule') return `Schedule trading ${str(input.start)}–${str(input.end)}${live() ? ' (real money)' : ''}`
      return `${action || 'status'} trading session`
    },
    run: async (input, ctx) => {
      const action = str(input.action)
      if (action === 'status' || !action) return sessionStatus(engine)

      if (action === 'stop') {
        const active = engine.activeSession()
        if (!active) return 'No trading session is running.'
        if (sessionIdOf(ctx.request.chatId) === active.id && engine.stopFromInside(active.id)) return 'The session stops as soon as this check ends.'
        const snap = await engine.stopSession(active.id, 'Stopped by the agent from a chat.')
        const ended = snap.sessions.find((s) => s.id === active.id)
        return `Stopped "${active.name}". ${ended?.summary ?? ''}`.trim()
      }

      const strategy = str(input.strategy)
      if (!strategy) throw new Error('Give the strategy: what to trade and how, in a few sentences.')
      const everyMinutes = num(input.every_minutes)
      const flattenAtEnd = input.flatten_at_end === true

      if (action === 'start') {
        const raw = input.until
        const until = typeof raw === 'number' ? raw : parseWakeTime(str(raw), Date.now())
        if (until === null || !Number.isFinite(until)) throw new Error('Give until as a local time like "15:45" or an ISO date-time.')
        const started = await engine.startSession({ strategy, until, ...(everyMinutes !== undefined ? { everyMinutes } : {}), flattenAtEnd, ...(str(input.name) ? { name: str(input.name) } : {}) })
        return `Started "${started.name}" on ${brokerLabel(engine.brokerKind)}: a check every ${started.everyMinutes} min until ${localTime(started.endsAt)}${
          started.flattenAtEnd ? ', selling everything at the end' : ''
        }. It runs on its own; the trading desk shows each decision.`
      }

      if (action === 'schedule') {
        const days = parseDays(input.days)
        const schedule = engine.saveSchedule({
          name: str(input.name),
          days,
          start: str(input.start),
          end: str(input.end),
          strategy,
          everyMinutes: everyMinutes ?? 5,
          flattenAtEnd,
          enabled: true
        })
        return `Scheduled "${schedule.name}": ${describeDays(schedule.days)} ${schedule.start}–${schedule.end} local time, a check every ${schedule.everyMinutes} min${
          schedule.flattenAtEnd ? ', selling everything at the end' : ''
        }.`
      }
      throw new Error('action must be status, start, stop or schedule.')
    }
  }

  const tools = [account, quote, history, scan, news, order, exits, cancel, session]

  return {
    id: 'trading',
    tools: (query) => (query.mode === 'work' && query.depth === 0 ? tools : []),
    // In the system prompt, so it changes only when the broker does.
    guidance: (query) => {
      if (query.mode !== 'work' || query.depth > 0) return null
      const broker = BROKERS.find((b) => b.id === engine.brokerKind)
      return [
        `Trading (trading_* tools; the account is ${broker?.label ?? 'the simulator'}${broker?.real ? ', REAL MONEY' : ', practice money'}):`,
        'look before you trade — trading_account, then trading_quote or trading_history. Size every order inside the user’s limits (an order past them is refused, and the refusal says why), always give a reason, and give each buy a stop_loss.',
        'Prefer limit orders for thinly traded stocks, never chase a price that has run away, and in a trading session stick to its strategy.',
        'Only Alpaca live is real money; say so plainly before placing an order there.'
      ].join(' ')
    }
  }
}
