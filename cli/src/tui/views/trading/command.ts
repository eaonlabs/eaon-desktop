import type { EquityPoint, TradingLogEntry, TradingOrder, TradingPosition, TradingSchedule, TradingSession, TradingSnapshot } from '@shared/trading'
import { isOpen, nextClose, nextOpen } from '@main/features/trading/marketHours'
import { store } from '@main/store'
import { chatModel, modelLabel } from '../../../core/models'
import { activity, type AgentStep } from '../../../core/tradingActivity'
import { invoke } from '../../../runtime/ipc'
import { BIG_ROWS, drawBig } from '../../bigtext'
import { axisLabels, lineChart } from '../../charts'
import { EditForm } from '../../form'
import type { InputEvent } from '../../input'
import { wrapSegments, type Line, type Segment } from '../../markdown'
import { PromptModal } from '../../modals'
import type { Canvas, Rect } from '../../screen'
import { strWidth, truncate, type Style } from '../../term'
import { C, S, signStyle } from '../../theme'
import { panel, scanner, spinner, Table, TextField, type Column } from '../../widgets'
import { pct, price, shares, signedPct, signedUsd, span, usd, usdShort } from './format'
import { LinkedAccountsModal, linkedCount } from './accounts'
import { afterDisclaimer, DisclaimerModal } from './disclaimer'
import { ask, confirmKill, openExit, openSetup, parseRunFor, pickTradingModel, setConfig, stopSession } from './forms'
import type { TradingView } from './index'

/**
 * The agent desk: the first page of the trading tab, for running the agent
 * as a trader would. Three parts:
 *
 * - On the left, everything the agent does, as it does it: each check, what
 *   it thought, every scan, quote, chart, headline and order with what came
 *   back, and what it decided. Its buys and sells stand out, with their
 *   reasons. (Steps come from `core/tradingActivity`; the engine's own log
 *   adds what happens between checks, like a stop being hit.)
 * - On the right, the account: the balance in large figures, today's, the
 *   session's and the total return, and the equity curve with every buy
 *   and sell marked on it; under it the holdings and today's trades.
 * - Along the bottom, mission control: the mission (strategy, end time,
 *   how often to check, whether to sell everything at the end), the broker
 *   and model, every limit, the kill switch, gauges of how close the day is
 *   to its limits, and start / check now / stop.
 *
 * ←→ pick a setting and ⏎ changes it (-/+ steps numbers); ↑↓ pick a
 * holding for B, S and X; the wheel or PgUp/PgDn scroll the activity.
 */

export type ChartRange = 'session' | '1h' | '1d' | '1w' | 'all'
const RANGES: { id: ChartRange; label: string; ms: number | null }[] = [
  { id: 'session', label: 'SESSION', ms: null },
  { id: '1h', label: '1H', ms: 3_600_000 },
  { id: '1d', label: '1D', ms: 86_400_000 },
  { id: '1w', label: '1W', ms: 7 * 86_400_000 },
  { id: 'all', label: 'ALL', ms: null }
]

interface Mission {
  strategy: string
  until: string
  every: number
  flatten: boolean
  /** Who trades: Eaon's own agent, or the user's Claude Code (which takes the session with /mcp__eaon__trade). */
  driver: 'eaon' | 'claude-code'
  /** The every-market-day mission's schedule, once armed. */
  missionId?: string
}
/** What the user types in Claude Code to hand it the session: an MCP prompt of Eaon's server. */
export const HANDOFF = '/mcp__eaon__trade'
const MISSION_FILE = 'cli-trading-mission.json'
const EVERY = [1, 2, 5, 10, 15, 30, 60]
/** Whether Claude Code may trade real money through Eaon; `eaon mcp --control` reads the same file. */
const CLAUDE_CONTROL_FILE = 'cli-claude-control.json'
const claudeMayTradeLive = (): boolean => store.getJson<{ liveMoney?: boolean } | null>(CLAUDE_CONTROL_FILE, null)?.liveMoney === true
/**
 * How long the agent trades, -/+ steps through these; ⏎ takes any number of
 * hours or a time. `market` is the mission: from the open until the close,
 * and again at every open until the user stops it.
 */
const RUN_FOR = ['market', 'close', '30m', '1h', '2h', '3h', '4h', '6h', '8h']
const EVERY_DAY = 'market'

interface Chip {
  id: string
  label: string
  value: string
  valueStyle?: Style
  /** Part of the running session's mission: shown, but changed only by stopping and starting again. */
  locked?: boolean
  edit: () => void
  step?: (by: 1 | -1) => void
  detail: string
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const clock = (at: number): string => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const clockS = (at: number): string => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const mmss = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 3600 ? span(ms) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
/** A day and time this week or next: "Mon 15:30", or "15:30" today. */
const dayClock = (at: number): string =>
  new Date(at).toDateString() === new Date().toDateString() ? `today ${clock(at)}` : `${new Date(at).toLocaleDateString('en-GB', { weekday: 'short' })} ${clock(at)}`
const inside = (r: Rect | null, x: number, y: number): boolean => Boolean(r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)

/** How the feed shows each tool: a glyph, a word, a colour. */
const TOOL_LOOK: Record<string, { glyph: string; label: string; color: string }> = {
  trading_scan: { glyph: '◎', label: 'Scan', color: C.cyan },
  trading_quote: { glyph: '$', label: 'Quote', color: C.cyan },
  trading_history: { glyph: '≈', label: 'Chart', color: C.cyan },
  trading_news: { glyph: '✎', label: 'News', color: C.purple },
  trading_account: { glyph: '◇', label: 'Account', color: C.muted },
  trading_exits: { glyph: '◈', label: 'Exits', color: C.yellow },
  trading_cancel: { glyph: '⊘', label: 'Cancel', color: C.yellow },
  trading_session: { glyph: '◷', label: 'Session', color: C.muted },
  web_search: { glyph: '⌕', label: 'Search', color: C.blue },
  web_fetch: { glyph: '⇣', label: 'Read', color: C.blue },
  update_plan: { glyph: '☰', label: 'Plan', color: C.muted }
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : [])

/** What a finished tool call found, in a few words. */
function toolResult(step: AgentStep): { text: string; style: Style } {
  const out = step.output ?? ''
  if (step.status === 'error' || step.status === 'denied') return { text: out.split('\n')[0] || step.status, style: S.red }
  const lines = out.split('\n')
  switch (step.tool) {
    case 'trading_scan': {
      const rows = lines.map((l) => /^- ([A-Z.\-]+)[^:]*: \$[\d,.]+, ([+\-]?[\d.]+%)/.exec(l)).filter((m): m is RegExpExecArray => Boolean(m))
      if (!rows.length) return { text: lines[0] ?? '', style: S.muted }
      return { text: `${rows.length} found · ${rows.slice(0, 4).map((m) => `${m[1]} ${m[2]}`).join(' · ')}`, style: S.text }
    }
    case 'trading_quote': {
      const rows = lines.map((l) => /^([A-Z.\-^=]+)(?: \([^)]*\))?: \$([\d,.]+), ([+\-]?[\d.]+%)/.exec(l)).filter((m): m is RegExpExecArray => Boolean(m))
      return rows.length ? { text: rows.map((m) => `${m[1]} $${m[2]} ${m[3]}`).join(' · '), style: S.text } : { text: lines[0] ?? '', style: S.muted }
    }
    case 'trading_history': {
      const parts: string[] = []
      let symbol = ''
      for (const l of lines) {
        const head = /^([A-Z.\-^=]+) over /.exec(l)
        if (head) symbol = head[1]
        const rsi = /RSI14 (\d+)/.exec(l)
        const atr = /ATR14 \$[\d,.]+ \(([\d.]+)% of price\)/.exec(l)
        const macd = /MACD (positive|negative), (strengthening|fading)/.exec(l)
        if (rsi || atr || macd) parts.push(`${symbol} ${[rsi ? `RSI ${rsi[1]}` : '', atr ? `ATR ${atr[1]}%` : '', macd ? `MACD ${macd[1] === 'positive' ? '+' : '−'}${macd[2] === 'strengthening' ? '↑' : '↓'}` : ''].filter(Boolean).join(' ')}`)
      }
      return parts.length ? { text: parts.join(' · '), style: S.text } : { text: lines[0] ?? '', style: S.muted }
    }
    case 'trading_news': {
      const items = lines.filter((l) => l.startsWith('- '))
      const first = items[0]?.slice(2).replace(/ \([^)]*\) · .*$/, '').replace(/ · .*$/, '')
      return { text: items.length ? `${items.length} headlines · “${first}”` : lines[0] ?? '', style: S.text }
    }
    case 'trading_exits':
      return { text: (lines[0] ?? '').replace(/\. Eaon sells.*$/, ''), style: S.text }
    default:
      return { text: lines.find((l) => l.trim()) ?? '', style: S.muted }
  }
}

/** What the engine wrote about an order, as parts: "Bought 10 NVDA at $182.40 ($1,824.00), realized +$12.00." */
function parseOutcome(text: string): { verb: 'Bought' | 'Sold'; qty: string; symbol: string; at: string; value: string; realized: string | null; before: string } | { refused: string; what: string; before: string } | null {
  const fill = /(Bought|Sold) ([\d.,]+) ([A-Z.\-]+) at \$([\d,.]+) \(\$([\d,.]+)\)(?:[^.]*?realized ([+\-]?-?\$[\d,.]+))?/.exec(text)
  if (fill) return { verb: fill[1] as 'Bought' | 'Sold', qty: fill[2], symbol: fill[3], at: fill[4], value: fill[5], realized: fill[6] ?? null, before: text.slice(0, fill.index).trim().replace(/[:.]$/, '') }
  const refused = /Refused: (.*?) — (.*?)\.?$/.exec(text.split('\n')[0])
  if (refused) return { refused: refused[2], what: refused[1], before: text.slice(0, refused.index).trim() }
  return null
}

export class CommandDesk {
  chip = 0
  /** Lines scrolled up from the newest in the activity feed; 0 follows it. */
  feedBack = 0
  /** Thoughts and tool output in full. */
  details = false
  range: ChartRange | null = null
  mission: Mission
  readonly holdings: Table<TradingPosition>
  /** The box for talking to the agent while it trades (T). */
  talking = false
  readonly talkField = new TextField({ placeholder: 'Tell the agent: “sell half of NVDA”, “no new buys today”, “why did you buy AMD?”' })
  private seen = { session: '', width: 0, lines: 0 }
  private rects: { feed: Rect | null; holdings: Rect | null; chips: { rect: Rect; index: number }[]; ranges: { rect: Rect; id: ChartRange }[] } = {
    feed: null,
    holdings: null,
    chips: [],
    ranges: []
  }

  constructor(private readonly view: TradingView) {
    const saved = store.getJson<Partial<Mission> | null>(MISSION_FILE, null)
    this.mission = {
      strategy: saved?.strategy ?? '',
      until: saved?.until ?? EVERY_DAY,
      every: saved?.every ?? 5,
      flatten: saved?.flatten ?? true,
      driver: saved?.driver === 'claude-code' ? 'claude-code' : 'eaon',
      ...(saved?.missionId ? { missionId: saved.missionId } : {})
    }
    this.holdings = new Table<TradingPosition>(this.holdingColumns())
  }

  private saveMission(): void {
    store.setJson(MISSION_FILE, this.mission)
  }

