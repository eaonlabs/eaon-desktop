import type { TradingOrder, TradingPosition, TradingSchedule, TradingSession } from '@shared/trading'
import type { ScreenRow } from '@main/features/trading/marketData'
import { INDEXES, RATES, watchlist } from '../../../core/market'
import { axisLabels, bar, lineChart, sparkline } from '../../charts'
import { wrapSegments, type Line } from '../../markdown'
import type { Canvas } from '../../screen'
import { strWidth, truncate, type Style } from '../../term'
import { C, S, signStyle } from '../../theme'
import { panel, Table, type Column } from '../../widgets'
import { drawDetail } from './detail'
import { arrow, pct, price, shares, signedPct, signedUsd, span, time, usd, usdShort, volume } from './format'
import type { TradingView } from './index'

/**
 * The desk's pages. Each draws into the area under the header with panels
 * in the terminal style: a bordered box with its title on a dark bar.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function daysLabel(days: number[]): string {
  const set = [...new Set(days)].sort()
  if (set.join() === '1,2,3,4,5') return 'Mon–Fri'
  if (set.length === 7) return 'every day'
  if (set.join() === '0,6') return 'weekends'
  return set.map((d) => DAY_NAMES[d]).join(' ')
}

/* ----------------------------------------------------------- columns */

/** When the current holding was opened, from the ledger: the last time the position went from nothing to something. */
function heldSince(orders: TradingOrder[], symbol: string): number | null {
  const fills = orders.filter((o) => o.symbol === symbol && o.filledQty > 0 && o.filledAt).sort((a, b) => (a.filledAt ?? 0) - (b.filledAt ?? 0))
  let qty = 0
  let openedAt: number | null = null
  for (const o of fills) {
    const before = qty
    qty += o.side === 'buy' ? o.filledQty : -o.filledQty
    if (before <= 1e-9 && qty > 1e-9) openedAt = o.filledAt
    if (qty <= 1e-9) openedAt = null
  }
  return openedAt
}

function exitText(position: TradingPosition): { text: string; style: Style } {
  const exit = position.exit
  if (!exit) return { text: 'none', style: { fg: C.yellow } }
  const parts: string[] = []
  if (exit.activeStop) {
    const away = ((position.price - exit.activeStop) / position.price) * 100
    parts.push(`${exit.trailPct ? `trail ${exit.trailPct}% ` : 'stop '}${price(exit.activeStop)} (${away.toFixed(1)}%)`)
  }
  if (exit.targetPrice) parts.push(`tgt ${price(exit.targetPrice)}`)
  const near = exit.activeStop ? (position.price - exit.activeStop) / position.price < 0.02 : false
  return { text: parts.join(' · ') || '—', style: near ? { fg: C.yellow, bold: true } : S.muted }
}

/** Holdings columns; `compact` (the home page) drops the market value and age to leave the exit room. */
export function holdingColumns(view: TradingView, compact = false): Column<TradingPosition>[] {
  return [
    { title: 'SYMBOL', width: 7, cell: (p) => ({ text: p.symbol, style: S.bold }) },
    { title: 'QTY', width: 7, align: 'right', cell: (p) => shares(p.qty) },
    { title: 'AVG', width: 9, align: 'right', cell: (p) => price(p.avgPrice) },
    { title: 'LAST', width: 9, align: 'right', cell: (p) => price(p.price) },
    { title: 'DAY', width: 7, align: 'right', cell: (p) => ({ text: signedPct(p.dayChangePct), style: signStyle(p.dayChangePct) }) },
    ...(compact ? [] : ([{ title: 'MKT VAL', width: 9, align: 'right', cell: (p: TradingPosition) => usdShort(p.marketValue) }] as Column<TradingPosition>[])),
    { title: 'P&L', width: 10, align: 'right', cell: (p) => ({ text: signedUsd(p.unrealizedPl), style: signStyle(p.unrealizedPl, true) }) },
    { title: 'RTN%', width: 7, align: 'right', cell: (p) => ({ text: signedPct(p.unrealizedPlPct), style: signStyle(p.unrealizedPlPct) }) },
    ...(compact
      ? []
      : ([
          {
            title: 'HELD',
            width: 5,
            align: 'right',
            cell: (p: TradingPosition) => {
              const since = heldSince(view.snapshot?.orders ?? [], p.symbol)
              return since ? span(Date.now() - since) : '—'
            }
          }
        ] as Column<TradingPosition>[])),
    { title: 'EXIT', flex: 1, cell: (p) => exitText(p) }
  ]
}

