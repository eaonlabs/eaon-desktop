import type { BarRange, TradingOrder, TradingPosition, TradingSchedule, TradingSession, TradingSnapshot } from '@shared/trading'
import type { ScreenRow } from '@main/features/trading/marketData'
import { isOpen, nextClose, nextOpen } from '@main/features/trading/marketHours'
import { store } from '@main/store'
import type { ChatController } from '../../../core/chat'
import { INDEXES, Market, RATES, watchlist } from '../../../core/market'
import { activity } from '../../../core/tradingActivity'
import { engineRole } from '../../../runtime/engines'
import { events, hasHandler, invoke } from '../../../runtime/ipc'
import type { App, StatusSegment, View } from '../../app'
import type { InputEvent } from '../../input'
import { PromptModal } from '../../modals'
import type { Canvas } from '../../screen'
import type { SlashContext } from '../../slash'
import { strWidth, type Style } from '../../term'
import { C, S, signStyle } from '../../theme'
import { Table } from '../../widgets'
import { ChatView } from '../chat'
import { arrow, pct, price, signedPct, signedUsd, span, usd } from './format'
import { closePosition, confirmKill, openExit, openSchedule, openSetup, openStartSession, openTicket, removeSchedule, stopSession, toggleSchedule } from './forms'
import { CommandDesk } from './command'
import { drawAgent, drawHome, drawLookup, drawMarket, drawOrders, drawPortfolio, drawRates, drawSessions, drawWatchlist, orderColumns, holdingColumns, sessionColumns, scheduleColumns, moverColumns, rateColumns, type RateRow } from './pages'

/**
 * The trading desk: the agentic trading tab, laid out like a market
 * terminal. Five rows across the top never move — the page tabs, a ticker
 * tape of the watchlist, the market (indexes, regime, the clock), the
 * account (NAV, returns, win rate) and risk with the agent's session — and
 * the page under them changes with the number keys.
 *
 * Everything about orders, sessions and limits goes through the trading
 * engine's own IPC channels, so the guardrails, the ledger and the agent's
 * sessions are exactly the desktop's. In a second terminal those channels
 * reach the session that runs the engine.
 */

export type Page = 'agent' | 'home' | 'market' | 'portfolio' | 'orders' | 'sessions' | 'watchlist' | 'lookup' | 'rates' | 'chat'

export const PAGES: { id: Page; key: string; label: string }[] = [
  { id: 'agent', key: '1', label: 'AGENT' },
  { id: 'home', key: '2', label: 'HOME' },
  { id: 'market', key: '3', label: 'MARKET' },
  { id: 'portfolio', key: '4', label: 'PORTFOLIO' },
  { id: 'orders', key: '5', label: 'ORDERS' },
  { id: 'sessions', key: '6', label: 'SESSIONS' },
  { id: 'watchlist', key: '7', label: 'WATCHLIST' },
  { id: 'lookup', key: '8', label: 'LOOKUP' },
  { id: 'rates', key: '9', label: 'RATES & CMDTY' },
  { id: 'chat', key: '0', label: 'CHAT' }
]

const AGENT_CHAT_FILE = 'cli-trading-chat.json'
const HEADER_ROWS = 5

export class TradingView implements View {
  page: Page = 'agent'
  snapshot: TradingSnapshot | null = null
  loadError: string | null = null
  readonly market = new Market()

  readonly holdings = new Table<TradingPosition>(holdingColumns(this))
  readonly orders = new Table<TradingOrder>(orderColumns(false))
  readonly watch = new Table<string>([])
  readonly schedules = new Table<TradingSchedule>(scheduleColumns())
  readonly past = new Table<TradingSession>(sessionColumns())
  readonly movers = [0, 1, 2].map(() => new Table<ScreenRow>(moverColumns()))
  readonly rates = new Table<RateRow>(rateColumns())
  moversFocus = 0
  sessionsFocus: 'schedules' | 'sessions' = 'sessions'
  orderFilter: 'all' | 'open' | 'filled' | 'refused' = 'all'
  lookupSymbol: string | null = null
  range: BarRange = '1d'
  chartMode: 'line' | 'candles' = 'line'
  /** The trading agent to talk to (the chat page). */
  readonly agent: ChatView
  /** The agent desk: activity, account and mission control (the first page). */
  readonly desk: CommandDesk
  private agentChatId: string | null = store.getJson<{ id?: string } | null>(AGENT_CHAT_FILE, null)?.id ?? null
  private visible = false