  private get snap(): TradingSnapshot | null {
    return this.view.snapshot
  }

  /** A past session the user paged back to with ‹ ›; null follows the running (or latest) one. */
  private viewing: string | null = null

  /** The every-market-day mission, while it is armed (its schedule enabled). */
  armedMission(): TradingSchedule | null {
    return this.snap?.schedules.find((s) => s.id === this.mission.missionId && s.enabled) ?? null
  }

  /** The session the feed shows: one paged back to, else the running one, else the latest. */
  session(): TradingSession | null {
    const pinned = this.viewing ? this.snap?.sessions.find((s) => s.id === this.viewing) : undefined
    if (pinned) return this.snap?.activeSession?.id === pinned.id ? this.snap.activeSession : pinned
    return this.snap?.activeSession ?? this.snap?.sessions[0] ?? null
  }

  /** ‹ older, › newer; past the newest goes back to following. */
  private pageSessions(by: 1 | -1): void {
    const sessions = this.snap?.sessions ?? []
    if (!sessions.length) return
    const current = this.session()
    const at = Math.max(0, sessions.findIndex((s) => s.id === current?.id))
    const next = at + by
    if (next < 0) {
      this.viewing = null
      return this.view.app.toast('Following the latest session', 'info', 1200)
    }
    if (next >= sessions.length) return this.view.app.toast('That’s the oldest session', 'info', 1200)
    this.viewing = next === 0 ? null : sessions[next].id
    this.feedBack = 0
  }

  animating(): boolean {
    return Boolean(this.snap?.agent?.checking)
  }

  selectedSymbol(): string | null {
    return this.view.positions()[this.holdings.selected]?.symbol ?? null
  }

  /* ================================================================ draw */

  draw(c: Canvas): void {
    this.rects = { feed: null, holdings: null, chips: [], ranges: [] }
    const missionH = c.h >= 36 ? 9 : c.h >= 26 ? 8 : 6
    const top = c.sub(0, 0, c.w, c.h - missionH)
    if (c.w >= 120) {
      const leftW = Math.max(54, Math.min(Math.floor(c.w * 0.42), 96))
      this.drawFeed(top.sub(0, 0, leftW, top.h))
      const right = top.sub(leftW, 0, top.w - leftW, top.h)
      // The account and its chart first, then the holdings, then today's trades, as room allows.
      const accountH = right.h >= 28 ? Math.max(17, Math.floor(right.h * 0.56)) : right.h >= 22 ? right.h - 7 : right.h
      this.drawAccount(right.sub(0, 0, right.w, accountH))
      const rest = right.h - accountH
      const holdingsH = rest >= 12 ? Math.ceil(rest * 0.55) : rest
      if (holdingsH >= 4) this.drawHoldings(right.sub(0, accountH, right.w, holdingsH))
      if (rest - holdingsH >= 4) this.drawTrades(right.sub(0, accountH + holdingsH, right.w, rest - holdingsH))
    } else {
      const accountH = Math.min(17, Math.max(11, Math.floor(top.h * 0.5)))
      this.drawAccount(top.sub(0, 0, top.w, accountH), true)
      this.drawFeed(top.sub(0, accountH, top.w, top.h - accountH))
    }
    this.drawMission(c.sub(0, c.h - missionH, c.w, missionH))
  }

  /* ------------------------------------------------------------- account */

  private drawAccount(c: Canvas, compact = false): void {
    const s = this.snap
    const a = s?.account
    const st = s?.stats
    const broker = s?.config.broker ?? 'simulator'
    const badge =
      broker === 'alpaca-live'
        ? { text: ' ● LIVE MONEY ', style: { fg: '#FFFFFF', bg: '#B3261E', bold: true } }
        : broker === 'alpaca-paper'
          ? { text: ' PAPER ', style: { fg: C.ink, bg: C.amberDeep, bold: true } }
          : { text: s?.config.simulatorAnytime ? ' SIMULATOR · ANY TIME ' : ' SIMULATOR ', style: { fg: C.ink, bg: C.green, bold: true } }
    const inner = panel(c, 'Account', { right: [badge] })
    if (!a || !st) {
      inner.text(0, 0, this.view.loadError ?? 'Waiting for the broker…', this.view.loadError ? S.yellow : S.faint, inner.w)
      return
    }

    // The balance in large figures, cents beside them.
    const whole = Math.floor(Math.abs(a.equity)).toLocaleString('en-US')
    const cents = `.${Math.round((Math.abs(a.equity) % 1) * 100).toString().padStart(2, '0').slice(0, 2)}`
    inner.text(0, 0, a.equity < 0 ? '-$' : '$', { fg: C.muted, bold: true })
    let x = 2
    x += drawBig(inner, x, 0, whole, { fg: '#F4F4F5', bold: true })
    inner.text(x + 1, BIG_ROWS - 1, cents, { fg: C.muted, bold: true })
    x += strWidth(cents) + 4

    // Returns beside the balance: today and total, then the session and the S&P over it.
    const session = s.activeSession
    const spy = session?.benchmark
    const spyNow = spy ? this.view.market.quote('SPY')?.price : undefined
    const spyPct = spy && spyNow ? ((spyNow - spy.start) / spy.start) * 100 : null
    const sessionChange = session ? a.equity - session.startEquity : null
    const cell = (label: string, value: number | null | undefined, percent: number | null | undefined): Segment[] => [
      { text: `${label} `, style: S.muted },
      { text: signedUsd(value), style: signStyle(value, true) },
      { text: ` ${signedPct(percent)}`, style: signStyle(value) }
    ]
    const colW = 28
    const columns: Segment[][][] = [
      [cell('TODAY  ', st.todayReturn, st.todayReturnPct), cell('TOTAL  ', st.totalReturn, st.totalReturnPct), [{ text: 'REALIZED ', style: S.muted }, { text: signedUsd(st.realizedPl), style: signStyle(st.realizedPl) }]],
      ...(session && sessionChange !== null
        ? [[cell('SESSION', sessionChange, (sessionChange / session.startEquity) * 100), spyPct !== null ? [{ text: 'S&P 500 ', style: S.muted }, { text: signedPct(spyPct), style: signStyle(spyPct) }, { text: ` · edge ${signedPct((sessionChange / session.startEquity) * 100 - spyPct)}`, style: S.faint }] : []]]
        : [])
    ]
    columns.forEach((col, i) => {
      const cx = x + i * (colW + 3)
      if (cx + 20 > inner.w) return
      col.forEach((segs, row) => inner.segments(cx, row, segs, Math.min(colW + 6, inner.w - cx)))
    })

    // A strip of the numbers a trader checks, packed item by item into one row or two.
    const items: Segment[][] = []
    const add = (label: string, value: string, style: Style = S.text): void => void items.push([{ text: `${label} `, style: S.muted }, { text: value, style }])
    add('CASH', usdShort(a.cash))
    add('BUYING POWER', usdShort(a.buyingPower))
    add('INVESTED', pct(st.investedPct))
    add('OPEN P&L', signedUsd(st.unrealizedPl), signStyle(st.unrealizedPl))
    add('WIN', st.trades ? pct(st.winRate * 100, 0) : '—')
    add('PF', st.profitFactor != null ? st.profitFactor.toFixed(2) : '—')
    add('SHARPE', st.sharpe != null ? st.sharpe.toFixed(2) : '—')
    add('MAX DD', pct(st.maxDrawdownPct), st.maxDrawdownPct > 5 ? S.red : S.text)
    const stripLines: Segment[][] = [[]]
    let used = 0
    for (const item of items) {
      const w = item.reduce((n, seg) => n + strWidth(seg.text), 0)
      if (used > 0 && used + 3 + w > inner.w) {
        stripLines.push([])
        used = 0
      }
      if (used > 0) stripLines[stripLines.length - 1].push({ text: '   ' })
      stripLines[stripLines.length - 1].push(...item)
      used += (used > 0 ? 3 : 0) + w
    }
    // Tight panels lose the blank rows around the strip before they lose the chart.
    const tight = compact || inner.h < 14
    const stripY = BIG_ROWS + (tight ? 0 : 1)
    const stripRows = tight ? 1 : Math.min(2, stripLines.length)
    stripLines.slice(0, stripRows).forEach((line, i) => inner.segments(0, stripY + i, line, inner.w))
    const chartY = stripY + stripRows + (tight ? 0 : 1)
    if (inner.h - chartY >= 3) this.drawEquity(inner.sub(0, chartY, inner.w, inner.h - chartY), s)
  }

  private chartRange(s: TradingSnapshot): ChartRange {
    return this.range ?? (s.activeSession ? 'session' : '1d')
  }