function statusStyle(order: TradingOrder): Style {
  switch (order.status) {
    case 'filled':
      return S.green
    case 'partially_filled':
    case 'open':
    case 'pending':
      return S.yellow
    case 'rejected':
      return S.red
    default:
      return S.muted
  }
}

export function orderColumns(compact: boolean): Column<TradingOrder>[] {
  return [
    { title: 'TIME', width: compact ? 8 : 15, cell: (o) => ({ text: compact ? new Date(o.submittedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : time(o.submittedAt), style: S.muted }) },
    { title: 'SIDE', width: 4, cell: (o) => ({ text: o.side.toUpperCase(), style: o.side === 'buy' ? S.greenBold : S.redBold }) },
    { title: 'SYMBOL', width: 7, cell: (o) => ({ text: o.symbol, style: S.bold }) },
    { title: 'QTY', width: 8, align: 'right', cell: (o) => shares(o.filledQty || o.qty) },
    { title: 'PRICE', width: 9, align: 'right', cell: (o) => price(o.filledAvgPrice ?? o.limitPrice) },
    { title: 'STATUS', width: 9, cell: (o) => ({ text: o.status === 'rejected' ? 'refused' : o.status.replace('_', ' '), style: statusStyle(o) }) },
    ...(compact
      ? []
      : ([{ title: 'P&L', width: 10, align: 'right', cell: (o: TradingOrder) => (o.realizedPl === null ? '' : { text: signedUsd(o.realizedPl), style: signStyle(o.realizedPl) }) }] as Column<TradingOrder>[])),
    { title: 'BY', width: 7, cell: (o) => ({ text: o.source === 'user' ? 'you' : o.source === 'agent' ? 'agent' : 'session', style: o.source === 'user' ? S.muted : S.cyan }) },
    { title: 'REASON', flex: 1, cell: (o) => ({ text: o.error ?? o.reason, style: o.error ? S.red : S.muted }) }
  ]
}

export function scheduleColumns(): Column<TradingSchedule>[] {
  return [
    { title: 'ON', width: 2, cell: (s) => ({ text: s.enabled ? '●' : '○', style: s.enabled ? S.green : S.faint }) },
    { title: 'NAME', flex: 1, cell: (s) => ({ text: s.name, style: S.bold }) },
    { title: 'DAYS', width: 11, cell: (s) => daysLabel(s.days) },
    { title: 'WINDOW', width: 11, cell: (s) => `${s.start}–${s.end}` },
    { title: 'EVERY', width: 5, align: 'right', cell: (s) => `${s.everyMinutes}m` },
    { title: 'END', width: 8, cell: (s) => ({ text: s.flattenAtEnd ? 'sell all' : 'keep', style: S.muted }) }
  ]
}

function sessionReturn(s: TradingSession): number | null {
  const end = s.endEquity
  if (end === null || !s.startEquity) return null
  return ((end - s.startEquity) / s.startEquity) * 100
}

function benchmarkReturn(s: TradingSession): number | null {
  const b = s.benchmark
  if (!b || b.end === null || !b.start) return null
  return ((b.end - b.start) / b.start) * 100
}

export function sessionColumns(): Column<TradingSession>[] {
  return [
    { title: 'STARTED', width: 12, cell: (s) => ({ text: time(s.startedAt), style: S.muted }) },
    { title: 'NAME', flex: 1, cell: (s) => s.name },
    { title: 'LENGTH', width: 6, align: 'right', cell: (s) => span((s.endedAt ?? Date.now()) - s.startedAt) },
    {
      title: 'STATUS',
      width: 8,
      cell: (s) => ({ text: s.status, style: s.status === 'running' ? S.greenBold : s.status === 'failed' ? S.red : S.muted })
    },
    { title: 'RETURN', width: 8, align: 'right', cell: (s) => ({ text: signedPct(sessionReturn(s)), style: signStyle(sessionReturn(s)) }) },
    { title: 'SPY', width: 7, align: 'right', cell: (s) => ({ text: signedPct(benchmarkReturn(s)), style: S.muted }) },
    { title: 'ORD', width: 3, align: 'right', cell: (s) => String(s.orders) }
  ]
}

export function moverColumns(): Column<ScreenRow>[] {
  return [
    { title: 'SYMBOL', width: 6, cell: (r) => ({ text: r.symbol, style: S.bold }) },
    { title: 'PRICE', width: 8, align: 'right', cell: (r) => price(r.price) },
    { title: 'CHG%', width: 8, align: 'right', cell: (r) => ({ text: signedPct(r.changePct), style: signStyle(r.changePct) }) },
    { title: 'RVOL', width: 5, align: 'right', cell: (r) => (r.relativeVolume ? `${r.relativeVolume.toFixed(1)}x` : '—') },
    { title: 'CAP', flex: 1, align: 'right', cell: (r) => ({ text: usdShort(r.marketCap), style: S.muted }) }
  ]
}

export type RateRow = (typeof RATES)[number]

export function rateColumns(): Column<RateRow>[] {
  return []
}

/* ------------------------------------------------------------ pieces */

function equityChart(c: Canvas, view: TradingView): void {
  const s = view.snapshot
  const points = s?.equity ?? []
  const base = s?.account?.startingEquity ?? points[0]?.equity ?? null
  const last = s?.account?.equity ?? points[points.length - 1]?.equity ?? null
  const right =
    base !== null && last !== null
      ? [
          { text: `${signedUsd(last - base)} `, style: signStyle(last - base, true) },
          { text: signedPct(((last - base) / base) * 100), style: signStyle(last - base) },
          { text: points.length ? `  since ${time(points[0].at)}` : '', style: S.faint }
        ]
      : []
  const inner = panel(c, 'Equity', { right })
  if (points.length < 2) {
    inner.text(0, 1, 'The curve fills in as the account is tracked: a point a minute while Eaon runs.', S.faint, inner.w)
    if (last !== null) inner.text(0, 3, usd(last), { fg: C.text, bold: true })
    return
  }
  const axisW = 13
  const chart = inner.sub(0, 0, inner.w - axisW, inner.h - 1)
  const values = points.map((p) => p.equity)
  const scale = lineChart(chart, values, { baseline: base, splitColors: true })
  // Small moves need exact dollars on the axis; big ones read better short.
  const span_ = scale.hi - scale.lo
  const fmt = (v: number): string => (span_ < 50 ? usd(v, 2) : span_ < 5000 ? usd(v, 0) : usdShort(v))
  for (const label of axisLabels(scale, chart.h, fmt)) inner.text(inner.w - axisW + 1, label.row, label.text, S.faint, axisW - 1)
  inner.text(0, inner.h - 1, time(points[0].at), S.faint)
  const end = time(points[points.length - 1].at)
  inner.text(chart.w - strWidth(end), inner.h - 1, end, S.faint)
}

function logLines(entries: TradingSession['log'], width: number): Line[] {
  const out: Line[] = []
  for (const entry of entries) {
    const style: Style = entry.kind === 'error' ? S.red : entry.kind === 'order' ? S.cyan : entry.kind === 'note' ? S.muted : S.text
    const stamp = new Date(entry.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    out.push(...wrapSegments([{ text: entry.text.replace(/\s+/g, ' '), style }], width, [{ text: `${stamp} `, style: S.faint }], [{ text: '      ' }]))
  }
  return out
}

function sessionPanel(c: Canvas, view: TradingView, session: TradingSession | null, title = 'Agent'): void {
  const active = view.snapshot?.activeSession
  const inner = panel(c, title, {
    right: session ? [{ text: session.status === 'running' ? '● RUNNING' : session.status.toUpperCase(), style: session.status === 'running' ? S.greenBold : S.muted }] : []
  })
  if (!session) {
    const lines = [
      'The agent isn’t trading right now.',
      '',
      'G  start a session: a strategy in your words, until a time',
      '1  the agent desk: its steps, the account, mission control',
      '0  talk to the trading agent · 6 schedules'
    ]
    lines.forEach((line, i) => inner.text(0, i, line, i === 0 ? S.text : S.muted, inner.w))
    return
  }
  let y = 0
  for (const line of wrapSegments([{ text: session.strategy, style: { fg: C.text, bold: true } }], inner.w).slice(0, 2)) inner.segments(0, y++, line, inner.w)
  const ends = new Date(session.endsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  inner.text(0, y++, `${session.checks} checks · ${session.orders} orders · every ${session.everyMinutes}m · ${session.status === 'running' ? `ends ${ends} (${span(session.endsAt - Date.now())})` : `ran ${span((session.endedAt ?? session.endsAt) - session.startedAt)}`}`, S.muted, inner.w)
  const equityNow = session.status === 'running' ? view.snapshot?.account?.equity : session.endEquity
  if (equityNow != null && session.startEquity) {
    const change = equityNow - session.startEquity
    const spy = session.benchmark
    const spyNow = session.status === 'running' ? view.market.quote('SPY')?.price : spy?.end
    const spyPct = spy && spyNow ? ((spyNow - spy.start) / spy.start) * 100 : null
    inner.segments(0, y++, [
      { text: 'since start ', style: S.muted },
      { text: `${signedUsd(change)} ${signedPct((change / session.startEquity) * 100)}`, style: signStyle(change, true) },
      ...(spyPct !== null ? [{ text: `   SPY ${signedPct(spyPct)}`, style: S.muted }] : [])
    ])
  }
  if (session.summary && session !== active) for (const line of wrapSegments([{ text: session.summary, style: S.text }], inner.w).slice(0, 3)) inner.segments(0, y++, line, inner.w)
  if (session.error) inner.text(0, y++, session.error, S.red, inner.w)
  inner.hline(0, y++, inner.w, S.border)
  const lines = logLines(session.log, inner.w)
  const room = inner.h - y
  const shown = lines.slice(Math.max(0, lines.length - room))
  shown.forEach((line, i) => inner.segments(0, y + i, line, inner.w))
}

function exposurePanel(c: Canvas, view: TradingView): void {
  const s = view.snapshot
  const equity = s?.account?.equity ?? 0
  const inner = panel(c, 'Exposure', { right: [{ text: `${pct(s?.stats.investedPct)} invested`, style: S.muted }] })
  const positions = view.positions()
  const cols = ['TYPE', 'NAME', 'VALUE', 'WEIGHT']
  const xs = [0, 10, 18, 29]
  cols.forEach((title, i) => inner.text(xs[i], 0, title, S.header))
  inner.text(38, 0, 'EXPOSURE', S.header)
  const barW = Math.max(4, inner.w - 38)
  const limit = s?.config.limits.maxPositionPct ?? 20
  let y = 1
  for (const p of positions) {
    if (y >= inner.h - 1) break
    const weight = equity ? (p.marketValue / equity) * 100 : 0
    inner.text(xs[0], y, 'POSITION', S.muted)
    inner.text(xs[1], y, p.symbol, S.bold)
    inner.text(xs[2], y, usdShort(p.marketValue), S.text)
    inner.text(xs[3], y, pct(weight), weight > limit ? S.redBold : S.text)
    inner.text(38, y, bar(weight / 100, barW), { fg: weight > limit ? C.red : '#D8D8D8' })
    y++
  }
  if (s?.account) {
    const cashPct = equity ? (s.account.cash / equity) * 100 : 0
    inner.text(xs[0], y, 'CASH', S.muted)
    inner.text(xs[1], y, s.account.broker === 'simulator' ? 'SIM' : 'USD', S.bold)
    inner.text(xs[2], y, usdShort(s.account.cash), S.text)
    inner.text(xs[3], y, pct(cashPct), S.text)
    inner.text(38, y, bar(Math.max(0, cashPct) / 100, barW), { fg: C.faint })
  }
  if (positions.length === 0) inner.text(0, y + 2, 'No holdings.', S.faint)
}

function pnlPanel(c: Canvas, view: TradingView): void {
  const st = view.snapshot?.stats
  const inner = panel(c, 'P&L split')
  if (!st) return
  const rows: { mark: string; label: string; value: number | null; note: string; style?: Style }[] = [
    { mark: '✓', label: 'REALIZED', value: st.realizedPl, note: `${st.trades} closed · FIFO` },
    { mark: st.unrealizedPl >= 0 ? '▲' : '▼', label: 'UNREALIZED', value: st.unrealizedPl, note: `${view.snapshot?.positions.length ?? 0} open` },
    { mark: '◆', label: 'AVG WIN', value: st.avgWin || null, note: `${st.wins} wins` },
    { mark: '◇', label: 'AVG LOSS', value: st.avgLoss ? -Math.abs(st.avgLoss) : null, note: `${st.losses} losses` },
    { mark: '★', label: 'BEST', value: st.bestTrade, note: '' },
    { mark: '☓', label: 'WORST', value: st.worstTrade, note: '' }
  ]
  rows.forEach((row, i) => {
    if (i >= inner.h) return
    inner.text(0, i, row.mark, signStyle(row.value))
    inner.text(2, i, row.label, S.bold)
    inner.text(14, i, row.value === null ? '—' : signedUsd(row.value), signStyle(row.value, true))
    inner.text(28, i, row.note, S.muted, inner.w - 28)
  })
}

/* -------------------------------------------------------------- pages */

export function drawHome(c: Canvas, view: TradingView): void {
  const positions = view.positions()
  const leftW = c.w >= 110 ? Math.floor(c.w * 0.6) : c.w
  const compact = c.h < 22
  const topH = compact ? Math.floor(c.h * 0.55) : Math.max(8, Math.floor(c.h * 0.4))
  const midH = compact ? 0 : Math.max(8, Math.floor(c.h * 0.33))
  const botH = c.h - topH - midH
  const holdings = panel(c.sub(0, 0, leftW, topH), 'Holdings', { right: [{ text: `${positions.length} open`, style: S.muted }], focused: true })
  view.holdings.columns = holdingColumns(view, holdings.w < 120)
  view.holdings.draw(holdings, positions, { empty: 'No positions yet — B to buy, G to let the agent trade.' })
  if (leftW < c.w) {
    const rightW = c.w - leftW
    const expH = Math.ceil(topH * 0.55)
    exposurePanel(c.sub(leftW, 0, rightW, expH), view)
    pnlPanel(c.sub(leftW, expH, rightW, topH - expH), view)
  }
  if (midH > 0) {
    equityChart(c.sub(0, topH, leftW, midH), view)
    if (leftW < c.w) sessionPanel(c.sub(leftW, topH, c.w - leftW, midH), view, view.snapshot?.activeSession ?? view.snapshot?.sessions[0] ?? null)
  }
  const orders = panel(c.sub(0, topH + midH, c.w, botH), 'Recent orders', {
    right: [{ text: `${view.snapshot?.stats.ordersToday ?? 0} today`, style: S.muted }]
  })
  const table = new Table<TradingOrder>(orderColumns(true))
  table.draw(orders, view.snapshot?.orders ?? [], { focused: false, empty: 'No orders yet.' })
}

function heatmap(c: Canvas, view: TradingView): void {
  const inner = panel(c, 'Position heatmap', { right: [{ text: 'size: weight · colour: return', style: S.faint }] })
  const positions = view.positions()
  if (positions.length === 0) {
    inner.text(0, 0, 'No open positions', S.faint)
    return
  }
  const total = positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0) || 1
  const shade = (r: number): string => {
    const a = Math.min(1, Math.abs(r) / 6)
    const mix = (from: number[], to: number[]): string => '#' + from.map((f, i) => Math.round(f + (to[i] - f) * a).toString(16).padStart(2, '0')).join('')
    return r >= 0 ? mix([30, 40, 34], [24, 140, 70]) : mix([44, 30, 30], [170, 40, 36])
  }
  let x = 0
  positions.forEach((p, i) => {
    const w = i === positions.length - 1 ? inner.w - x : Math.max(6, Math.round((Math.abs(p.marketValue) / total) * inner.w))
    if (x >= inner.w || w <= 0) return
    const bg = shade(p.unrealizedPlPct)
    inner.fill(x, 0, Math.min(w, inner.w - x) - 1, inner.h, { bg })
    const mid = Math.max(0, Math.floor(inner.h / 2) - 1)
    inner.text(x + 1, mid, truncate(p.symbol, w - 2), { fg: '#FFFFFF', bg, bold: true })
    inner.text(x + 1, mid + 1, truncate(signedPct(p.unrealizedPlPct, 1), w - 2), { fg: '#F0F0F0', bg })
    inner.text(x + 1, mid + 2, truncate(usdShort(p.marketValue), w - 2), { fg: '#D0D0D0', bg })
    x += w
  })
}

function riskPanel(c: Canvas, view: TradingView): void {
  const s = view.snapshot
  const inner = panel(c, 'Risk dashboard', { right: s?.config.halted ? [{ text: 'KILL SWITCH ON', style: S.redBold }] : [] })
  if (!s) return
  const l = s.config.limits
  const equity = s.account?.equity ?? 0
  const largest = view.positions()[0]
  const largestPct = largest && equity ? (largest.marketValue / equity) * 100 : 0
  const dayLoss = Math.max(0, -s.stats.todayReturnPct)
  const barW = Math.max(8, Math.min(30, inner.w - 44))
  const rows: { label: string; used: number; max: number; text: string }[] = [
    { label: 'Orders today', used: s.stats.ordersToday, max: l.maxOrdersPerDay, text: `${s.stats.ordersToday} / ${l.maxOrdersPerDay}` },
    { label: 'Invested', used: s.stats.investedPct, max: l.maxInvestedPct, text: `${pct(s.stats.investedPct)} / ${l.maxInvestedPct}%` },
    { label: 'Largest holding', used: largestPct, max: l.maxPositionPct, text: largest ? `${largest.symbol} ${pct(largestPct)} / ${l.maxPositionPct}%` : `— / ${l.maxPositionPct}%` },
    { label: 'Day loss', used: dayLoss, max: l.maxDailyLossPct, text: `${dayLoss.toFixed(2)}% / ${l.maxDailyLossPct}%` }
  ]
  rows.forEach((row, i) => {
    const frac = row.max ? row.used / row.max : 0
    const color = frac >= 0.9 ? C.red : frac >= 0.6 ? C.amber : C.green
    inner.text(0, i, row.label, S.muted)
    inner.text(18, i, bar(Math.min(1, frac), barW).padEnd(barW, '·'), { fg: color })
    inner.text(19 + barW, i, row.text, S.text, inner.w - 19 - barW)
  })
  const y = rows.length + 1
  inner.segments(0, y, [{ text: 'Per order        ', style: S.muted }, { text: usd(l.maxOrderUsd, 0), style: S.text }])
  inner.segments(0, y + 1, [{ text: 'Buying power     ', style: S.muted }, { text: usd(s.account?.buyingPower), style: S.text }])
  inner.segments(0, y + 2, [{ text: 'Allowed symbols  ', style: S.muted }, { text: l.allowedSymbols.length ? l.allowedSymbols.join(' ') : 'any US stock or ETF', style: S.text }], inner.w)
  const unprotected = view.positions().filter((p) => !p.exit).map((p) => p.symbol)
  if (unprotected.length) inner.segments(0, y + 3, [{ text: 'No stop on       ', style: S.muted }, { text: unprotected.join(' '), style: S.yellow }, { text: '  (X sets one)', style: S.faint }], inner.w)
}

export function drawPortfolio(c: Canvas, view: TradingView): void {
  const topH = Math.max(6, Math.floor(c.h * 0.58))
  const positions = view.positions()
  const holdings = panel(c.sub(0, 0, c.w, topH), 'Holdings', {
    right: [
      { text: `${positions.length} positions · `, style: S.muted },
      { text: `${usd(positions.reduce((s, p) => s + p.marketValue, 0))}`, style: S.text },
      { text: '   X exit · C close · B/S trade', style: S.faint }
    ],
    focused: true
  })
  view.holdings.columns = holdingColumns(view)
  view.holdings.draw(holdings, positions, { empty: 'No positions.' })
  const half = c.w >= 110 ? Math.floor(c.w * 0.5) : c.w
  heatmap(c.sub(0, topH, half, c.h - topH), view)
  if (half < c.w) riskPanel(c.sub(half, topH, c.w - half, c.h - topH), view)
}

export function drawOrders(c: Canvas, view: TradingView): void {
  const orders = view.filteredOrders()
  const detailH = 8
  const list = panel(c.sub(0, 0, c.w, c.h - detailH), `Orders · ${view.orderFilter}`, {
    right: [{ text: `${orders.length} shown · F filter · C cancel`, style: S.muted }],
    focused: true
  })
  view.orders.columns = orderColumns(false)
  view.orders.draw(list, orders, { empty: view.orderFilter === 'all' ? 'No orders yet.' : `No ${view.orderFilter} orders.` })
  const order = orders[view.orders.selected]
  const detail = panel(c.sub(0, c.h - detailH, c.w, detailH), 'Order')
  if (!order) return
  detail.segments(0, 0, [
    { text: `${order.side.toUpperCase()} `, style: order.side === 'buy' ? S.greenBold : S.redBold },
    { text: `${shares(order.qty)} ${order.symbol} `, style: S.bold },
    { text: `${order.type}${order.limitPrice ? ` @ ${price(order.limitPrice)}` : ''} · ${order.status} · filled ${shares(order.filledQty)}${order.filledAvgPrice ? ` @ ${price(order.filledAvgPrice)}` : ''}`, style: S.muted },
    ...(order.realizedPl !== null ? [{ text: `   realized ${signedUsd(order.realizedPl)}`, style: signStyle(order.realizedPl, true) }] : [])
  ])
  detail.text(0, 1, `submitted ${time(order.submittedAt)}${order.filledAt ? ` · filled ${time(order.filledAt)}` : ''} · placed by ${order.source === 'user' ? 'you' : order.source}${order.sessionId ? ` (session)` : ''}`, S.muted, detail.w)
  const reason = wrapSegments([{ text: order.reason || '(no reason given)', style: S.text }], detail.w, [{ text: 'why  ', style: S.faint }], [{ text: '     ' }])
  reason.slice(0, 2).forEach((line, i) => detail.segments(0, 2 + i, line, detail.w))
  if (order.error) detail.text(0, 4, `refused: ${order.error}`, S.red, detail.w)
}

export function drawSessions(c: Canvas, view: TradingView): void {
  const s = view.snapshot
  const leftW = c.w >= 110 ? Math.floor(c.w * 0.5) : c.w
  const sessions = s?.sessions ?? []
  const picked = view.sessionsFocus === 'sessions' ? (sessions[view.past.selected] ?? null) : (s?.activeSession ?? null)
  sessionPanel(c.sub(0, 0, leftW, c.h), view, picked ?? s?.activeSession ?? null, picked && picked.status !== 'running' ? 'Session' : 'Active session')
  if (leftW >= c.w) return
  const rightW = c.w - leftW
  const schedH = Math.max(6, Math.floor(c.h * 0.4))
  const sched = panel(c.sub(leftW, 0, rightW, schedH), 'Schedules', {
    right: [{ text: 'N new · E on/off · D delete · ⏎ edit', style: S.faint }],
    focused: view.sessionsFocus === 'schedules'
  })
  view.schedules.draw(sched, s?.schedules ?? [], { focused: view.sessionsFocus === 'schedules', empty: 'No schedules. N makes one: the agent trades the same window on the days you pick.' })
  const past = panel(c.sub(leftW, schedH, rightW, c.h - schedH), 'Sessions', {
    right: [{ text: 'G start · X stop · ←→ switch list', style: S.faint }],
    focused: view.sessionsFocus === 'sessions'
  })
  view.past.draw(past, sessions, { focused: view.sessionsFocus === 'sessions', empty: 'No sessions yet. G starts one.' })
}

export function drawMarket(c: Canvas, view: TradingView): void {
  const idxH = INDEXES.length + 4
  const idx = panel(c.sub(0, 0, c.w, idxH), 'Indexes')
  const head = ['INDEX', 'LAST', 'CHG', 'CHG%', 'DAY RANGE', 'TODAY']
  const xs = [0, 18, 30, 41, 51, 74]
  head.forEach((h, i) => idx.text(xs[i], 0, h, S.header))
  INDEXES.forEach((index, i) => {
    const q = view.market.quote(index.symbol)
    const y = 1 + i
    idx.text(xs[0], y, `${index.symbol.replace('^', '')} `, S.bold)
    idx.text(xs[0] + 6, y, index.label, S.muted, 12)
    if (!q) return void idx.text(xs[1], y, '…', S.faint)
    const st = index.symbol === '^VIX' ? signStyle(-q.change) : signStyle(q.change)
    idx.text(xs[1], y, price(q.price), S.text)
    idx.text(xs[2], y, `${q.change > 0 ? '+' : ''}${q.change.toFixed(2)}`, st)
    idx.text(xs[3], y, `${arrow(q.changePct)} ${signedPct(q.changePct)}`, st)
    idx.text(xs[4], y, q.dayLow != null && q.dayHigh != null ? `${price(q.dayLow)} – ${price(q.dayHigh)}` : '—', S.muted)
    idx.text(xs[5], y, sparkline(view.market.line(index.symbol), Math.max(0, idx.w - xs[5])), { ...st, dim: true })
  })
  const kinds = [
    ['gainers', 'Top gainers'],
    ['losers', 'Top losers'],
    ['active', 'Most active']
  ] as const
  const third = Math.floor(c.w / 3)
  kinds.forEach(([kind, title], i) => {
    const w = i === 2 ? c.w - third * 2 : third
    const box = panel(c.sub(i * third, idxH, w, c.h - idxH), title, { focused: view.moversFocus === i, right: [{ text: '⏎ look · B buy', style: S.faint }] })
    const rows = view.market.movers(kind)
    view.movers[i].draw(box, rows ?? [], { focused: view.moversFocus === i, empty: rows ? 'Nothing listed.' : 'Loading…' })
  })
}

export function drawWatchlist(c: Canvas, view: TradingView): void {
  const symbols = watchlist.get()
  const listW = Math.min(46, Math.max(34, Math.floor(c.w * 0.32)))
  const list = panel(c.sub(0, 0, listW, c.h), `Watchlist [${symbols.length}]`, { focused: true, right: [{ text: 'N add · D del', style: S.faint }] })
  list.text(0, 0, 'CODE', S.header)
  list.text(9, 0, 'NAME', S.header)
  list.text(list.w - 18, 0, 'PRICE', S.header)
  list.text(list.w - 7, 0, 'CHG', S.header)
  view.watch.selected = Math.max(0, Math.min(view.watch.selected, symbols.length - 1))
  const rows = list.h - 1
  if (view.watch.selected < view.watch.scroll) view.watch.scroll = view.watch.selected
  if (view.watch.selected >= view.watch.scroll + rows) view.watch.scroll = view.watch.selected - rows + 1
  const held = new Set(view.positions().map((p) => p.symbol))
  for (let r = 0; r < rows && view.watch.scroll + r < symbols.length; r++) {
    const i = view.watch.scroll + r
    const symbol = symbols[i]
    const q = view.market.quote(symbol)
    const active = i === view.watch.selected
    const bg = active ? '#2F7D32' : undefined
    if (active) list.fill(0, 1 + r, list.w, 1, { bg })
    const fg = (style: Style): Style => (active ? { ...style, fg: '#FFFFFF', bg } : style)
    list.text(0, 1 + r, symbol.length > 8 ? symbol.slice(0, 8) : symbol, fg(held.has(symbol) ? S.amberBold : S.bold))
    list.text(9, 1 + r, truncate(q?.name ?? '', Math.max(0, list.w - 28)), fg(S.muted))
    list.text(list.w - 18, 1 + r, q ? price(q.price).padStart(10) : '…'.padStart(10), fg(S.text))
    list.text(list.w - 7, 1 + r, q ? signedPct(q.changePct).padStart(7) : '', fg(signStyle(q?.changePct)))
  }
  const symbol = symbols[view.watch.selected]
  if (symbol) drawDetail(c.sub(listW, 0, c.w - listW, c.h), view, symbol)
}

export function drawLookup(c: Canvas, view: TradingView): void {
  if (!view.lookupSymbol) {
    const inner = panel(c, 'Lookup')
    inner.text(0, 1, 'Press / and type a ticker: AAPL, NVDA, SPY, ^VIX, GC=F, EURUSD=X, BTC-USD.', S.muted, inner.w)
    inner.text(0, 3, 'From any list, ⏎ opens the selected symbol here.', S.faint, inner.w)
    return
  }
  drawDetail(c, view, view.lookupSymbol)
}

export function drawRates(c: Canvas, view: TradingView): void {
  const inner = panel(c, 'Rates & commodities', { right: [{ text: '⏎ chart', style: S.faint }], focused: true })
  const xs = [0, 9, 28, 40, 54, 66, 76]
  ;['GROUP', 'NAME', 'SYMBOL', 'LAST', 'CHG', 'CHG%', 'TODAY'].forEach((h, i) => inner.text(xs[i], 0, h, S.header))
  let lastGroup = ''
  view.rates.selected = Math.max(0, Math.min(view.rates.selected, RATES.length - 1))
  RATES.forEach((row, i) => {
    const y = 1 + i
    if (y >= inner.h) return
    const active = i === view.rates.selected
    const bg = active ? C.teal : undefined
    if (active) inner.fill(0, y, inner.w, 1, { bg })
    const st = (style: Style): Style => (bg ? { ...style, bg } : style)
    const q = view.market.quote(row.symbol)
    if (row.group !== lastGroup) inner.text(xs[0], y, row.group, st(S.amberBold))
    lastGroup = row.group
    inner.text(xs[1], y, row.label, st(S.text), 18)
    inner.text(xs[2], y, row.symbol, st(S.muted))
    if (!q) return void inner.text(xs[3], y, view.market.errorOf(row.symbol) ? 'unavailable' : '…', st(S.faint))
    const unit = row.unit ?? ''
    inner.text(xs[3], y, `${price(q.price)}${unit}`, st(S.bold))
    inner.text(xs[4], y, `${q.change > 0 ? '+' : ''}${q.change.toFixed(Math.abs(q.price) < 10 ? 3 : 2)}`, st(signStyle(q.change)))
    inner.text(xs[5], y, signedPct(q.changePct), st(signStyle(q.changePct)))
    inner.text(xs[6], y, sparkline(view.market.line(row.symbol), Math.max(0, inner.w - xs[6])), st({ ...signStyle(q.changePct), dim: true }))
  })
  const note = 'Treasury yields are in percent. Futures roll monthly; quotes from Yahoo Finance can lag.'
  if (inner.h > RATES.length + 2) inner.text(0, inner.h - 1, note, S.faint, inner.w)
}

export function drawAgent(c: Canvas, view: TradingView): void {
  const leftW = c.w >= 110 ? Math.floor(c.w * 0.6) : c.w
  const box = panel(c.sub(0, 0, leftW, c.h), 'Trading agent', {
    right: [{ text: view.agent.focused ? 'typing · esc for desk keys' : 'i to type', style: S.faint }],
    focused: view.agent.focused
  })
  view.agent.draw(box)
  if (leftW < c.w) {
    const s = view.snapshot
    sessionPanel(c.sub(leftW, 0, c.w - leftW, c.h), view, s?.activeSession ?? s?.sessions[0] ?? null, s?.activeSession ? 'Live session' : 'Last session')
  }
}