  constructor(
    readonly app: App,
    readonly chat: ChatController,
    slash: SlashContext
  ) {
    this.agent = new ChatView(app, chat, slash, {
      id: () => (this.agentChatId && chat.get(this.agentChatId) ? this.agentChatId : null),
      set: (id) => {
        this.agentChatId = id
        store.setJson(AGENT_CHAT_FILE, { id })
      },
      title: 'Trading agent',
      empty: [
        ['ask', '“How is the portfolio doing against SPY today?”'],
        ['order', '“Buy $500 of NVDA with a 5% trailing stop”'],
        ['session', '“Trade momentum in mega caps until 3:30pm, check every 5 minutes”'],
        ['research', '“Scan today’s gainers and tell me which have real news behind them”'],
        ['limits', 'Every order passes your limits first (M to change them)']
      ]
    })
    this.desk = new CommandDesk(this)
    activity.on('change', () => {
      if (this.visible && this.page === 'agent') app.invalidate()
    })
    this.watch.columns = []
    events.on('trading:changed', (snapshot: TradingSnapshot) => {
      this.snapshot = snapshot
      this.loadError = null
      if (this.visible) app.invalidate()
    })
    events.on('engines:role', () => void this.load())
    this.market.on('change', () => {
      if (this.visible) app.invalidate()
    })
  }

  /* --------------------------------------------------------- lifecycle */