  private drawEquity(c: Canvas, s: TradingSnapshot): void {
    const a = s.account!
    const now = Date.now()
    const range = this.chartRange(s)
    const session = s.activeSession ?? null
    const def = RANGES.find((r) => r.id === range)!
    const from = range === 'session' ? (session?.startedAt ?? now - 86_400_000) : def.ms ? now - def.ms : 0
    let points: EquityPoint[] = s.equity.filter((p) => p.at >= from)
    const before = s.equity.filter((p) => p.at < from).at(-1)
    if (before) points = [{ at: from, equity: before.equity }, ...points]
    // The live balance as the last point, so the curve ends where the big number is.
    if (!points.length || points[points.length - 1].at < now - 30_000) points.push({ at: now, equity: a.equity })
    const base = range === 'session' && session ? session.startEquity : (points[0]?.equity ?? a.equity)
    const change = a.equity - base

    // The header: what the range did, and the range tabs.
    c.segments(0, 0, [
      { text: 'EQUITY ', style: S.amberBold },
      { text: signedUsd(change), style: signStyle(change, true) },
      { text: ` ${signedPct(base ? (change / base) * 100 : 0)}`, style: signStyle(change) },
      { text: ` over ${range === 'session' ? 'the session' : range === 'all' ? 'all time' : range === '1h' ? 'the last hour' : range === '1d' ? 'the last day' : 'the last week'}`, style: S.faint }
    ])
    let tx = c.w
    for (const r of [...RANGES].reverse()) {
      if (r.id === 'session' && !session) continue
      const label = ` ${r.label} `
      tx -= strWidth(label) + 1
      const active = r.id === range
      c.text(tx, 0, label, active ? { fg: C.ink, bg: C.amber, bold: true } : { fg: C.muted, bg: '#1A1A1C' })
      this.rects.ranges.push({ rect: { x: c.rect.x + tx, y: c.rect.y, w: strWidth(label), h: 1 }, id: r.id })
    }

    const axisW = 13
    // Header, the chart, the row of buys and sells, and the times; the times go first when it's short.
    const showTimes = c.h >= 6
    const chartH = c.h - 2 - (showTimes ? 1 : 0)
    if (chartH < 1) return
    const chart = c.sub(0, 1, c.w - axisW, chartH)
    if (points.length < 2) {
      chart.text(0, Math.floor(chartH / 2), 'The curve gains a point a minute while Eaon runs; this range has none yet.', S.faint, chart.w)
      return
    }
    const values = points.map((p) => p.equity)
    const scale = lineChart(chart, values, { baseline: base, splitColors: true })
    const spread = scale.hi - scale.lo
    const fmt = (v: number): string => (spread < 50 ? usd(v, 2) : spread < 5000 ? usd(v, 0) : usdShort(v))
    for (const label of axisLabels(scale, chart.h, fmt)) c.text(c.w - axisW + 1, 1 + label.row, label.text, S.faint, axisW - 1)

    // Every fill in the range, under the curve where it happened: ▲ buys, ▼ sells.
    const markerRow = 1 + chartH
    const xOf = (at: number): number => {
      let lo = 0
      let hi = points.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (points[mid].at < at) lo = mid + 1
        else hi = mid
      }
      const i = lo > 0 && Math.abs(points[lo - 1].at - at) < Math.abs(points[lo].at - at) ? lo - 1 : lo
      return Math.round((i / (points.length - 1)) * (chart.w - 1))
    }
    const fills = s.orders.filter((o) => o.filledAt && o.filledQty > 0 && o.filledAt >= points[0].at)
    c.hline(0, markerRow, chart.w, { fg: '#26262A' }, '┈')
    for (const o of [...fills].reverse()) c.text(xOf(o.filledAt!), markerRow, o.side === 'buy' ? '▲' : '▼', { fg: o.side === 'buy' ? C.green : C.red, bold: true })
    if (!showTimes) return
    const startLabel = new Date(points[0].at).toLocaleString('en-GB', points[0].at < now - 86_400_000 ? { day: '2-digit', month: 'short' } : { hour: '2-digit', minute: '2-digit' })
    c.text(0, markerRow + 1, startLabel, S.faint)
    const legend = `▲ buy  ▼ sell   now ${clock(now)}`
    c.segments(chart.w - strWidth(legend), markerRow + 1, [
      { text: '▲', style: { fg: C.green } },
      { text: ' buy  ', style: S.faint },
      { text: '▼', style: { fg: C.red } },
      { text: ` sell   now ${clock(now)}`, style: S.faint }
    ])
  }

  /* ------------------------------------------------------------ holdings */

  /** The holdings' columns for a width: average price and weight give way first, then the percent. */
  private holdingColumns(width = 200): Column<TradingPosition>[] {
    const equity = (): number => this.snap?.account?.equity ?? 0
    const roomy = width >= 76
    return [
      { title: 'SYMBOL', width: 7, cell: (p) => ({ text: p.symbol, style: S.bold }) },
      { title: 'QTY', width: 7, align: 'right', cell: (p) => shares(p.qty) },
      ...(roomy ? ([{ title: 'AVG', width: 9, align: 'right', cell: (p: TradingPosition) => price(p.avgPrice) }] as Column<TradingPosition>[]) : []),
      { title: 'LAST', width: 9, align: 'right', cell: (p) => price(p.price) },
      { title: 'P&L', width: 10, align: 'right', cell: (p) => ({ text: signedUsd(p.unrealizedPl), style: signStyle(p.unrealizedPl, true) }) },
      ...(width >= 60 ? ([{ title: '%', width: 7, align: 'right', cell: (p: TradingPosition) => ({ text: signedPct(p.unrealizedPlPct), style: signStyle(p.unrealizedPlPct) }) }] as Column<TradingPosition>[]) : []),
      ...(roomy ? ([{ title: 'WEIGHT', width: 6, align: 'right', cell: (p: TradingPosition) => pct(equity() ? (p.marketValue / equity()) * 100 : 0, 0) }] as Column<TradingPosition>[]) : []),
      {
        title: 'STOP / TARGET',
        flex: 1,
        cell: (p) => {
          const e = p.exit
          if (!e || (!e.activeStop && !e.targetPrice)) return { text: 'no stop', style: { fg: C.yellow } }
          const stop = e.activeStop ? `${e.trailPct ? `trail ${e.trailPct}% ` : ''}${price(e.activeStop)}` : '—'
          const near = e.activeStop ? (p.price - e.activeStop) / p.price < 0.02 : false
          return { text: `${stop}${e.targetPrice ? ` / ${price(e.targetPrice)}` : ''}`, style: near ? { fg: C.yellow, bold: true } : S.muted }
        }
      }
    ]
  }

  private drawHoldings(c: Canvas): void {
    const positions = this.view.positions()
    const value = positions.reduce((n, p) => n + p.marketValue, 0)
    const inner = panel(c, 'Holdings', { right: [{ text: `${positions.length} open · ${usdShort(value)}`, style: S.muted }] })
    this.rects.holdings = inner.rect
    this.holdings.columns = this.holdingColumns(inner.w)
    this.holdings.draw(inner, positions, { focused: true, empty: 'Nothing held. The agent’s buys show up here, with their stops.' })
  }

  private drawTrades(c: Canvas): void {
    const s = this.snap
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const today = (s?.orders ?? []).filter((o) => o.submittedAt >= start.getTime() && o.status !== 'canceled' && o.status !== 'expired')
    const filled = today.filter((o) => o.filledQty > 0)
    const realized = filled.reduce((n, o) => n + (o.realizedPl ?? 0), 0)
    const inner = panel(c, 'Trades today', {
      right: [
        { text: `${filled.length} filled`, style: S.muted },
        ...(filled.some((o) => o.realizedPl !== null) ? [{ text: ' · realized ', style: S.muted }, { text: signedUsd(realized), style: signStyle(realized) }] : [])
      ]
    })
    if (!today.length) {
      inner.text(0, 0, 'No orders today.', S.faint)
      return
    }
    today.slice(0, inner.h).forEach((o, i) => inner.segments(0, i, this.orderRow(o), inner.w))
  }

  private orderRow(o: TradingOrder): Segment[] {
    const buy = o.side === 'buy'
    const who = o.reason.startsWith('Claude Code:') ? 'claude' : o.source === 'session' ? 'agent' : o.source === 'agent' ? 'chat' : 'you'
    if (o.status === 'rejected')
      return [
        { text: `${clockS(o.submittedAt)} `, style: S.faint },
        { text: '✗ ', style: S.yellow },
        { text: `${buy ? 'BUY ' : 'SELL'} ${o.symbol}`, style: { fg: C.yellow, bold: true } },
        { text: `  refused: ${o.error ?? ''}`, style: S.muted }
      ]
    return [
      { text: `${clockS(o.filledAt ?? o.submittedAt)} `, style: S.faint },
      { text: buy ? '▲ ' : '▼ ', style: { fg: buy ? C.green : C.red } },
      { text: `${buy ? 'BUY ' : 'SELL'} ${shares(o.filledQty || o.qty)} ${o.symbol}`.padEnd(16), style: { fg: buy ? C.green : C.red, bold: true } },
      { text: o.filledAvgPrice ? ` @ ${price(o.filledAvgPrice)}`.padEnd(12) : ` ${o.status}`.padEnd(12), style: S.text },
      { text: o.filledAvgPrice ? usdShort(o.filledAvgPrice * o.filledQty).padStart(8) : ''.padStart(8), style: S.muted },
      ...(o.realizedPl !== null ? [{ text: `  ${signedUsd(o.realizedPl)}`, style: signStyle(o.realizedPl, true) }] : []),
      { text: `  ${who}`, style: S.faint }
    ]
  }

  /* -------------------------------------------------------------- feed */

  private drawFeed(c: Canvas): void {
    const s = this.snap
    const session = this.session()
    const running = session?.status === 'running'
    const checking = Boolean(s?.agent?.checking)
    const state = running
      ? checking
        ? { text: '● CHECKING', style: S.greenBold }
        : session?.driver === 'claude-code' && !s?.agent?.connected
          ? { text: '◌ WAITING', style: S.yellow }
          : { text: '● LIVE', style: S.greenBold }
      : this.armedMission() && !this.viewing
        ? { text: '◷ ARMED', style: S.amberBold }
        : session
          ? { text: session.status.toUpperCase(), style: S.muted }
          : { text: 'IDLE', style: S.muted }
    const sessions = s?.sessions ?? []
    const index = session ? sessions.findIndex((x) => x.id === session.id) : -1
    const paging = sessions.length > 1 && index >= 0 ? [{ text: ` ‹ ${index + 1}/${sessions.length} › `, style: { fg: this.viewing ? C.amber : C.faint } }] : []
    const driverBadge = session?.driver === 'claude-code' ? [{ text: ' ✻ CLAUDE CODE ', style: { fg: C.ink, bg: '#D97757', bold: true } }, { text: ' ' }] : []
    const inner = panel(c, 'Agent activity', { right: [...paging, ...driverBadge, state] })
    if (inner.h < 3) return
    this.rects.feed = inner.rect

    // The line under the title: what it is doing now, or when it looks next.
    const steps = session ? activity.of(session.id) : []
    if (running && session && session.driver === 'claude-code' && !checking && !s?.agent?.connected) {
      inner.segments(0, 0, [
        { text: '⚠ ', style: S.yellow },
        { text: 'Waiting for Claude Code to take the session', style: { fg: C.yellow, bold: true } },
        { text: `  ·  /claude, then type ${HANDOFF}`, style: S.muted }
      ], inner.w)
    } else if (running && session) {
      if (checking) {
        const startedAt = s?.agent?.checkStartedAt ?? Date.now()
        const doing = this.doing(steps)
        inner.segments(0, 0, [
          ...scanner(Date.now(), session.driver === 'claude-code' ? '#D97757' : C.amber),
          { text: `  CHECK ${session.driver === 'claude-code' ? session.checks : session.checks + 1}`, style: S.amberBold },
          ...(session.driver === 'claude-code' ? [{ text: '  ✻ Claude Code', style: { fg: '#D97757', bold: true } }] : []),
          { text: `  ${doing}`, style: S.text },
          { text: ` · ${mmss(Date.now() - startedAt)}`, style: S.faint }
        ], inner.w)
      } else {
        const next = s?.agent?.nextCheckAt
        const watchedAt = s?.agent?.watchedAt
        inner.segments(0, 0, [
          { text: '◷ ', style: S.amber },
          ...(session.driver === 'claude-code' ? [{ text: '✻ Claude Code waiting · ', style: { fg: '#D97757' } }] : []),
          { text: next && next - Date.now() > 1000 ? `next check in ${mmss(next - Date.now())}` : 'check starting…', style: S.text },
          ...(watchedAt
            ? [
                { text: '  ·  ', style: S.faint },
                { text: '● ', style: { fg: Date.now() - watchedAt < 30_000 ? C.green : C.yellow } },
                { text: `watching ${s?.agent?.watching?.length ?? 0} live · ${Math.max(0, Math.round((Date.now() - watchedAt) / 1000))}s ago`, style: S.muted }
              ]
            : []),
          { text: `  ·  ${count(session.checks, 'check')} · ${count(session.orders, 'order')}`, style: S.muted }
        ], inner.w)
      }
    } else if (this.armedMission() && !this.viewing) {
      // Between the mission's sessions: when it trades next.
      const mission = this.armedMission()!
      const at = nextOpen(Date.now())
      const claude = mission.driver === 'claude-code'
      inner.segments(0, 0, [
        { text: '◷ ', style: S.amber },
        { text: `Next session at the open, ${dayClock(at)}`, style: S.text },
        { text: ` · in ${span(at - Date.now())}`, style: S.muted },
        ...(claude ? [{ text: s?.claudeWaiting ? '  ·  ✻ waiting for it' : `  ·  ✻ /claude, then ${HANDOFF}`, style: { fg: s?.claudeWaiting ? '#D97757' : C.yellow } }] : [])
      ], inner.w)
    } else if (session) {
      inner.segments(0, 0, [
        { text: '■ ', style: S.muted },
        { text: truncate(session.name, Math.max(10, inner.w - 40)), style: S.text },
        { text: `  ${count(session.checks, 'check')} · ${count(session.orders, 'order')} · ${span((session.endedAt ?? session.endsAt) - session.startedAt)}`, style: S.muted }
      ], inner.w)
    } else inner.text(0, 0, 'No session yet.', S.muted)
    inner.hline(0, 1, inner.w, S.border, '─')

    // The bottom of the panel: the box for talking to the agent, or a line saying how.
    const talkH = this.talking ? 3 : 1
    if (this.talking) {
      const box = inner.sub(0, inner.h - 3, inner.w, 3)
      box.box({ fg: C.amber }, { rounded: true, title: running ? 'Tell the agent · it reads this at once' : 'Ask the trading agent · opens the chat', titleStyle: S.amberBold })
      box.text(2, 1, '›', S.amberBold)
      this.talkField.draw(box.sub(4, 1, box.w - 6, 1), S.text, true)
    } else
      inner.segments(0, inner.h - 1, [
        { text: ' T ', style: { fg: C.ink, bg: C.amber, bold: true } },
        { text: running ? '  talk to the agent while it trades' : '  ask the trading agent', style: S.muted },
        { text: '   D ', style: S.key },
        { text: this.details ? 'fold the steps' : 'every step in full', style: S.faint }
      ], inner.w)
    const area = inner.sub(0, 2, inner.w - 1, inner.h - 2 - talkH)
    if (!session) {
      const linked = s ? s.config.broker !== 'simulator' || linkedCount(s) > 0 : false
      const claude = this.mission.driver === 'claude-code'
      const goal = Boolean(this.mission.strategy.trim())
      // Each step, and whether it is done already.
      const guide: [string, string, boolean | null][] = [
        ['', 'Every step the agent takes shows here as it trades: what it scans and reads, what it buys and sells and why, and what it decides each check.', null],
        ['', '', null],
        [
          '1',
          linked
            ? `Account: the agent trades ${s?.config.broker === 'alpaca-live' ? 'Alpaca LIVE' : s?.config.broker === 'alpaca-paper' ? 'Alpaca paper' : 'the simulator'} (ACCOUNT switches).`
            : 'Link an account: ← → to LINKED and ⏎ — or practise on the simulator first.',
          linked
        ],
        ['2', `Pick who trades: AGENT is ${claude ? 'Claude Code' : 'Eaon’s agent'} (⏎ switches to ${claude ? 'Eaon’s agent' : 'Claude Code'}).`, true],
        ['3', goal ? `Goal: “${truncate(this.mission.strategy.replace(/\s+/g, ' ').trim(), 60)}”` : 'Give it a goal: ← → to GOAL, then ⏎ and say what it should do.', goal],
        [
          '4',
          this.mission.until.trim().toLowerCase() === EVERY_DAY
            ? `G starts it. It trades until the market closes, then starts again at every open until you press X.${claude ? ` Claude Code takes it once you type ${HANDOFF} there.` : ''}`
            : `G starts it for one session (RUN FOR). Set RUN FOR to “every market day” to have it start again at each open.`,
          null
        ],
        ['', '', null],
        ['', 'Every order passes the limits beside them first.   N checks now · T talks to it · X stops · K kill switch', null]
      ]
      let y = 0
      for (const [k, text, done] of guide) {
        const mark = done === true ? '✓' : k
        const keyStyle = done === true ? { fg: C.ink, bg: C.green, bold: true } : S.key
        for (const line of wrapSegments([{ text, style: k ? (done ? S.muted : S.text) : S.muted }], area.w - 4, [{ text: k ? ` ${mark} ` : '', style: keyStyle }, { text: k ? ' ' : '' }], [{ text: k ? '    ' : '' }]))
          if (y < area.h) area.segments(0, y++, line, area.w)
      }
      return
    }
    const lines = this.feedLines(session, steps, area.w)
    if (this.feedBack > 0 && this.seen.session === session.id && this.seen.width === area.w && lines.length > this.seen.lines) this.feedBack += lines.length - this.seen.lines
    this.seen = { session: session.id, width: area.w, lines: lines.length }
    const maxBack = Math.max(0, lines.length - area.h)
    this.feedBack = Math.min(this.feedBack, maxBack)
    const start = Math.max(0, lines.length - area.h - this.feedBack)
    for (let i = 0; i < area.h && start + i < lines.length; i++) area.segments(0, i, lines[start + i], area.w)
    if (maxBack > 0 && area.h > 0) {
      const thumb = Math.max(1, Math.round((area.h * area.h) / lines.length))
      const at = Math.round((start / maxBack) * (area.h - thumb))
      for (let i = 0; i < area.h; i++) {
        const on = i >= at && i < at + thumb
        inner.text(inner.w - 1, 2 + i, on ? '┃' : '│', { fg: on ? (this.feedBack ? C.amber : C.faint) : '#232326' })
      }
    }
    if (this.feedBack > 0) {
      const note = ` ↓ ${this.feedBack} newer · End `
      area.text(area.w - strWidth(note), area.h - 1, note, { fg: C.ink, bg: C.amber })
    }
  }

  /** What the check in progress is doing, from its newest step. */
  private doing(steps: AgentStep[]): string {
    const last = steps[steps.length - 1]
    if (!last || last.kind === 'check') return 'starting'
    if (last.kind === 'tool' && last.status === 'running') {
      const look = TOOL_LOOK[last.tool ?? '']
      if (last.tool === 'trading_order') return `placing ${last.input?.side === 'sell' ? 'a sell' : 'a buy'} for ${String(last.input?.symbol ?? '').toUpperCase()}`
      const target = list(last.input?.symbols).join(' ') || String(last.input?.symbol ?? last.input?.list ?? last.input?.query ?? '')
      return `${(look?.label ?? last.tool ?? '').toLowerCase()} ${target}`.trim()
    }
    if (last.kind === 'answer' && last.endedAt === undefined) return 'deciding'
    return 'thinking'
  }

  /** The session as lines: its start, each check with its steps, trades and notes between checks, and its end. */
  feedLines(session: TradingSession, steps: AgentStep[], width: number): Line[] {
    type Item = { at: number; rank: number; lines: () => Line[] }
    const items: Item[] = []
    const stamp = (at: number): Segment => ({ text: `${clockS(at)} `, style: S.faint })
    const indent: Segment = { text: '         ' }
    const wrap = (at: number | null, lead: Segment[], body: Segment[], max = Infinity): Line[] => {
      const first = [at === null ? indent : stamp(at), ...lead]
      const restIndent = [indent, { text: ' '.repeat(lead.reduce((n, s) => n + strWidth(s.text), 0)) }]
      const out = wrapSegments(body, width, first, restIndent)
      return out.length > max ? [...out.slice(0, max - 1), [...out[max - 1].slice(0, -1), { text: '…', style: S.faint }]] : out
    }

    items.push({
      at: session.startedAt,
      rank: 0,
      lines: () => [
        ...wrap(session.startedAt, [{ text: '▶ ', style: S.amber }], [
          { text: `Session started`, style: S.amberBold },
          { text: ` · until ${clock(session.endsAt)} · every ${session.everyMinutes}m${session.flattenAtEnd ? ' · sells all at the end' : ''}`, style: S.muted }
        ]),
        ...wrap(null, [{ text: '  ' }], [{ text: session.strategy, style: { fg: C.text, italic: true } }], this.details ? Infinity : 3),
        []
      ]
    })

    // Group the steps by check for the dividers.
    const byCheck = new Map<string, AgentStep[]>()
    let currentCheck = ''
    for (const step of steps) {
      if (step.kind === 'check') currentCheck = step.id
      const group = byCheck.get(currentCheck) ?? []
      group.push(step)
      byCheck.set(currentCheck, group)
    }
    const answers = steps.filter((s) => s.kind === 'answer')
    const orderSteps = steps.filter((s) => s.kind === 'tool' && s.tool === 'trading_order')

    for (const step of steps) {
      if (step.kind === 'check') {
        const group = byCheck.get(step.id) ?? []
        const n = group.filter((s) => s.kind === 'tool').length
        const end = step.endedAt ?? group[group.length - 1]?.endedAt
        const label = ` CHECK ${step.check} `
        const tail = ` ${n} step${n === 1 ? '' : 's'}${end ? ` · ${mmss(end - step.at)}` : ' · running'} `
        items.push({
          at: step.at,
          rank: 1,
          lines: () => {
            const left = `─ ${clock(step.at)} `
            const fill = Math.max(2, width - strWidth(left) - strWidth(label) - strWidth(tail) - 1)
            return [
              [],
              [
                { text: left, style: { fg: '#3A3A3D' } },
                { text: label, style: { fg: C.ink, bg: step.endedAt ? '#5C5C61' : C.amber, bold: true } },
                { text: ` ${'─'.repeat(fill)}`, style: { fg: '#3A3A3D' } },
                { text: tail, style: S.faint }
              ]
            ]
          }
        })
        continue
      }
      if (step.kind === 'thought') {
        const text = (step.text ?? '').trim()
        if (!text) continue
        items.push({
          at: step.at,
          rank: 2,
          lines: () => {
            const style: Style = { fg: '#8A8A90', italic: true }
            const all = wrap(step.at, [{ text: '∴ ', style: S.faint }], [{ text: text.replace(/\s+/g, ' '), style }])
            if (this.details) return all
            // While it thinks, its newest lines; afterwards, the first one.
            if (step.endedAt === undefined && all.length > 2) return [[stamp(step.at), { text: '∴ ', style: S.faint }, { text: '…', style }], ...all.slice(-2).map((l) => [indent, { text: '  ' }, ...l.slice(2)])]
            return all.slice(0, 1).map((l, i) => (all.length > 1 && i === 0 ? [...l.slice(0, -1), { ...l[l.length - 1], text: `${l[l.length - 1].text.replace(/\s*$/, '')}…` }] : l))
          }
        })
        continue
      }
      if (step.kind === 'answer') {
        const text = (step.text ?? '').trim()
        if (!text) continue
        items.push({
          at: step.endedAt ?? step.at,
          rank: 4,
          lines: () => wrap(step.endedAt ?? step.at, [{ text: '▸ ', style: S.amberBold }], [{ text: text.replace(/\n{2,}/g, '\n').replace(/\s*\n\s*/g, ' · '), style: { fg: '#ECECEC' } }], this.details ? Infinity : 5)
        })
        continue
      }
      // A tool call.
      items.push({ at: step.at, rank: 3, lines: () => (step.tool === 'trading_order' ? this.orderStepLines(step, wrap) : this.toolLines(step, wrap)) })
    }

    // The engine's log: trades and notes from between checks, and decisions from checks this terminal didn't see.
    for (const entry of session.log) {
      if (entry.kind === 'decision') {
        const seen = answers.some((a) => Math.abs((a.endedAt ?? a.at) - entry.at) < 120_000)
        if (seen) continue
        items.push({ at: entry.at, rank: 4, lines: () => wrap(entry.at, [{ text: '▸ ', style: S.amberBold }], [{ text: entry.text.replace(/\s*\n\s*/g, ' · '), style: { fg: '#ECECEC' } }], this.details ? Infinity : 5) })
        continue
      }
      if (entry.kind === 'order') {
        // The agent's own orders already show as its tool calls.
        const parsed = parseOutcome(entry.text)
        const sameFill = (s: AgentStep): boolean => {
          const theirs = parseOutcome(s.output ?? '')
          if (!parsed || !theirs) return false
          if ('verb' in parsed && 'verb' in theirs) return parsed.verb === theirs.verb && parsed.qty === theirs.qty && parsed.symbol === theirs.symbol && parsed.at === theirs.at
          return 'refused' in parsed && 'refused' in theirs && parsed.refused === theirs.refused
        }
        const dup = orderSteps.some((s) => Math.abs(s.at - entry.at) < 120_000 && sameFill(s))
        if (dup) continue
        items.push({ at: entry.at, rank: 3, lines: () => this.logOrderLines(entry, parsed, wrap) })
        continue
      }
      // The start is already the feed's first line, with the strategy.
      if (entry.kind === 'note' && /^Started on /.test(entry.text)) continue
      items.push({ at: entry.at, rank: 3, lines: () => this.logNoteLines(entry, wrap) })
    }

    if (session.status !== 'running' && session.endedAt) {
      items.push({
        at: session.endedAt,
        rank: 9,
        lines: () => [
          [],
          ...wrap(session.endedAt!, [{ text: '■ ', style: S.muted }], [
            { text: `Session ${session.status}`, style: S.bold },
            ...(session.summary ? [{ text: ` · ${session.summary}`, style: S.muted }] : []),
            ...(session.error ? [{ text: ` · ${session.error}`, style: S.red }] : [])
          ])
        ]
      })
    }
    items.sort((a, b) => a.at - b.at || a.rank - b.rank)
    return items.flatMap((item) => item.lines())
  }

  private toolLines(step: AgentStep, wrap: (at: number | null, lead: Segment[], body: Segment[], max?: number) => Line[]): Line[] {
    const look = TOOL_LOOK[step.tool ?? ''] ?? { glyph: '•', label: step.tool ?? 'tool', color: C.muted }
    const input = step.input ?? {}
    const target =
      step.tool === 'trading_scan'
        ? String(input.list ?? 'gainers')
        : step.tool === 'web_search'
          ? `“${String(input.query ?? '')}”`
          : step.tool === 'web_fetch'
            ? String(input.url ?? '')
            : step.tool === 'trading_history'
              ? `${list(input.symbols).join(' ')} ${String(input.range ?? '6mo')}`
              : list(input.symbols).join(' ') || String(input.symbol ?? '').toUpperCase()
    const running = step.status === 'running'
    const head: Segment[] = [
      { text: look.label, style: { fg: look.color, bold: true } },
      ...(target ? [{ text: ` ${target}`, style: S.text }] : [])
    ]
    if (running) return wrap(step.at, [{ text: `${spinner()} `, style: { fg: C.amber } }], [...head, { text: ' …', style: S.faint }], 2)
    const result = toolResult(step)
    const lines = wrap(step.at, [{ text: `${look.glyph} `, style: { fg: look.color } }], [...head, { text: '  → ', style: S.faint }, { text: result.text, style: result.style }], this.details ? 3 : 2)
    if (this.details && step.output) {
      for (const l of step.output.split('\n').slice(0, 8)) lines.push(...wrap(null, [{ text: '  │ ', style: { fg: '#3A3A3D' } }], [{ text: l, style: S.faint }], 1))
    }
    return lines
  }

  /** An order the agent placed: the trade in colour, what became of it, its stop, and the reason it gave. */
  private orderStepLines(step: AgentStep, wrap: (at: number | null, lead: Segment[], body: Segment[], max?: number) => Line[]): Line[] {
    const input = step.input ?? {}
    const buy = input.side !== 'sell'
    const symbol = String(input.symbol ?? '').toUpperCase()
    const size = input.qty !== undefined ? `${shares(Number(input.qty))} ` : input.notional !== undefined ? `${usd(Number(input.notional), 0)} of ` : ''
    const color = buy ? C.green : C.red
    const trade: Segment = { text: `${buy ? 'BUY' : 'SELL'} ${size}${symbol}`, style: { fg: color, bold: true } }
    const limit = input.limit_price !== undefined ? [{ text: ` limit ${price(Number(input.limit_price))}`, style: S.muted }] : []
    if (step.status === 'running') return wrap(step.at, [{ text: `${spinner()} `, style: { fg: color } }], [trade, ...limit, { text: '  placing…', style: S.faint }])
    const out = step.output ?? ''
    const parsed = parseOutcome(out)
    let outcome: Segment[]
    if (step.status === 'error') outcome = [{ text: `  ✗ ${out.split('\n')[0]}`, style: S.red }]
    else if (parsed && 'verb' in parsed)
      outcome = [
        { text: `  filled @ ${parsed.at}`, style: S.text },
        { text: ` · $${parsed.value}`, style: S.muted },
        ...(parsed.realized ? [{ text: ` · ${parsed.realized}`, style: signStyle(parsed.realized.startsWith('-') ? -1 : 1, true) }] : [])
      ]
    else if (parsed && 'refused' in parsed) outcome = [{ text: '  REFUSED ', style: { fg: C.ink, bg: C.yellow, bold: true } }, { text: ` ${parsed.refused}`, style: S.yellow }]
    else outcome = [{ text: `  ${out.split('\n')[0].replace(/ It stays open.*$/, '')}`, style: S.muted }]
    const lines = wrap(step.at, [{ text: buy ? '▲ ' : '▼ ', style: { fg: color, bold: true } }], [trade, ...limit, ...outcome])
    // The protection the engine now watches, as it reported it; else what was asked for.
    const protectedBy = /Protected: (.*?)\.(?:\s|$)/.exec(out)?.[1]
    const asked = [
      input.stop_loss !== undefined ? `stop ${price(Number(input.stop_loss))}` : '',
      input.trailing_stop_pct !== undefined ? `trailing ${input.trailing_stop_pct}%` : '',
      input.take_profit !== undefined ? `target ${price(Number(input.take_profit))}` : ''
    ].filter(Boolean)
    const protection = protectedBy ?? (asked.length ? asked.join(', ') : '')
    if (protection) lines.push(...wrap(null, [{ text: '  ◈ ', style: { fg: C.yellow } }], [{ text: protection, style: S.muted }], 2))
    else if (buy && parsed && 'verb' in parsed) lines.push(...wrap(null, [{ text: '  ◈ ', style: { fg: C.yellow } }], [{ text: 'no stop set', style: S.yellow }], 1))
    if (input.reason) lines.push(...wrap(null, [{ text: '  “', style: S.faint }], [{ text: `${String(input.reason)}”`, style: { fg: C.muted, italic: true } }], this.details ? Infinity : 2))
    return lines
  }

  private logOrderLines(entry: TradingLogEntry, parsed: ReturnType<typeof parseOutcome>, wrap: (at: number | null, lead: Segment[], body: Segment[], max?: number) => Line[]): Line[] {
    if (parsed && 'verb' in parsed) {
      const buy = parsed.verb === 'Bought'
      const color = buy ? C.green : C.red
      const lines = wrap(entry.at, [{ text: buy ? '▲ ' : '▼ ', style: { fg: color, bold: true } }], [
        { text: `${buy ? 'BOUGHT' : 'SOLD'} ${parsed.qty} ${parsed.symbol}`, style: { fg: color, bold: true } },
        { text: `  @ $${parsed.at}`, style: S.text },
        { text: ` · $${parsed.value}`, style: S.muted },
        ...(parsed.realized ? [{ text: ` · ${parsed.realized}`, style: signStyle(parsed.realized.includes('-') ? -1 : 1, true) }] : [])
      ])
      if (parsed.before) lines.push(...wrap(null, [{ text: '  ', style: S.faint }], [{ text: parsed.before, style: S.muted }], 2))
      return lines
    }
    if (parsed && 'refused' in parsed) return wrap(entry.at, [{ text: '✗ ', style: S.yellow }], [{ text: `${parsed.what} refused: `, style: { fg: C.yellow, bold: true } }, { text: parsed.refused, style: S.muted }], 3)
    return wrap(entry.at, [{ text: '◆ ', style: S.cyan }], [{ text: entry.text, style: S.text }], 3)
  }

  private logNoteLines(entry: TradingLogEntry, wrap: (at: number | null, lead: Segment[], body: Segment[], max?: number) => Line[]): Line[] {
    if (entry.kind === 'error') return wrap(entry.at, [{ text: '✗ ', style: S.red }], [{ text: entry.text, style: S.red }], 3)
    if (entry.kind === 'message') return [[], ...wrap(entry.at, [{ text: '› ', style: S.amberBold }], [{ text: 'YOU  ', style: S.amberBold }, { text: entry.text, style: { fg: '#F4F4F5' } }])]
    if (entry.text.startsWith('⚡')) return wrap(entry.at, [{ text: '⚡ ', style: S.yellow }], [{ text: entry.text.replace(/^⚡\s*/, ''), style: { fg: C.yellow } }], 3)
    return wrap(entry.at, [{ text: '· ', style: S.faint }], [{ text: entry.text, style: S.muted }], 3)
  }

  /* ------------------------------------------------------------ mission */

  private chips(): Chip[] {
    const s = this.snap
    const config = s?.config
    const session = s?.activeSession ?? null
    const running = Boolean(session)
    const m = this.mission
    const until = parseRunFor(m.until)
    const limits = config?.limits
    const run = (work: () => Promise<void>): void => void work().catch((error) => this.view.app.toast(message(error), 'error'))
    const limit = (id: 'maxOrderUsd' | 'maxPositionPct' | 'maxInvestedPct' | 'maxDailyLossPct' | 'maxOrdersPerDay', label: string, show: (v: number) => string, stepBy: number, detail: string): Chip => ({
      id,
      label,
      value: limits ? show(limits[id]) : '—',
      edit: () =>
        this.view.app.push(
          new PromptModal({
            title: label.toLowerCase().replace(/^./, (ch) => ch.toUpperCase()),
            label: detail,
            initial: String(limits?.[id] ?? ''),
            onSubmit: async (value) => {
              const n = Number(value.replace(/[$,%\s]/g, ''))
              if (!Number.isFinite(n) || n <= 0) return 'A positive number.'
              try {
                await setConfig(this.view, { limits: { [id]: n } })
              } catch (error) {
                return message(error)
              }
            }
          })
        ),
      step: (by) => {
        if (!limits) return
        run(() => setConfig(this.view, { limits: { [id]: Math.max(stepBy, Math.round((limits[id] + by * stepBy) * 100) / 100) } }))
      },
      detail: `${detail} -/+ steps it by ${id === 'maxOrderUsd' ? usd(stepBy, 0) : id === 'maxOrdersPerDay' ? stepBy : `${stepBy}%`}; ⏎ types a value. Applies at once, to every order.`
    })
    const broker = config?.broker ?? 'simulator'
    const chips: Chip[] = [
      {
        id: 'strategy',
        label: 'GOAL',
        value: running ? 'running ✓' : m.strategy.trim() ? truncate(m.strategy.replace(/\s+/g, ' '), 22) : 'write one ✎',
        valueStyle: !running && !m.strategy.trim() ? { fg: C.yellow, bold: true } : undefined,
        locked: running,
        edit: () => this.editStrategy(),
        detail: running ? 'The goal the agent is working to. Stop it (X) to change the mission.' : 'What the agent should do, in your words: what to trade, how, and how much to risk. ⏎ writes it; G starts the agent on it.'
      },
      {
        id: 'runfor',
        label: 'RUN FOR',
        value: running
          ? session!.scheduleId && session!.scheduleId === this.mission.missionId
            ? `every market day · today till ${clock(session!.endsAt)}`
            : `${span(session!.endsAt - session!.startedAt)} · ${span(session!.endsAt - Date.now())} left`
          : m.until.trim().toLowerCase() === EVERY_DAY
            ? 'every market day'
            : until
              ? m.until.trim().toLowerCase() === 'close'
                ? `today till close ${clock(until)}`
                : /^\d/.test(m.until.trim()) && /[mh]$|^\d+(\.\d+)?$/.test(m.until.trim())
                  ? `${m.until.trim().replace(/^(\d+(?:\.\d+)?)$/, '$1h')} · till ${clock(until)}`
                  : `till ${clock(until)}`
              : m.until || '—',
        valueStyle: !running && !until && m.until.trim().toLowerCase() !== EVERY_DAY ? S.yellow : undefined,
        locked: running,
        edit: () =>
          this.view.app.push(
            new PromptModal({
              title: 'How long should the agent trade?',
              label: '“market” — every market day, from the open until the close, until you stop it. Or one session: hours (2, 4.5), minutes (90m), until a time (15:30), or close (today).',
              initial: m.until,
              onSubmit: (value) => {
                const v = value.trim().toLowerCase()
                if (v !== EVERY_DAY && !parseRunFor(value)) return 'Try market, 2, 4.5, 90m, 15:30, or close.'
                this.mission.until = v === EVERY_DAY ? EVERY_DAY : value.trim()
                this.saveMission()
              }
            })
          ),
        step: (by) => {
          if (running) return this.view.app.toast('Stop the session (X) to change how long it runs')
          const at = RUN_FOR.indexOf(m.until.trim().toLowerCase())
          this.mission.until = RUN_FOR[Math.max(0, Math.min(RUN_FOR.length - 1, (at === -1 ? 0 : at) + by))]
          this.saveMission()
        },
        detail: running
          ? session!.scheduleId && session!.scheduleId === this.mission.missionId
            ? `Today’s session ends at ${clock(session!.endsAt)}, just before the close; it starts again at the next open.`
            : `The session runs ${span(session!.endsAt - session!.startedAt)} in all and ends at ${clock(session!.endsAt)}.`
          : 'Every market day: from the open until the close, again at each open, until you stop it. -/+ for one session instead (today until the close, 30 min to 8 h); ⏎ types any hours or a time.'
      },
      {
        id: 'every',
        label: 'EVERY',
        value: `${running ? session!.everyMinutes : m.every}m`,
        locked: running,
        edit: () => this.stepEvery(1),
        step: (by) => this.stepEvery(by),
        detail: 'How often the agent looks at the market and decides. -/+ or ⏎ changes it.'
      },
      {
        id: 'flatten',
        label: 'AT END',
        value: (running ? session!.flattenAtEnd : m.flatten) ? 'sell all' : 'hold',
        locked: running,
        edit: () => {
          this.mission.flatten = !this.mission.flatten
          this.saveMission()
        },
        detail: 'Whether everything is sold when the session runs its course. A stop or the kill switch keeps holdings.'
      },
      {
        id: 'broker',
        label: 'ACCOUNT',
        value: broker === 'alpaca-live' ? 'Alpaca LIVE' : broker === 'alpaca-paper' ? 'Alpaca paper' : config?.simulatorAnytime ? 'simulator · any time' : 'simulator',
        valueStyle: broker === 'alpaca-live' ? S.redBold : undefined,
        edit: () => this.nextAccount(1),
        step: (by) => this.nextAccount(by),
        detail:
          'The account the agent trades: the simulator, or an Alpaca account you linked (LINKED). ⏎ or -/+ switches between them; switching stops a running session. Real money asks you to confirm first.'
      },
      {
        id: 'agent',
        label: 'AGENT',
        value: (running ? session!.driver === 'claude-code' : m.driver === 'claude-code') ? '✻ Claude Code' : 'Eaon',
        valueStyle: (running ? session!.driver === 'claude-code' : m.driver === 'claude-code') ? { fg: '#D97757', bold: true } : undefined,
        locked: running,
        edit: () => this.toggleDriver(),
        step: () => this.toggleDriver(),
        detail: running
          ? session!.driver === 'claude-code'
            ? `Claude Code runs this session. It takes it when you type ${HANDOFF} in Claude Code (/claude).`
            : 'Eaon’s own agent runs this session.'
          : `Who trades: Eaon’s own agent on the model below, or your Claude Code with full control of the account — G opens it, and you hand it the session with ${HANDOFF}. ⏎ switches.`
      },
      {
        id: 'model',
        label: 'MODEL',
        value: (running ? session!.driver === 'claude-code' : m.driver === 'claude-code') ? 'Claude Code’s own' : config?.model ? config.model.modelId : `${modelLabel(chatModel())} (chat)`,
        valueStyle: (running ? session!.driver === 'claude-code' : m.driver === 'claude-code') ? S.muted : undefined,
        edit: () => (m.driver === 'claude-code' && !running ? this.view.app.toast('Claude Code uses its own model; pick it there with /model') : pickTradingModel(this.view)),
        detail: m.driver === 'claude-code' ? 'Claude Code trades on whichever model you choose in Claude Code itself.' : 'The model each check runs on. A fast model that uses tools well suits five-minute checks.'
      },
      {
        id: 'linked',
        label: 'LINKED',
        value: linkedCount(s) ? `${linkedCount(s)} account${linkedCount(s) === 1 ? '' : 's'}` : 'link one',
        valueStyle: linkedCount(s) ? undefined : { fg: C.yellow, bold: true },
        edit: () => this.view.app.push(new LinkedAccountsModal(this.view)),
        detail: 'Alpaca (paper or live) for the agent to trade, and Robinhood, Interactive Brokers, Webull, Tradier or any broker’s MCP server for the chat, workers and Claude Code. ⏎ opens them.'
      },
      {
        id: 'claude',
        label: 'CLAUDE CODE',
        value: claudeMayTradeLive() ? 'real money too' : 'practice money',
        valueStyle: claudeMayTradeLive() ? S.redBold : undefined,
        edit: () => this.toggleClaudeLive(),
        detail: 'What Claude Code (/claude) may trade through Eaon: practice money (simulator, paper), or real money too — always inside your limits. ⏎ switches.'
      },
      limit('maxOrderUsd', 'PER ORDER', (v) => usd(v, 0), 250, 'The largest single order, in dollars.'),
      limit('maxPositionPct', 'PER STOCK', (v) => `${v}%`, 1, 'The largest holding in one stock, as a share of equity.'),
      limit('maxInvestedPct', 'INVESTED ≤', (v) => `${v}%`, 5, 'At most this share of equity in stocks; the rest stays cash.'),
      limit('maxDailyLossPct', 'DAY LOSS', (v) => `${v}%`, 0.5, 'Buying stops for the day once equity is down this much.'),
      limit('maxOrdersPerDay', 'ORDERS/DAY', (v) => String(v), 5, 'A cap on orders per day, from every source.'),
      {
        id: 'symbols',
        label: 'SYMBOLS',
        value: limits?.allowedSymbols.length ? truncate(limits.allowedSymbols.join(' '), 18) : 'any',
        edit: () =>
          this.view.app.push(
            new PromptModal({
              title: 'Allowed symbols',
              label: 'Only these tickers, separated by spaces. Empty allows any US stock or ETF.',
              initial: limits?.allowedSymbols.join(' ') ?? '',
              onSubmit: async (value) => {
                try {
                  await setConfig(this.view, { limits: { allowedSymbols: value.toUpperCase().split(/[\s,]+/).filter(Boolean) } })
                } catch (error) {
                  return message(error)
                }
              }
            })
          ),
        detail: 'Limit the agent to a list of tickers, or leave it free.'
      },
      ...(broker === 'simulator'
        ? [
            {
              id: 'anytime',
              label: 'SIM FILLS',
              value: config?.simulatorAnytime ? 'any time' : 'market hours',
              edit: () => run(() => setConfig(this.view, { simulatorAnytime: !config?.simulatorAnytime })),
              detail: 'Whether the simulator fills outside market hours, at the last price. For practice on evenings and weekends.'
            } as Chip
          ]
        : []),
      {
        id: 'disclaimer',
        label: 'DISCLAIMER',
        value: s?.needsDisclaimer ? 'not accepted' : config?.disclaimer ? `accepted ${new Date(config.disclaimer.acceptedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}` : 'accepted',
        valueStyle: s?.needsDisclaimer ? { fg: C.ink, bg: C.yellow, bold: true } : { fg: C.green },
        edit: () => this.view.app.push(new DisclaimerModal(this.view)),
        detail: s?.needsDisclaimer ? 'Nothing trades until you read the disclaimer, tick the box and accept. ⏎ opens it.' : 'You accepted the trading disclaimer. ⏎ reads it again.'
      },
      {
        id: 'kill',
        label: 'KILL',
        value: config?.halted ? 'ON' : 'off',
        valueStyle: config?.halted ? { fg: '#FFFFFF', bg: '#B3261E', bold: true } : S.muted,
        edit: () => confirmKill(this.view),
        detail: config?.halted ? 'Nothing trades until it is off. ⏎ to switch it off.' : 'Stops the session and refuses every order until switched off. ⏎ or K.'
      }
    ]
    return chips
  }

  /** ⏎ on ACCOUNT: the next account the agent can trade — the simulator, and each Alpaca account with keys. */
  private nextAccount(by: 1 | -1): void {
    const s = this.snap
    if (!s) return
    const accounts: TradingSnapshot['config']['broker'][] = ['simulator', ...(s.keys.paper ? (['alpaca-paper'] as const) : []), ...(s.keys.live ? (['alpaca-live'] as const) : [])]
    if (accounts.length === 1) {
      this.view.app.toast('Link an Alpaca account first (LINKED), or practise on the simulator')
      return this.view.app.push(new LinkedAccountsModal(this.view))
    }
    const next = accounts[(accounts.indexOf(s.config.broker) + by + accounts.length) % accounts.length]
    // Real money needs its typed confirmation, which the setup asks for.
    if (next === 'alpaca-live' && !s.config.liveConfirmedAt) return openSetup(this.view)
    const go = (): void =>
      void setConfig(this.view, { broker: next })
        .then(() => this.view.app.toast(`The agent trades on ${next === 'alpaca-live' ? 'Alpaca LIVE — real money' : next === 'alpaca-paper' ? 'Alpaca paper' : 'the simulator'}`, next === 'alpaca-live' ? 'error' : 'info'))
        .catch((error) => this.view.app.toast(message(error), 'error'))
    if (s.activeSession) void ask(this.view, 'Switch accounts?', 'Switching the account stops the running session.', false, 'switch').then((yes) => yes && go())
    else go()
  }

  private toggleDriver(): void {
    if (this.snap?.activeSession) return this.view.app.toast('Stop the session (X) to change who trades')
    this.mission.driver = this.mission.driver === 'claude-code' ? 'eaon' : 'claude-code'
    this.saveMission()
    this.view.app.toast(this.mission.driver === 'claude-code' ? `Claude Code will trade: G opens it, then type ${HANDOFF}` : 'Eaon’s own agent will trade', 'info', 3500)
  }

  private toggleClaudeLive(): void {
    if (claudeMayTradeLive()) {
      store.setJson(CLAUDE_CONTROL_FILE, { liveMoney: false })
      return this.view.app.toast('Claude Code trades practice money only')
    }
    void ask(this.view, 'Let Claude Code trade real money?', 'Claude Code (/claude) could then place orders on Alpaca live through Eaon — inside your limits and the kill switch, but without asking you each time.', true, 'allow').then((yes) => {
      if (!yes) return
      store.setJson(CLAUDE_CONTROL_FILE, { liveMoney: true })
      this.view.app.toast('Claude Code may trade real money', 'error')
    })
  }

  private stepEvery(by: 1 | -1): void {
    if (this.snap?.activeSession) return this.view.app.toast('Stop the session (X) to change how often it checks')
    const at = EVERY.indexOf(this.mission.every)
    this.mission.every = EVERY[Math.max(0, Math.min(EVERY.length - 1, (at === -1 ? 2 : at) + by))]
    this.saveMission()
  }

  private editStrategy(): void {
    if (this.snap?.activeSession) return this.view.app.toast('The running session keeps its goal. Stop it (X) to change the mission.')
    this.view.app.push(
      new EditForm({
        title: 'The agent’s goal',
        intro: `What the agent should do, in your words: what to trade, what to look for, when to buy and sell, how much to risk. ${this.mission.driver === 'claude-code' ? 'Claude Code' : 'The agent'} works to it every check, inside your limits.${this.armedMission() ? ' The mission is armed: G after this updates it.' : ''}`,
        width: 92,
        initial: { strategy: this.mission.strategy },
        fields: [{ key: 'strategy', label: 'Goal', kind: 'multiline', placeholder: 'e.g. Momentum in large caps: buy breakouts above the 20-day high on strong volume, stop at 2× ATR, take profits into strength…' }],
        onSubmit: (v) => {
          this.mission.strategy = (v.strategy ?? '').trim()
          this.saveMission()
        }
      })
    )
  }

  /** T, then ⏎: to the running session's agent, which reads it in a check that starts now; else to the trading chat. */
  private async sendTalk(): Promise<void> {
    const text = this.talkField.value.trim()
    if (!text) return
    this.talkField.remember(text)
    this.talkField.clear()
    this.talking = false
    const session = this.snap?.activeSession
    if (!session) return this.view.askAgent(text)
    try {
      this.view.snapshot = await invoke<TradingSnapshot>('trading:tell-session', session.id, text)
      this.feedBack = 0
      this.view.app.toast(this.snap?.agent?.checking ? 'Sent — the agent reads it as soon as this check ends' : 'Sent — the agent is reading it now', 'success', 2500)
    } catch (error) {
      this.view.app.toast(message(error), 'error')
    }
  }

  /** G: starts the agent on the mission as set. */
  async start(): Promise<void> {
    const s = this.snap
    if (!s) return this.view.app.toast(this.view.loadError ?? 'The desk is still loading', 'error')
    if (s.activeSession) return this.view.app.toast('The agent is already trading. X stops it.')
    if (s.config.halted) return this.view.app.toast('The kill switch is on. K switches it off.', 'error')
    if (s.needsDisclaimer) return void afterDisclaimer(this.view, () => void this.start())
    if (!this.mission.strategy.trim()) {
      this.chip = 0
      return this.editStrategy()
    }
    const everyDay = this.mission.until.trim().toLowerCase() === EVERY_DAY
    const until = everyDay ? null : parseRunFor(this.mission.until)
    if (!everyDay && !until) return this.view.app.toast('Set RUN FOR first: market, 2 (hours), 90m, 15:30 or close', 'error')
    if (s.config.broker === 'alpaca-live' && !(await ask(this.view, 'Real money', `Let the agent trade your live Alpaca account on its own ${everyDay ? 'every market day until you stop it' : 'until the end time'}?`, true, 'start'))) return
    const claude = this.mission.driver === 'claude-code'
    if (everyDay) return this.armMission(claude)
    try {
      await invoke('trading:start-session', {
        strategy: this.mission.strategy.trim(),
        until,
        everyMinutes: this.mission.every,
        flattenAtEnd: this.mission.flatten,
        ...(claude ? { driver: 'claude-code' } : {})
      })
      // Show it running now rather than at the engine's next push.
      this.view.snapshot = await invoke<TradingSnapshot>('trading:snapshot')
      this.feedBack = 0
      if (claude) {
        // Claude Code takes the session only when the user hands it over there.
        this.view.app.switchMode('claude')
        this.view.app.toast(`Session ready — type ${HANDOFF} in Claude Code to hand it over`, 'success', 6000)
      } else this.view.app.toast('The agent is trading', 'success')
    } catch (error) {
      this.view.app.toast(message(error), 'error')
    }
  }

  /**
   * G with RUN FOR "every market day": the mission becomes a market-hours
   * schedule. If the market is open the engine starts today's session at
   * once; either way a new one starts at every open until it is stopped.
   */
  private async armMission(claude: boolean): Promise<void> {
    const goal = this.mission.strategy.trim()
    const armed = this.armedMission() ? 'Mission updated' : 'Mission armed'
    try {
      const schedule = await invoke<TradingSchedule>('trading:save-schedule', {
        ...(this.mission.missionId && this.snap?.schedules.some((x) => x.id === this.mission.missionId) ? { id: this.mission.missionId } : {}),
        name: goal.length <= 40 ? goal : `${goal.slice(0, 39).trimEnd()}…`,
        days: [1, 2, 3, 4, 5],
        start: '09:30',
        end: '16:00',
        strategy: goal,
        everyMinutes: this.mission.every,
        flattenAtEnd: this.mission.flatten,
        enabled: true,
        marketHours: true,
        ...(claude ? { driver: 'claude-code' } : {})
      })
      this.mission.missionId = schedule.id
      this.saveMission()
      // Armed on screen at once; the engine's snapshot follows.
      const snap = this.view.snapshot
      if (snap) this.view.snapshot = { ...snap, schedules: [...snap.schedules.filter((x) => x.id !== schedule.id), schedule] }
      this.feedBack = 0
      const now = Date.now()
      // While the market is open (until five minutes before the close) the engine starts today's session at once.
      const open = isOpen(now) && nextClose(now) - now > 5 * 60_000
      // Show the armed mission, and today's session once the engine has started it, without holding up the switch.
      for (const delay of [0, 800])
        setTimeout(() => void invoke<TradingSnapshot>('trading:snapshot').then((snapshot) => (this.view.snapshot = snapshot), () => {}), delay)
      const opens = `${dayClock(nextOpen(now))} (in ${span(nextOpen(now) - now)})`
      if (claude) {
        this.view.app.switchMode('claude')
        this.view.app.toast(`${armed} — type ${HANDOFF} in Claude Code to hand it over${open ? '' : `; it starts trading at the open, ${opens}`}`, 'success', 7000)
      } else this.view.app.toast(open ? 'The agent is trading until the close, and again at every open' : `${armed}: the agent starts at the open, ${opens}`, 'success', 5000)
    } catch (error) {
      this.view.app.toast(message(error), 'error')
    }
  }

  /** X: stops the agent — today's session and, if one is armed, the every-day mission. */
  stopAgent(): void {
    const s = this.snap
    const mission = this.armedMission()
    const active = s?.activeSession
    if (!mission) {
      if (active) return stopSession(this.view)
      return this.view.app.toast('The agent isn’t running. G starts it.')
    }
    void ask(
      this.view,
      'Stop the agent?',
      `Stops ${active ? 'today’s session and ' : ''}the every-day mission: it won’t start again at the next open.${active ? ' Its open orders are cancelled; holdings are kept.' : ''}`,
      false,
      'stop'
    ).then(async (yes) => {
      if (!yes) return
      try {
        await invoke('trading:save-schedule', { ...mission, enabled: false })
        if (active) await invoke('trading:stop-session', active.id)
        this.view.snapshot = await invoke<TradingSnapshot>('trading:snapshot')
        this.view.app.toast('Stopped — the mission is off')
      } catch (error) {
        this.view.app.toast(message(error), 'error')
      }
    })
  }

  async checkNow(): Promise<void> {
    const session = this.snap?.activeSession
    if (!session) return this.view.app.toast('No session is running. G starts one.')
    if (this.snap?.agent?.checking) return this.view.app.toast('It is checking right now.')
    try {
      this.view.snapshot = await invoke<TradingSnapshot>('trading:check-now', session.id)
      this.feedBack = 0
    } catch (error) {
      this.view.app.toast(message(error), 'error')
    }
  }

  private drawMission(c: Canvas): void {
    const s = this.snap
    const session = s?.activeSession ?? null
    const now = Date.now()
    const open = isOpen(now)
    const right: Segment[] = [
      { text: open ? '● MARKET OPEN' : '○ MARKET CLOSED', style: open ? S.green : S.muted },
      { text: open ? ` · closes in ${span(nextClose(now) - now)}  ` : ` · opens in ${span(nextOpen(now) - now)}  `, style: S.faint },
      s?.config.halted ? { text: ' KILL SWITCH ON ', style: { fg: '#FFFFFF', bg: '#B3261E', bold: true } } : { text: 'kill switch off', style: S.faint }
    ]
    const inner = panel(c, 'Mission control', { right, focused: true })
    if (inner.h < 2) return
    let y = 0

    // What the agent is on now.
    const mission = this.armedMission()
    const badge = session
      ? { text: ' ● RUNNING ', style: { fg: C.ink, bg: C.green, bold: true } }
      : s?.config.halted
        ? { text: ' ■ HALTED ', style: { fg: '#FFFFFF', bg: '#B3261E', bold: true } }
        : s?.needsDisclaimer
          ? { text: ' ⚠ DISCLAIMER ', style: { fg: C.ink, bg: C.yellow, bold: true } }
          : mission
            ? { text: ' ◷ MISSION ARMED ', style: { fg: C.ink, bg: C.amber, bold: true } }
            : { text: ' ○ READY ', style: { fg: C.ink, bg: '#8E8E93', bold: true } }
    const status: Segment[] = [badge, { text: ' ' }]
    if (session) {
      // How much of its time it has used.
      const used = Math.max(0, Math.min(1, (now - session.startedAt) / Math.max(1, session.endsAt - session.startedAt)))
      const cells = 10
      status.push(
        { text: truncate(session.name, 34), style: S.bold },
        { text: '  ' },
        { text: '▰'.repeat(Math.round(used * cells)), style: { fg: C.green } },
        { text: '▱'.repeat(cells - Math.round(used * cells)), style: { fg: '#3A3A3D' } },
        {
          text:
            mission && session.scheduleId === mission.id
              ? ` ${span(session.endsAt - now)} left today · ends ${clock(session.endsAt)}, before the close · starts again at each open · ${count(session.checks, 'check')} · ${count(session.orders, 'order')}`
              : ` ${span(session.endsAt - now)} left of ${span(session.endsAt - session.startedAt)} · ends ${clock(session.endsAt)} · ${count(session.checks, 'check')} · ${count(session.orders, 'order')}`,
          style: S.muted
        }
      )
    } else if (s?.needsDisclaimer) {
      status.push(
        { text: 'Accept the trading disclaimer first', style: { fg: C.yellow, bold: true } },
        { text: '  nothing can trade until you do: G, or ⏎ on DISCLAIMER', style: S.muted }
      )
    } else if (mission && !s?.config.halted) {
      // Between sessions of the every-day mission.
      const claude = mission.driver === 'claude-code'
      const at = nextOpen(now)
      status.push(
        { text: `${claude ? 'Claude Code' : 'The agent'} starts at the open, ${dayClock(at)}`, style: S.bold },
        { text: ` · in ${span(at - now)} · trades until the close, every market day`, style: S.muted },
        ...(claude
          ? s?.claudeWaiting
            ? [{ text: '  ✻ Claude Code is waiting for it', style: { fg: '#D97757' } }]
            : [{ text: `  ✻ hand it over first: /claude, then ${HANDOFF}`, style: S.yellow }]
          : []),
        { text: '  ·  X stops it', style: S.faint }
      )
    } else {
      const everyDay = this.mission.until.trim().toLowerCase() === EVERY_DAY
      const until = everyDay ? null : parseRunFor(this.mission.until)
      const hours = until ? Math.round(((until - now) / 3_600_000) * 10) / 10 : null
      const who = this.mission.driver === 'claude-code' ? 'Claude Code' : 'the agent'
      const checking = `checking every ${this.mission.every}m${this.mission.flatten ? ', selling all at the end' : ''}`
      status.push(
        { text: this.mission.strategy.trim() ? 'Mission ready' : 'No goal yet', style: S.bold },
        {
          text: !this.mission.strategy.trim()
            ? '  ← → to GOAL and ⏎ to write one'
            : everyDay
              ? `  G: ${who} trades from the open until the close, every market day — ${open ? 'starting now' : `first at ${dayClock(nextOpen(now))}`} — ${checking}`
              : `  G starts ${who} for ${hours !== null ? `${hours} h, until ${clock(until!)}` : '—'}, ${checking}`,
          style: S.muted
        }
      )
    }
    inner.segments(0, y++, status, inner.w)

    if (inner.h >= 5) {
      const strategy = (session?.strategy ?? this.mission.strategy).replace(/\s+/g, ' ').trim()
      inner.segments(0, y++, [{ text: 'GOAL  ', style: S.muted }, { text: strategy || '—', style: { fg: strategy ? C.text : C.faint, italic: Boolean(strategy) } }], inner.w)
    }

    // The settings, as chips; ←→ moves between them.
    const chips = this.chips()
    this.chip = Math.max(0, Math.min(this.chip, chips.length - 1))
    const chipRows = inner.h >= 6 ? 2 : 1
    let row = 0
    let x = 0
    const rows: { chip: Chip; index: number; x: number; row: number; width: number }[] = []
    chips.forEach((chip, index) => {
      const width = strWidth(chip.label) + strWidth(chip.value) + 3
      if (x > 0 && x + width > inner.w) {
        row++
        x = 0
      }
      rows.push({ chip, index, x, row, width })
      x += width + 1
    })
    // When everything doesn't fit, scroll so the selected one shows.
    const selectedRow = rows.find((r) => r.index === this.chip)?.row ?? 0
    const firstRow = Math.max(0, selectedRow - chipRows + 1)
    for (const r of rows) {
      const ry = r.row - firstRow
      if (ry < 0 || ry >= chipRows) continue
      const selected = r.index === this.chip
      const bg = selected ? C.amber : '#1C1C1F'
      const labelStyle: Style = selected ? { fg: C.ink, bg, bold: true } : { fg: C.muted, bg }
      const valueStyle: Style = selected ? { fg: C.ink, bg, bold: true } : { ...(r.chip.valueStyle ?? { fg: r.chip.locked ? C.muted : C.text }), bg: r.chip.valueStyle?.bg ?? bg }
      inner.segments(r.x, y + ry, [
        { text: ` ${r.chip.label} `, style: labelStyle },
        { text: r.chip.value, style: valueStyle },
        { text: ' ', style: { bg } }
      ])
      this.rects.chips.push({ rect: { x: inner.rect.x + r.x, y: inner.rect.y + y + ry, w: r.width, h: 1 }, index: r.index })
    }
    y += chipRows

    // Gauges of the day against its limits, and the controls.
    if (y < inner.h) {
      const st = s?.stats
      const limits = s?.config.limits
      const gauge = (label: string, used: number, max: number, text: string): Segment[] => {
        const f = max > 0 ? Math.max(0, Math.min(1, used / max)) : 0
        const cells = 8
        const filled = Math.round(f * cells)
        const color = f >= 0.9 ? C.red : f >= 0.6 ? C.amber : C.green
        return [
          { text: `${label} `, style: S.muted },
          { text: '▰'.repeat(filled), style: { fg: color } },
          { text: '▱'.repeat(cells - filled), style: { fg: '#3A3A3D' } },
          { text: ` ${text}   `, style: f >= 0.9 ? S.red : S.text }
        ]
      }
      const dayLoss = Math.max(0, -(st?.todayReturnPct ?? 0))
      const gauges: Segment[] =
        st && limits
          ? [
              ...gauge('ORDERS', st.ordersToday, limits.maxOrdersPerDay, `${st.ordersToday}/${limits.maxOrdersPerDay}`),
              ...gauge('DAY LOSS', dayLoss, limits.maxDailyLossPct, `${dayLoss.toFixed(1)}/${limits.maxDailyLossPct}%`),
              ...gauge('INVESTED', st.investedPct, limits.maxInvestedPct, `${st.investedPct.toFixed(0)}/${limits.maxInvestedPct}%`),
              { text: 'DRAWDOWN ', style: S.muted },
              { text: pct(st.maxDrawdownPct), style: st.maxDrawdownPct > 5 ? S.red : S.text }
            ]
          : []
      const button = (key: string, label: string, on = true, danger = false): Segment[] => [
        { text: ` ${key} `, style: on ? { fg: C.ink, bg: danger ? C.red : C.amber, bold: true } : { fg: C.faint, bg: '#1C1C1F' } },
        { text: ` ${label}  `, style: on ? (danger ? S.red : S.text) : S.faint }
      ]
      const controls: Segment[] = session
        ? [...button('N', 'CHECK NOW', !s?.agent?.checking), ...button('X', 'STOP'), ...button('K', s?.config.halted ? 'RESUME' : 'KILL', true, !s?.config.halted)]
        : [...button('G', this.armedMission() ? 'UPDATE' : 'START', Boolean(this.mission.strategy.trim()) && !s?.config.halted), ...(this.armedMission() ? button('X', 'STOP') : []), ...button('K', s?.config.halted ? 'RESUME' : 'KILL', true, !s?.config.halted)]
      const controlsW = controls.reduce((n, seg) => n + strWidth(seg.text), 0)
      inner.segments(0, y, gauges, Math.max(0, inner.w - controlsW - 2))
      inner.segments(inner.w - controlsW, y, controls)
      y++
    }
    // What the selected setting does.
    if (y < inner.h) {
      const chip = chips[this.chip]
      if (chip) inner.segments(0, y, [{ text: `${chip.label.toLowerCase().replace(/^./, (ch) => ch.toUpperCase())}: `, style: S.amber }, { text: chip.detail, style: S.faint }], inner.w)
    }
  }

  /* ================================================================ keys */

  hints(): [string, string][] {
    return [
      ['←→', 'setting'],
      ['⏎', 'change'],
      ['-/+', 'step'],
      ['T', 'talk'],
      ['‹ ›', 'sessions'],
      ['↑↓', 'holding'],
      ['E', 'stop/target'],
      ['⇞⇟', 'activity'],
      ['D', this.details ? 'less' : 'details'],
      ['[ ]', 'chart']
    ]
  }

  /** Keys and mouse for this page; false lets the desk's own keys (B, S, X, K, M…) have them. */
  onEvent(event: InputEvent): boolean {
    if (this.talking && event.type !== 'mouse') {
      if (event.type === 'key' && event.name === 'escape') {
        this.talking = false
        return true
      }
      if (this.talkField.handle(event, 200) === 'submit') void this.sendTalk()
      return true
    }
    if (event.type === 'mouse') {
      const { x, y } = event
      if (event.action === 'wheelup' || event.action === 'wheeldown') {
        const up = event.action === 'wheelup'
        if (inside(this.rects.holdings, x, y)) this.holdings.move(up ? -1 : 1, this.view.positions().length)
        else this.feedBack = Math.max(0, this.feedBack + (up ? 3 : -3))
        return true
      }
      if (event.action === 'down') {
        const chip = this.rects.chips.find((r) => inside(r.rect, x, y))
        if (chip) {
          if (chip.index === this.chip) this.chips()[chip.index]?.edit()
          this.chip = chip.index
          return true
        }
        const range = this.rects.ranges.find((r) => inside(r.rect, x, y))
        if (range) {
          this.range = range.id
          return true
        }
        if (inside(this.rects.holdings, x, y)) {
          // The first row under the header is the first holding.
          const index = y - (this.rects.holdings!.y + 1)
          if (index >= 0 && index < this.view.positions().length) this.holdings.selected = index
          return true
        }
      }
      return false
    }
    if (event.type !== 'key' || event.ctrl || event.meta) return false
    const chips = this.chips()
    switch (event.name) {
      case 'left':
        this.chip = Math.max(0, this.chip - 1)
        return true
      case 'right':
        this.chip = Math.min(chips.length - 1, this.chip + 1)
        return true
      case 'enter':
        chips[this.chip]?.edit()
        return true
      case 'up':
        this.holdings.move(-1, this.view.positions().length)
        return true
      case 'down':
        this.holdings.move(1, this.view.positions().length)
        return true
      case 'pageup':
        this.feedBack += 10
        return true
      case 'pagedown':
        this.feedBack = Math.max(0, this.feedBack - 10)
        return true
      case 'home':
        this.feedBack = Number.MAX_SAFE_INTEGER
        return true
      case 'end':
        this.feedBack = 0
        return true
    }
    switch (event.ch) {
      case '+':
      case '=':
        chips[this.chip]?.step?.(1)
        return true
      case '-':
      case '_':
        chips[this.chip]?.step?.(-1)
        return true
      case 'g':
      case 'G':
        void this.start()
        return true
      case 'n':
      case 'N':
        void this.checkNow()
        return true
      case 'x':
      case 'X':
        this.stopAgent()
        return true
      case 'e':
      case 'E': {
        const position = this.view.positions()[this.holdings.selected]
        if (position) openExit(this.view, position)
        else this.view.app.toast('Nothing held to protect.')
        return true
      }
      case 'd':
      case 'D':
        this.details = !this.details
        return true
      case 't':
      case 'T':
        this.talking = true
        return true
      case ',':
      case '<':
        this.pageSessions(1)
        return true
      case '.':
      case '>':
        this.pageSessions(-1)
        return true
      case '[':
      case ']': {
        const ids = RANGES.filter((r) => r.id !== 'session' || this.snap?.activeSession).map((r) => r.id)
        const current = this.snap ? this.chartRange(this.snap) : '1d'
        const at = Math.max(0, ids.indexOf(current))
        this.range = ids[Math.max(0, Math.min(ids.length - 1, at + (event.ch === ']' ? 1 : -1)))]
        return true
      }
    }
    return false
  }
}