  async load(): Promise<void> {
    if (!hasHandler('trading:snapshot')) {
      this.loadError = engineRole() ? 'The trading engine isn’t reachable from this session yet.' : 'Starting the trading engine…'
      return
    }
    try {
      this.snapshot = await invoke<TradingSnapshot>('trading:snapshot')
      this.loadError = null
      if (this.visible) {
        void invoke('trading:desk-open', true).catch(() => {})
        // The engine's own first refresh waits a few seconds after startup; the desk shouldn't.
        if (!this.snapshot.account) void invoke<TradingSnapshot>('trading:refresh').then((s) => ((this.snapshot = s), this.app.invalidate()), () => {})
      }
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error)
    }
    this.app.invalidate()
  }

  enter(): void {
    this.visible = true
    this.market.start()
    void this.load()
    if (hasHandler('trading:desk-open')) void invoke('trading:desk-open', true).catch(() => {})
  }

  leave(): void {
    this.visible = false
    this.market.stop()
    if (hasHandler('trading:desk-open')) void invoke('trading:desk-open', false).catch(() => {})
  }

  typing(): boolean {
    if (this.page === 'agent') return this.desk.talking
    return this.page === 'chat' && this.agent.typing()
  }

  /** Sends `text` to the trading agent's chat (page 0) and shows it there. */
  askAgent(text: string): void {
    const id = this.agentChatId && this.chat.get(this.agentChatId) ? this.agentChatId : null
    void this.chat.send(
      text,
      id
        ? { chatId: id }
        : {
            detached: true,
            title: 'Trading agent',
            onChat: (newId) => {
              this.agentChatId = newId
              store.setJson(AGENT_CHAT_FILE, { id: newId })
            }
          }
    )
    this.setPage('chat')
  }

  animating(): boolean {
    if (this.page === 'chat') return this.agent.animating()
    if (this.page === 'agent') return this.desk.animating()
    return false
  }

  /* ----------------------------------------------------------- helpers */

  get broker(): string {
    return this.snapshot?.config.broker ?? 'simulator'
  }

  positions(): TradingPosition[] {
    return [...(this.snapshot?.positions ?? [])].sort((a, b) => b.marketValue - a.marketValue)
  }

  filteredOrders(): TradingOrder[] {
    const all = this.snapshot?.orders ?? []
    switch (this.orderFilter) {
      case 'open':
        return all.filter((o) => o.status === 'open' || o.status === 'pending' || o.status === 'partially_filled')
      case 'filled':
        return all.filter((o) => o.status === 'filled' || o.status === 'partially_filled')
      case 'refused':
        return all.filter((o) => o.status === 'rejected' || o.status === 'canceled' || o.status === 'expired')
      default:
        return all
    }
  }

  /** The symbol the user is looking at on this page, for B/S/X and Enter. */
  selectedSymbol(): string | null {
    switch (this.page) {
      case 'agent':
        return this.desk.selectedSymbol()
      case 'home':
      case 'portfolio':
        return this.positions()[this.holdings.selected]?.symbol ?? null
      case 'orders':
        return this.filteredOrders()[this.orders.selected]?.symbol ?? null
      case 'watchlist':
        return watchlist.get()[this.watch.selected] ?? null
      case 'lookup':
        return this.lookupSymbol
      case 'market': {
        const kinds = ['gainers', 'losers', 'active'] as const
        return this.market.movers(kinds[this.moversFocus])?.[this.movers[this.moversFocus].selected]?.symbol ?? null
      }
      default:
        return null
    }
  }

  setPage(page: Page | string): void {
    const known = PAGES.find((p) => p.id === page)
    if (!known) return
    this.page = known.id
    this.agent.focused = known.id === 'chat'
    this.app.invalidate()
  }

  lookup(symbol: string): void {
    this.lookupSymbol = symbol.toUpperCase()
    this.setPage('lookup')
  }

  async refresh(): Promise<void> {
    this.market.refreshAll()
    if (!hasHandler('trading:refresh')) return
    try {
      this.snapshot = await invoke<TradingSnapshot>('trading:refresh')
      this.app.toast('Refreshed', 'success', 1500)
    } catch (error) {
      this.app.toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  /* ------------------------------------------------------------ header */

  private drawTabs(c: Canvas): void {
    c.fill(0, 0, c.w, 1, { bg: '#0B0B0D' })
    const broker = this.broker
    const badge =
      broker === 'alpaca-live'
        ? { text: ' ● LIVE ALPACA ', style: { fg: '#FFFFFF', bg: '#B3261E', bold: true } }
        : broker === 'alpaca-paper'
          ? { text: ' PAPER ALPACA ', style: { fg: C.ink, bg: C.amberDeep, bold: true } }
          : { text: ' SIMULATOR ', style: { fg: C.ink, bg: C.green, bold: true } }
    let x = c.text(0, 0, badge.text, badge.style) + 1
    for (const page of PAGES) {
      const active = page.id === this.page
      const label = ` ${page.key}:${page.label} `
      if (x + strWidth(label) >= c.w) break
      x += c.text(x, 0, label, active ? S.tabActive : { fg: C.muted, bg: '#0B0B0D' })
    }
    const actions: [string, string][] =
      this.page === 'agent'
        ? [
            ['/', 'GO'],
            ['B', 'BUY'],
            ['S', 'SELL'],
            ['E', 'EXIT'],
            ['G', 'START'],
            ['N', 'CHECK'],
            ['X', 'STOP'],
            ['K', 'KILL'],
            ['M', 'SETUP']
          ]
        : [
            ['/', 'GO'],
            ['B', 'BUY'],
            ['S', 'SELL'],
            ['X', 'EXIT'],
            ['G', 'AGENT'],
            ['K', 'KILL'],
            ['M', 'SETUP'],
            ['R', 'REFRESH']
          ]
    const segs: { text: string; style: Style }[] = [{ text: ' ‖ ', style: { fg: C.faint, bg: '#0B0B0D' } }]
    for (const [k, label] of actions) {
      segs.push({ text: `${k}:`, style: { fg: C.text, bg: '#0B0B0D', bold: true } })
      segs.push({ text: `${label} `, style: { fg: C.muted, bg: '#0B0B0D' } })
    }
    const w = segs.reduce((s, seg) => s + strWidth(seg.text), 0)
    if (x + w <= c.w) c.segments(c.w - w, 0, segs)
  }

  private drawTape(c: Canvas): void {
    const segs: { text: string; style: Style }[] = []
    const symbols = watchlist.get()
    for (const symbol of symbols) {
      const q = this.market.quote(symbol)
      if (segs.length) segs.push({ text: '  ◆  ', style: S.faint })
      segs.push({ text: `${symbol} `, style: { fg: C.text, bold: true } })
      if (!q) {
        segs.push({ text: '…', style: S.faint })
        continue
      }
      segs.push({ text: `${price(q.price)} `, style: S.muted })
      segs.push({ text: `${arrow(q.changePct)}${signedPct(q.changePct)}`, style: signStyle(q.changePct) })
    }
    // A headline about the biggest holding, as a terminal's tape carries the news.
    const lead = this.positions()[0]?.symbol ?? symbols[0]
    const headline = lead ? this.market.news(lead)?.[0] : undefined
    if (headline) segs.push({ text: '   ', style: S.faint }, { text: `[${lead}] `, style: { fg: C.amber } }, { text: headline.title, style: S.text })
    c.segments(0, 0, segs, c.w)
  }

  /** Risk-on, neutral or risk-off from the S&P's day and the VIX. */
  regime(): { label: string; style: Style } {
    const spy = this.market.quote('SPY')
    const vix = this.market.quote('^VIX')
    if (!spy) return { label: '—', style: S.faint }
    const v = vix?.price ?? 18
    if (spy.changePct <= -0.75 || v >= 25) return { label: 'RISK-OFF', style: S.redBold }
    if (spy.changePct >= 0.3 && v < 18) return { label: 'RISK-ON', style: S.greenBold }
    return { label: 'NEUTRAL', style: { fg: C.yellow, bold: true } }
  }

  marketState(now = Date.now()): { open: boolean; text: string } {
    const open = isOpen(now)
    return open ? { open, text: `OPEN · closes in ${span(nextClose(now) - now)}` } : { open, text: `CLOSED · opens in ${span(nextOpen(now) - now)}` }
  }

  private drawMarketLine(c: Canvas): void {
    const segs: { text: string; style: Style }[] = []
    for (const index of INDEXES) {
      const q = this.market.quote(index.symbol)
      const name = index.symbol.replace('^', '')
      segs.push({ text: `${name} `, style: S.amberBold })
      segs.push({ text: q ? `${price(q.price)} ` : '… ', style: S.text })
      if (q) segs.push({ text: signedPct(q.changePct), style: index.symbol === '^VIX' ? signStyle(-q.changePct) : signStyle(q.changePct) })
      segs.push({ text: '  ', style: S.faint })
    }
    const regime = this.regime()
    const mkt = this.marketState()
    const ny = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })
    segs.push(
      { text: '│ ', style: S.faint },
      { text: 'REGIME ', style: S.muted },
      { text: regime.label, style: regime.style },
      { text: '  │ ', style: S.faint },
      { text: 'MKT ', style: S.muted },
      { text: mkt.text, style: mkt.open ? S.green : S.muted },
      { text: '  │ ', style: S.faint },
      { text: 'NY ', style: S.muted },
      { text: ny, style: S.text }
    )
    c.segments(0, 0, segs, c.w)
  }

  private drawAccountLine(c: Canvas): void {
    const s = this.snapshot
    const a = s?.account
    const st = s?.stats
    const label = (t: string): { text: string; style: Style } => ({ text: `${t} `, style: S.muted })
    const segs: { text: string; style: Style }[] = [
      { text: this.broker === 'alpaca-live' ? 'LIVE ' : this.broker === 'alpaca-paper' ? 'PAPER ' : 'SIM ', style: { fg: this.broker === 'alpaca-live' ? C.red : C.amber, bold: true } },
      label('NAV'),
      { text: `${usd(a?.equity)}  `, style: S.bold },
      label('CASH'),
      { text: `${usd(a?.cash)}  `, style: S.text },
      label('INVESTED'),
      { text: `${pct(st?.investedPct)}  `, style: S.text },
      label('DAY'),
      { text: `${signedUsd(st?.todayReturn)} ${signedPct(st?.todayReturnPct)}  `, style: signStyle(st?.todayReturn, true) },
      label('TOTAL'),
      { text: `${signedUsd(st?.totalReturn)} ${signedPct(st?.totalReturnPct)}  `, style: signStyle(st?.totalReturn, true) },
      label('W/L'),
      { text: `${st?.wins ?? 0}/${st?.losses ?? 0}  `, style: S.text },
      label('WIN'),
      { text: `${st && st.trades ? pct(st.winRate * 100, 0) : '—'}  `, style: S.text },
      label('PF'),
      { text: `${st?.profitFactor != null ? st.profitFactor.toFixed(2) : '—'}  `, style: S.text },
      label('MAXDD'),
      { text: `${pct(st?.maxDrawdownPct)}  `, style: (st?.maxDrawdownPct ?? 0) > 5 ? S.red : S.text },
      label('SHARPE'),
      { text: st?.sharpe != null ? st.sharpe.toFixed(2) : '—', style: S.text }
    ]
    c.segments(0, 0, segs, c.w)
  }

  private drawRiskLine(c: Canvas): void {
    const s = this.snapshot
    if (!s) {
      c.text(0, 0, this.loadError ?? 'Loading the desk…', this.loadError ? S.yellow : S.faint, c.w)
      return
    }
    const limits = s.config.limits
    const st = s.stats
    const dayLoss = Math.max(0, -st.todayReturnPct)
    const segs: { text: string; style: Style }[] = [
      { text: 'RISK ', style: S.amberBold },
      { text: 'orders ', style: S.muted },
      { text: `${st.ordersToday}/${limits.maxOrdersPerDay}  `, style: st.ordersToday >= limits.maxOrdersPerDay ? S.red : S.text },
      { text: 'day loss ', style: S.muted },
      { text: `${dayLoss.toFixed(1)}%/${limits.maxDailyLossPct}%  `, style: dayLoss >= limits.maxDailyLossPct ? S.red : S.text },
      { text: 'per order ', style: S.muted },
      { text: `${usd(limits.maxOrderUsd, 0)}  `, style: S.text },
      { text: 'per stock ', style: S.muted },
      { text: `${limits.maxPositionPct}%  `, style: S.text },
      { text: '│ ', style: S.faint }
    ]
    const session = s.activeSession
    if (session) {
      const nextIn = session.endsAt - Date.now()
      segs.push(
        { text: 'AGENT ', style: S.amberBold },
        { text: '● RUNNING ', style: S.greenBold },
        { text: `${session.name.slice(0, 40)} `, style: S.text },
        { text: `· ${session.checks} checks · ${session.orders} orders · ends ${new Date(session.endsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (${span(nextIn)})  `, style: S.muted }
      )
    } else segs.push({ text: 'AGENT ', style: S.amberBold }, { text: 'idle · G to start  ', style: S.muted })
    segs.push(s.config.halted ? { text: ' KILL SWITCH ON ', style: { fg: '#FFFFFF', bg: '#B3261E', bold: true } } : { text: '│ KILL off', style: S.faint })
    c.segments(0, 0, segs, c.w)
  }

  /* -------------------------------------------------------------- draw */

  draw(c: Canvas): void {
    this.drawTabs(c.sub(0, 0, c.w, 1))
    this.drawTape(c.sub(1, 1, c.w - 2, 1))
    this.drawMarketLine(c.sub(1, 2, c.w - 2, 1))
    // The agent desk shows the account and the risk in its own panels, so it keeps their two rows.
    if (this.page === 'agent') return this.desk.draw(c.sub(0, 4, c.w, c.h - 4))
    this.drawAccountLine(c.sub(1, 3, c.w - 2, 1))
    this.drawRiskLine(c.sub(1, 4, c.w - 2, 1))
    const body = c.sub(0, HEADER_ROWS + 1, c.w, c.h - HEADER_ROWS - 1)
    switch (this.page) {
      case 'home':
        return drawHome(body, this)
      case 'market':
        return drawMarket(body, this)
      case 'portfolio':
        return drawPortfolio(body, this)
      case 'orders':
        return drawOrders(body, this)
      case 'sessions':
        return drawSessions(body, this)
      case 'watchlist':
        return drawWatchlist(body, this)
      case 'lookup':
        return drawLookup(body, this)
      case 'rates':
        return drawRates(body, this)
      case 'chat':
        return drawAgent(body, this)
    }
  }

  status(): StatusSegment[] {
    const s = this.snapshot
    const mkt = this.marketState()
    const role = engineRole()
    const segs: StatusSegment[] = [
      { text: `ENGINE:${role === 'owner' ? 'ON' : role === 'attached' ? 'SHARED' : 'OFF'} `, style: { fg: role ? C.green : C.muted } },
      { text: `MKT:${mkt.open ? 'OPEN' : 'CLOSED'} `, style: { fg: mkt.open ? C.green : C.muted } },
      { text: `${s?.config.broker === 'alpaca-live' ? 'LIVE' : s?.config.broker === 'alpaca-paper' ? 'PAPER' : 'SIM'}${s?.config.simulatorAnytime && s.config.broker === 'simulator' ? ' ANYTIME' : ''} `, style: { fg: s?.config.broker === 'alpaca-live' ? C.red : C.amber, bold: true } }
    ]
    if (s) {
      segs.push(
        { text: `POS ${s.positions.length} `, style: S.text },
        { text: `ORD ${s.stats.ordersToday}/${s.config.limits.maxOrdersPerDay} `, style: S.text },
        { text: `DD ${s.stats.maxDrawdownPct.toFixed(1)}% `, style: S.text },
        { text: `NAV ${usd(s.account?.equity, 0)}`, style: S.bold }
      )
      if (s.error) segs.push({ text: `  ⚠ ${s.error}`, style: S.yellow })
    }
    return segs
  }

  hints(): [string, string][] {
    if (this.page === 'agent') return this.desk.hints()
    if (this.page === 'chat') return this.agent.focused ? [['esc', 'desk keys'], ['⏎', 'send']] : [['i', 'type'], ['1–9', 'pages']]
    if (this.page === 'watchlist') return [['N', 'add'], ['D', 'remove'], ['[ ]', 'range'], ['V', 'candles']]
    if (this.page === 'orders') return [['C', 'cancel'], ['F', 'filter']]
    if (this.page === 'sessions') return [['←→', 'list'], ['N', 'schedule'], ['E', 'on/off']]
    return [['↑↓', 'select'], ['⏎', 'open']]
  }

  /* -------------------------------------------------------------- keys */

  onEvent(event: InputEvent): boolean {
    if (this.page === 'agent' && this.desk.onEvent(event)) return true
    if (this.page === 'chat') {
      if (this.agent.focused) {
        const used = this.agent.onEvent(event)
        if (used) return true
        if (event.type === 'key' && event.name === 'escape') {
          this.agent.focused = false
          return true
        }
        return false
      }
      if (event.type === 'key' && (event.name === 'i' || event.name === 'enter')) {
        this.agent.focused = true
        return true
      }
      // Approvals still need answering while the box is unfocused.
      if (this.chat.approvals.length && this.agent.onEvent(event)) return true
    }
    if (event.type === 'mouse') {
      if (event.action === 'wheelup') return this.move(-3), true
      if (event.action === 'wheeldown') return this.move(3), true
      return false
    }
    if (event.type !== 'key') return false
    const ch = event.ch ?? ''
    const lower = ch.toLowerCase()
    const byKey = PAGES.find((p) => p.key === ch)
    if (byKey && !event.ctrl && !event.meta) {
      this.setPage(byKey.id)
      return true
    }
    switch (event.name) {
      case 'up':
        return this.move(-1), true
      case 'down':
        return this.move(1), true
      case 'pageup':
        return this.move(-10), true
      case 'pagedown':
        return this.move(10), true
      case 'left':
        if (this.page === 'market') return (this.moversFocus = Math.max(0, this.moversFocus - 1)), true
        if (this.page === 'sessions') return (this.sessionsFocus = 'sessions'), true
        return this.shiftRange(-1), true
      case 'right':
        if (this.page === 'market') return (this.moversFocus = Math.min(2, this.moversFocus + 1)), true
        if (this.page === 'sessions') return (this.sessionsFocus = 'schedules'), true
        return this.shiftRange(1), true
      case 'enter':
        return this.open(), true
    }
    if (event.ctrl || event.meta) return false
    switch (lower) {
      case '/':
        this.app.push(
          new PromptModal({
            title: 'Go to a symbol',
            placeholder: 'AAPL, NVDA, SPY, ^VIX, GC=F, BTC-USD…',
            onSubmit: (value) => {
              const symbol = value.trim().toUpperCase().replace(/^\$/, '')
              if (!/^[\^A-Z0-9][A-Z0-9.=\-^]{0,14}$/.test(symbol)) return 'That doesn’t look like a ticker.'
              this.lookup(symbol)
            }
          })
        )
        return true
      case 'b':
        openTicket(this, 'buy', this.selectedSymbol())
        return true
      case 's':
        if (this.page === 'sessions') return openSchedule(this), true
        openTicket(this, 'sell', this.selectedSymbol())
        return true
      case 'x':
        if (this.page === 'sessions') return stopSession(this), true
        {
          const position = this.positions().find((p) => p.symbol === this.selectedSymbol())
          if (position) openExit(this, position)
          else this.app.toast('Select a holding first (on 1, 2 or 4)')
        }
        return true
      case 'c':
        if (this.page === 'orders') {
          const order = this.filteredOrders()[this.orders.selected]
          if (order) void this.cancelOrder(order)
        } else if (this.page === 'portfolio' || this.page === 'home') {
          const symbol = this.selectedSymbol()
          if (symbol) closePosition(this, symbol)
        } else if (this.page === 'watchlist' || this.page === 'lookup') this.chartMode = this.chartMode === 'line' ? 'candles' : 'line'
        return true
      case 'v':
        this.chartMode = this.chartMode === 'line' ? 'candles' : 'line'
        return true
      case 'g':
        openStartSession(this)
        return true
      case 'k':
        confirmKill(this)
        return true
      case 'm':
        openSetup(this)
        return true
      case 'r':
        void this.refresh()
        return true
      case 'a':
        this.setPage('chat')
        return true
      case 'f':
        if (this.page === 'orders') {
          const order = ['all', 'open', 'filled', 'refused'] as const
          this.orderFilter = order[(order.indexOf(this.orderFilter) + 1) % order.length]
          this.orders.selected = 0
          this.app.toast(`Orders: ${this.orderFilter}`, 'info', 1200)
        }
        return true
      case 'n':
        if (this.page === 'watchlist') {
          this.app.push(
            new PromptModal({
              title: 'Add to the watchlist',
              placeholder: 'Ticker, e.g. PLTR',
              onSubmit: (value) => {
                const symbol = value.trim().toUpperCase().replace(/^\$/, '')
                if (!/^[\^A-Z0-9][A-Z0-9.=\-^]{0,14}$/.test(symbol)) return 'That doesn’t look like a ticker.'
                watchlist.add(symbol)
                this.watch.selected = watchlist.get().indexOf(symbol)
              }
            })
          )
        } else if (this.page === 'sessions') openSchedule(this)
        return true
      case 'd':
        if (this.page === 'watchlist') {
          const symbol = watchlist.get()[this.watch.selected]
          if (symbol) {
            watchlist.remove(symbol)
            this.app.toast(`Removed ${symbol}`, 'info', 1500)
          }
        } else if (this.page === 'sessions' && this.sessionsFocus === 'schedules') removeSchedule(this)
        return true
      case 'e':
        if (this.page === 'sessions') toggleSchedule(this)
        return true
      case '[':
        return this.shiftRange(-1), true
      case ']':
        return this.shiftRange(1), true
      case '+':
        if (this.page === 'watchlist') {
          const symbol = this.selectedSymbol()
          if (symbol) watchlist.move(symbol, -1)
          this.watch.selected = Math.max(0, this.watch.selected - 1)
        }
        return true
      case '-':
        if (this.page === 'watchlist') {
          const symbol = this.selectedSymbol()
          if (symbol) watchlist.move(symbol, 1)
          this.watch.selected = Math.min(watchlist.get().length - 1, this.watch.selected + 1)
        }
        return true
    }
    return false
  }

  private shiftRange(by: number): void {
    const ranges: BarRange[] = ['1d', '5d', '1mo', '6mo', '1y']
    this.range = ranges[Math.max(0, Math.min(ranges.length - 1, ranges.indexOf(this.range) + by))]
  }

  private move(by: number): void {
    switch (this.page) {
      case 'home':
      case 'portfolio':
        this.holdings.move(by, this.positions().length)
        break
      case 'orders':
        this.orders.move(by, this.filteredOrders().length)
        break
      case 'watchlist':
        this.watch.move(by, watchlist.get().length)
        break
      case 'sessions':
        if (this.sessionsFocus === 'schedules') this.schedules.move(by, this.snapshot?.schedules.length ?? 0)
        else this.past.move(by, this.snapshot?.sessions.length ?? 0)
        break
      case 'market': {
        const kinds = ['gainers', 'losers', 'active'] as const
        this.movers[this.moversFocus].move(by, this.market.movers(kinds[this.moversFocus])?.length ?? 0)
        break
      }
      case 'rates':
        this.rates.move(by, RATES.length)
        break
    }
  }

  private open(): void {
    if (this.page === 'sessions') {
      if (this.sessionsFocus === 'schedules') return openSchedule(this, this.snapshot?.schedules[this.schedules.selected])
      return
    }
    if (this.page === 'rates') {
      const row = RATES[this.rates.selected]
      if (row) this.lookup(row.symbol)
      return
    }
    const symbol = this.selectedSymbol()
    if (symbol && this.page !== 'lookup') this.lookup(symbol)
  }

  private async cancelOrder(order: TradingOrder): Promise<void> {
    if (!['open', 'pending', 'partially_filled'].includes(order.status)) return this.app.toast('Only open orders can be cancelled')
    try {
      this.snapshot = await invoke<TradingSnapshot>('trading:cancel-order', order.id)
      this.app.toast(`Cancelled ${order.side} ${order.symbol}`, 'success')
    } catch (error) {
      this.app.toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }
}
