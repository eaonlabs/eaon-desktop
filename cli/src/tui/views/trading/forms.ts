import { BROKERS, LIVE_CONFIRMATION, type BrokerKind, type OrderRequest, type TradingConfig, type TradingOrder, type TradingPosition, type TradingSchedule, type TradingScheduleDraft, type TradingSnapshot } from '@shared/trading'
import { isOpen, nextClose } from '@main/features/trading/marketHours'
import { chatModel, modelLabel } from '../../../core/models'
import { invoke } from '../../../runtime/ipc'
import { EditForm, num } from '../../form'
import { ConfirmModal, FormModal, PromptModal, type FormRow } from '../../modals'
import { openModelPicker } from '../../panels'
import type { Style } from '../../term'
import { C, S } from '../../theme'
import { daysLabel } from './pages'
import { pct, price, shares, signedPct, usd } from './format'
import { afterDisclaimer } from './disclaimer'
import type { TradingView } from './index'

/**
 * The desk's dialogs. Each calls one of the trading engine's channels, so
 * every order still passes the user's limits in the engine, whatever the
 * dialog already checked for the preview.
 */

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Asks a yes/no question on top of whatever is open, and resolves with the answer. */
export function ask(view: TradingView, title: string, body: string, danger = false, yes?: string): Promise<boolean> {
  return new Promise((resolve) => view.app.push(new ConfirmModal({ title, body, danger, yes, onAnswer: resolve })))
}

export type ConfigPatch = Partial<Omit<TradingConfig, 'limits'>> & { limits?: Partial<TradingConfig['limits']> }

export async function setConfig(view: TradingView, patch: ConfigPatch): Promise<void> {
  view.snapshot = await invoke<TradingSnapshot>('trading:set-config', patch)
}

/* ------------------------------------------------------------- ticket */

export function openTicket(view: TradingView, side: 'buy' | 'sell', symbol: string | null): void {
  if (view.snapshot?.needsDisclaimer) return void afterDisclaimer(view, () => openTicket(view, side, symbol))
  if (!view.snapshot) return view.app.toast(view.loadError ?? 'The desk is still loading', 'error')
  const held = (s: string): TradingPosition | undefined => view.positions().find((p) => p.symbol === s.toUpperCase())
  const initialSymbol = symbol && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol) ? symbol : ''
  const form = new EditForm({
    title: side === 'buy' ? 'Buy' : 'Sell',
    titleStyle: { fg: side === 'buy' ? C.green : C.red },
    width: 86,
    submitLabel: 'place order',
    initial: {
      symbol: initialSymbol,
      side,
      size: 'shares',
      amount: side === 'sell' && initialSymbol && held(initialSymbol) ? shares(held(initialSymbol)!.qty) : '',
      type: 'market'
    },
    fields: [
      { key: 'symbol', label: 'Symbol', kind: 'text', placeholder: 'AAPL' },
      { key: 'side', label: 'Side', kind: 'choice', options: [{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }] },
      { key: 'size', label: 'Size in', kind: 'choice', options: [{ value: 'shares', label: 'Shares' }, { value: 'dollars', label: 'Dollars' }] },
      { key: 'amount', label: 'Amount', kind: 'number', placeholder: '10', hint: 'fractions are fine' },
      { key: 'type', label: 'Order type', kind: 'choice', options: [{ value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' }], visible: (v) => v.size === 'shares' },
      { key: 'limit', label: 'Limit price', kind: 'number', visible: (v) => v.type === 'limit' && v.size === 'shares' },
      { key: 'stop', label: 'Stop loss', kind: 'number', hint: 'sell all if it falls to this', visible: (v) => v.side === 'buy' },
      { key: 'target', label: 'Take profit', kind: 'number', hint: 'sell all if it rises to this', visible: (v) => v.side === 'buy' },
      { key: 'trail', label: 'Trailing stop %', kind: 'number', hint: 'e.g. 5', visible: (v) => v.side === 'buy' },
      { key: 'reason', label: 'Reason', kind: 'text', placeholder: 'Why — shown in the ledger next to the order' }
    ],
    preview: (v) => {
      const sym = (v.symbol ?? '').trim().toUpperCase()
      const lines: { text: string; style?: Style }[][] = []
      if (!sym) return [[{ text: 'Type a ticker to see the price and what the order adds up to.', style: S.faint }]]
      const quote = view.market.quote(sym)
      const s = view.snapshot!
      const limits = s.config.limits
      if (!quote) return [[{ text: `Loading ${sym}…`, style: S.faint }]]
      const amount = num(v.amount)
      const px = v.type === 'limit' && Number.isFinite(num(v.limit)) ? num(v.limit) : quote.price
      const cost = v.size === 'dollars' ? amount : amount * px
      const qty = v.size === 'dollars' ? amount / px : amount
      lines.push([
        { text: `${sym} `, style: S.bold },
        { text: `${price(quote.price)} `, style: S.text },
        { text: signedPct(quote.changePct), style: quote.changePct >= 0 ? S.green : S.red },
        { text: `   prev close ${price(quote.prevClose)}`, style: S.faint }
      ])
      if (Number.isFinite(cost) && cost > 0) {
        const equity = s.account?.equity ?? 0
        const position = held(sym)
        const after = (position?.marketValue ?? 0) + (v.side === 'buy' ? cost : -cost)
        const weight = equity ? (after / equity) * 100 : 0
        lines.push([
          { text: `≈ ${usd(cost)} `, style: S.bold },
          { text: `for ${shares(Math.round(qty * 10000) / 10000)} shares`, style: S.muted },
          { text: cost > limits.maxOrderUsd ? `   over the ${usd(limits.maxOrderUsd, 0)} per-order limit` : `   within ${usd(limits.maxOrderUsd, 0)} per order`, style: cost > limits.maxOrderUsd ? S.red : S.faint }
        ])
        if (v.side === 'buy')
          lines.push([
            { text: `${sym} would be ${pct(weight)} of the account`, style: weight > limits.maxPositionPct ? S.red : S.muted },
            { text: `  (limit ${limits.maxPositionPct}%)`, style: S.faint }
          ])
        if (v.side === 'sell' && position && qty > position.qty + 1e-9) lines.push([{ text: `You hold ${shares(position.qty)}; selling more would be a short, which Eaon doesn’t do.`, style: S.red }])
        if (v.side === 'sell' && !position) lines.push([{ text: `You don’t hold ${sym}.`, style: S.red }])
      }
      const stop = num(v.stop)
      if (v.side === 'buy' && Number.isFinite(stop) && Number.isFinite(qty) && qty > 0) {
        const risk = (px - stop) * qty
        lines.push([{ text: `Risk to the stop ≈ ${usd(risk)} (${pct(((px - stop) / px) * 100)} below)`, style: risk > 0 ? S.muted : S.red }])
      }
      if (!isOpen(Date.now()) && !(s.config.broker === 'simulator' && s.config.simulatorAnytime))
        lines.push([{ text: 'The market is closed: a market order waits for the open.', style: S.yellow }])
      if (s.config.broker === 'alpaca-live') lines.push([{ text: 'REAL MONEY — this is your live Alpaca account.', style: S.redBold }])
      if (s.config.halted) lines.push([{ text: 'The kill switch is on: every order is refused until you switch it off (K).', style: S.redBold }])
      return lines
    },
    onSubmit: async (v) => {
      const sym = v.symbol.trim().toUpperCase().replace(/^\$/, '')
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) return 'Give a US stock or ETF ticker (indexes and futures can’t be traded here).'
      const amount = num(v.amount)
      if (!Number.isFinite(amount) || amount <= 0) return 'How many shares, or how many dollars?'
      const request: OrderRequest = {
        symbol: sym,
        side: v.side === 'sell' ? 'sell' : 'buy',
        ...(v.size === 'dollars' ? { notional: amount } : { qty: amount }),
        type: v.size === 'shares' && v.type === 'limit' ? 'limit' : 'market',
        reason: v.reason?.trim() || 'Placed by hand from the CLI desk'
      }
      if (request.type === 'limit') {
        const limit = num(v.limit)
        if (!Number.isFinite(limit) || limit <= 0) return 'A limit order needs a limit price.'
        request.limitPrice = limit
      }
      if (request.side === 'buy') {
        if (Number.isFinite(num(v.stop))) request.stopLoss = num(v.stop)
        if (Number.isFinite(num(v.target))) request.takeProfit = num(v.target)
        if (Number.isFinite(num(v.trail))) request.trailPct = num(v.trail)
      }
      if (view.snapshot?.config.broker === 'alpaca-live') {
        const sure = await ask(view, 'Real money', `${request.side === 'buy' ? 'Buy' : 'Sell'} ${v.size === 'dollars' ? usd(amount) + ' of' : shares(amount)} ${sym} in your live Alpaca account?`, true, 'place it')
        if (!sure) return 'Not placed.'
      }
      try {
        const order = await invoke<TradingOrder>('trading:place-order', request)
        if (order.status === 'rejected') return `Refused: ${order.error ?? 'by a limit'}`
        view.app.toast(`${order.side === 'buy' ? 'Bought' : 'Sold'} ${shares(order.filledQty || order.qty)} ${order.symbol}${order.filledAvgPrice ? ` @ ${price(order.filledAvgPrice)}` : ` — ${order.status}`}`, 'success')
        view.market.refreshAll()
      } catch (error) {
        return message(error)
      }
    }
  })
  view.app.push(form)
}

/* -------------------------------------------------------------- exits */

export function openExit(view: TradingView, position: TradingPosition): void {
  const exit = position.exit
  view.app.push(
    new EditForm({
      title: `Protect ${position.symbol}`,
      intro: `Eaon sells the whole holding at market when the price reaches a stop or a target. It watches while Eaon runs. ${position.symbol} is at ${price(position.price)}; you hold ${shares(position.qty)} @ ${price(position.avgPrice)}. Leave a field empty to remove it.`,
      width: 84,
      initial: {
        stop: exit?.stopPrice ? String(exit.stopPrice) : '',
        target: exit?.targetPrice ? String(exit.targetPrice) : '',
        trail: exit?.trailPct ? String(exit.trailPct) : ''
      },
      fields: [
        { key: 'stop', label: 'Stop price', kind: 'number', hint: 'below the price now' },
        { key: 'target', label: 'Target price', kind: 'number', hint: 'above the price now' },
        { key: 'trail', label: 'Trailing stop %', kind: 'number', hint: '0.5–50' }
      ],
      preview: (v) => {
        const out: { text: string; style?: Style }[][] = []
        const stop = num(v.stop)
        const target = num(v.target)
        const trail = num(v.trail)
        if (Number.isFinite(stop)) out.push([{ text: `Stop ${pct(((position.price - stop) / position.price) * 100)} below · loses ≈ ${usd((stop - position.avgPrice) * position.qty)} from your cost`, style: stop < position.price ? S.muted : S.red }])
        if (Number.isFinite(target)) out.push([{ text: `Target ${pct(((target - position.price) / position.price) * 100)} above · gains ≈ ${usd((target - position.avgPrice) * position.qty)}`, style: target > position.price ? S.muted : S.red }])
        if (Number.isFinite(trail)) out.push([{ text: `Trails ${trail}% under the highest price from now on (starts at ${price(position.price * (1 - trail / 100))})`, style: S.muted }])
        if (!out.length) out.push([{ text: 'No exit: nothing sells this holding automatically.', style: S.yellow }])
        return out
      },
      onSubmit: async (v) => {
        const field = (value: string): number | null => (value.trim() === '' ? null : num(value))
        try {
          view.snapshot = await invoke<TradingSnapshot>('trading:set-exit', { symbol: position.symbol, stopPrice: field(v.stop), targetPrice: field(v.target), trailPct: field(v.trail) })
          view.app.toast(`${position.symbol}: exit saved`, 'success')
        } catch (error) {
          return message(error)
        }
      }
    })
  )
}

export function closePosition(view: TradingView, symbol: string): void {
  const position = view.positions().find((p) => p.symbol === symbol)
  if (!position) return
  void ask(view, `Sell all ${symbol}?`, `Sells ${shares(position.qty)} ${symbol} at market (≈ ${usd(position.marketValue)}).`, view.broker === 'alpaca-live', 'sell all').then(async (yes) => {
    if (!yes) return
    try {
      const order = await invoke<TradingOrder>('trading:close-position', symbol)
      view.app.toast(order.status === 'rejected' ? `Refused: ${order.error}` : `Selling ${symbol}: ${order.status}`, order.status === 'rejected' ? 'error' : 'success')
    } catch (error) {
      view.app.toast(message(error), 'error')
    }
  })
}

/* ------------------------------------------------------------ sessions */

/** How long to trade for: a bare number is hours ("3", "4.5"), else as `parseUntil`. */
export function parseRunFor(text: string, now = Date.now()): number | null {
  const t = text.trim()
  return parseUntil(/^\d+(\.\d+)?$/.test(t) ? `${t}h` : t, now)
}

/** "15:30", "3pm", "90m", "2h" or "close" (five minutes before it) as a time. */
export function parseUntil(text: string, now = Date.now()): number | null {
  const t = text.trim().toLowerCase()
  if (!t || t === 'close' || t === 'the close') return nextClose(now) - 5 * 60_000
  const rel = /^(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hr|hours?)$/.exec(t)
  if (rel) return now + Number(rel[1]) * (rel[2].startsWith('h') ? 3600_000 : 60_000)
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t)
  if (!m) return null
  let hour = Number(m[1])
  if (m[3] === 'pm' && hour < 12) hour += 12
  if (m[3] === 'am' && hour === 12) hour = 0
  const at = new Date(now)
  at.setHours(hour, Number(m[2] ?? 0), 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

export function openStartSession(view: TradingView): void {
  const s = view.snapshot
  if (!s) return view.app.toast(view.loadError ?? 'The desk is still loading', 'error')
  if (s.needsDisclaimer) return void afterDisclaimer(view, () => openStartSession(view))
  if (s.activeSession) return view.app.toast('A session is already running. Stop it first (X on the agent desk, 1).', 'error')
  view.app.push(
    new EditForm({
      title: 'Start the agent trading',
      intro: 'The agent looks at the market every few minutes and decides, inside your limits, until the time you set. It can only use the trading tools and web search.',
      width: 92,
      initial: { until: '2h', every: '5', flatten: 'true' },
      fields: [
        { key: 'strategy', label: 'Strategy', kind: 'multiline', placeholder: 'In your words: what to trade, when to buy, when to sell…' },
        { key: 'until', label: 'Run for', kind: 'text', hint: 'hours (2, 4.5), 90m, until a time (15:30), or close' },
        {
          key: 'every',
          label: 'Check every',
          kind: 'choice',
          options: ['1', '2', '5', '10', '15', '30', '60'].map((m) => ({ value: m, label: `${m} min` }))
        },
        { key: 'flatten', label: 'Sell all at the end', kind: 'toggle', hint: 'otherwise holdings are kept' },
        { key: 'name', label: 'Name', kind: 'text', placeholder: 'optional' }
      ],
      preview: (v) => {
        const until = parseRunFor(v.until ?? '')
        const config = view.snapshot?.config
        const model = config?.model ? `${config.model.modelId}` : `${modelLabel(chatModel())} (the chat model)`
        const out: { text: string; style?: Style }[][] = [
          [{ text: until ? `Trades for ${Math.round(((until - Date.now()) / 3_600_000) * 10) / 10} h, until ${new Date(until).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'How long: hours (2, 4.5), 90m, a time (15:30), or close', style: until ? S.text : S.yellow }],
          [{ text: `Runs on ${model} · ${BROKERS.find((b) => b.id === config?.broker)?.label ?? ''}`, style: S.muted }]
        ]
        if (config?.broker === 'alpaca-live') out.push([{ text: 'REAL MONEY: the agent places live orders on its own, inside your limits.', style: S.redBold }])
        if (!isOpen(Date.now()) && !(config?.broker === 'simulator' && config.simulatorAnytime)) out.push([{ text: 'The market is closed; the agent waits for the open.', style: S.yellow }])
        return out
      },
      onSubmit: async (v) => {
        if (!v.strategy?.trim()) return 'Describe the strategy in a sentence or two.'
        const until = parseRunFor(v.until ?? '')
        if (!until) return 'How long should it trade? 2 (hours), 90m, 15:30, or close.'
        if (view.snapshot?.config.broker === 'alpaca-live' && !(await ask(view, 'Real money', 'Let the agent trade your live Alpaca account on its own until the end time?', true, 'start'))) return 'Not started.'
        try {
          await invoke('trading:start-session', { strategy: v.strategy.trim(), until, everyMinutes: Number(v.every), flattenAtEnd: v.flatten === 'true', ...(v.name?.trim() ? { name: v.name.trim() } : {}) })
          view.app.toast('The agent is trading', 'success')
          view.setPage('agent')
        } catch (error) {
          return message(error)
        }
      }
    })
  )
}

export function stopSession(view: TradingView): void {
  const active = view.snapshot?.activeSession
  if (!active) return view.app.toast('No session is running')
  void ask(view, 'Stop the agent?', `Stops “${active.name}” now. Its open orders are cancelled; holdings are kept.`, false, 'stop').then(async (yes) => {
    if (!yes) return
    try {
      view.snapshot = await invoke<TradingSnapshot>('trading:stop-session', active.id)
      view.app.toast('Session stopped')
    } catch (error) {
      view.app.toast(message(error), 'error')
    }
  })
}

const DAY_KEYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function parseDays(text: string): number[] | null {
  const t = text.trim().toLowerCase()
  if (!t || t === 'weekdays' || t === 'mon-fri' || t === 'mon–fri') return [1, 2, 3, 4, 5]
  if (t === 'every day' || t === 'daily') return [0, 1, 2, 3, 4, 5, 6]
  const out = new Set<number>()
  for (const part of t.split(/[\s,]+/)) {
    const range = /^(\w{3})\w*[-–](\w{3})\w*$/.exec(part)
    if (range && range[1] in DAY_KEYS && range[2] in DAY_KEYS) {
      for (let d = DAY_KEYS[range[1]]; ; d = (d + 1) % 7) {
        out.add(d)
        if (d === DAY_KEYS[range[2]]) break
      }
      continue
    }
    const key = part.slice(0, 3)
    if (!(key in DAY_KEYS)) return null
    out.add(DAY_KEYS[key])
  }
  return [...out].sort()
}

export function openSchedule(view: TradingView, schedule?: TradingSchedule): void {
  view.app.push(
    new EditForm({
      title: schedule ? `Schedule · ${schedule.name}` : 'New schedule',
      intro: 'On the days you pick, the agent starts trading at the start time and stops at the end, with this strategy.',
      width: 92,
      initial: schedule
        ? { name: schedule.name, days: daysLabel(schedule.days), start: schedule.start, end: schedule.end, strategy: schedule.strategy, every: String(schedule.everyMinutes), flatten: String(schedule.flattenAtEnd), enabled: String(schedule.enabled) }
        : { days: 'Mon–Fri', start: '09:45', end: '15:45', every: '5', flatten: 'true', enabled: 'true' },
      fields: [
        { key: 'name', label: 'Name', kind: 'text', placeholder: 'Morning momentum' },
        { key: 'days', label: 'Days', kind: 'text', hint: 'Mon–Fri, mon wed fri, every day' },
        { key: 'start', label: 'Start (local)', kind: 'text', hint: 'HH:MM' },
        { key: 'end', label: 'End (local)', kind: 'text', hint: 'HH:MM' },
        { key: 'strategy', label: 'Strategy', kind: 'multiline' },
        { key: 'every', label: 'Check every', kind: 'choice', options: ['1', '2', '5', '10', '15', '30', '60'].map((m) => ({ value: m, label: `${m} min` })) },
        { key: 'flatten', label: 'Sell all at the end', kind: 'toggle' },
        { key: 'enabled', label: 'On', kind: 'toggle' }
      ],
      onSubmit: async (v) => {
        const days = parseDays(v.days ?? '')
        if (!days || days.length === 0) return 'Which days? Mon–Fri, or names like mon wed fri.'
        const time = /^([01]?\d|2[0-3]):([0-5]\d)$/
        if (!time.test(v.start ?? '') || !time.test(v.end ?? '')) return 'Times are HH:MM, like 09:45.'
        if (!v.strategy?.trim()) return 'Describe the strategy.'
        const pad = (t: string): string => t.padStart(5, '0')
        const draft: TradingScheduleDraft = {
          ...(schedule ? { id: schedule.id } : {}),
          name: v.name?.trim() || v.strategy.trim().slice(0, 40),
          days,
          start: pad(v.start),
          end: pad(v.end),
          strategy: v.strategy.trim(),
          everyMinutes: Number(v.every),
          flattenAtEnd: v.flatten === 'true',
          enabled: v.enabled === 'true'
        }
        try {
          await invoke('trading:save-schedule', draft)
          view.app.toast('Schedule saved', 'success')
        } catch (error) {
          return message(error)
        }
      }
    })
  )
}

export function toggleSchedule(view: TradingView): void {
  const schedule = view.snapshot?.schedules[view.schedules.selected]
  if (!schedule || view.sessionsFocus !== 'schedules') return view.app.toast('Select a schedule (⇥ switches lists)')
  const { id, createdAt: _created, ...rest } = schedule
  void invoke('trading:save-schedule', { ...rest, id, enabled: !schedule.enabled }).then(
    () => view.app.toast(`${schedule.name}: ${schedule.enabled ? 'off' : 'on'}`),
    (error) => view.app.toast(message(error), 'error')
  )
}

export function removeSchedule(view: TradingView): void {
  const schedule = view.snapshot?.schedules[view.schedules.selected]
  if (!schedule) return
  void ask(view, 'Delete this schedule?', `“${schedule.name}” won’t start again. Past sessions stay in the list.`, true, 'delete').then(async (yes) => {
    if (!yes) return
    try {
      view.snapshot = await invoke<TradingSnapshot>('trading:remove-schedule', schedule.id)
    } catch (error) {
      view.app.toast(message(error), 'error')
    }
  })
}

/** Picks the model the trading sessions run on (or "follow the chat"). */
export function pickTradingModel(view: TradingView): void {
  openModelPicker(view.app, (model) => void setConfig(view, { model: model ? { providerId: model.providerId, modelId: model.id } : null }).catch((error) => view.app.toast(message(error), 'error')), {
    title: 'Model for trading sessions',
    follow: 'Follow the chat model'
  })
}

/* ------------------------------------------------------- kill switch */

export function confirmKill(view: TradingView): void {
  const halted = view.snapshot?.config.halted
  void ask(
    view,
    halted ? 'Switch the kill switch off?' : 'Kill switch',
    halted ? 'Orders and sessions are allowed again, inside your limits.' : 'Stops the running session and refuses every order — yours, the agent’s and every worker’s — until you switch it off. Holdings are kept.',
    !halted,
    halted ? 'switch off' : 'stop everything'
  ).then(async (yes) => {
    if (!yes) return
    try {
      await setConfig(view, { halted: !halted })
      view.app.toast(halted ? 'Kill switch off' : 'Kill switch ON — nothing trades', halted ? 'info' : 'error')
    } catch (error) {
      view.app.toast(message(error), 'error')
    }
  })
}

/* --------------------------------------------------------------- setup */

/** Asks for an Alpaca account's API keys (checked with Alpaca, kept in the vault), then runs `then`. */
export function linkAlpaca(view: TradingView, kind: 'paper' | 'live', then?: () => void): void {
  view.app.push(
    new PromptModal({
      title: `Alpaca ${kind} — API key ID`,
      label: `From app.alpaca.markets → ${kind === 'paper' ? 'Paper' : 'Live'} account → API keys. Checked with Alpaca before it’s saved; kept in the vault.`,
      onSubmit: (keyId) => {
        if (!keyId.trim()) return 'Paste the key ID.'
        view.app.push(
          new PromptModal({
            title: `Alpaca ${kind} — secret key`,
            mask: true,
            onSubmit: async (secret) => {
              try {
                view.snapshot = await invoke<TradingSnapshot>('trading:set-keys', kind, keyId.trim(), secret.trim())
                view.app.toast(`Alpaca ${kind} keys saved`, 'success')
                then?.()
              } catch (error) {
                return message(error)
              }
            }
          })
        )
      }
    })
  )
}

export function openSetup(view: TradingView): void {
  if (!view.snapshot) return view.app.toast(view.loadError ?? 'The desk is still loading', 'error')
  const config = (): TradingConfig => view.snapshot!.config
  const run = (work: () => Promise<void>): void => void work().catch((error) => view.app.toast(message(error), 'error'))
  const limitRow = (key: keyof TradingConfig['limits'], label: string, unit: '$' | '%' | '', step: number, detail: string): FormRow => ({
    section: 'Limits',
    label,
    value: () => {
      const v = config().limits[key] as number
      return unit === '$' ? usd(v, 0) : unit === '%' ? `${v}%` : String(v)
    },
    adjust: (by) => {
      const v = config().limits[key] as number
      return setConfig(view, { limits: { [key]: Math.max(step, v + by * step) } })
    },
    edit: () =>
      view.app.push(
        new PromptModal({
          title: label,
          initial: String(config().limits[key]),
          onSubmit: async (value) => {
            const n = num(value)
            if (!Number.isFinite(n) || n <= 0) return 'A positive number.'
            try {
              await setConfig(view, { limits: { [key]: n } })
            } catch (error) {
              return message(error)
            }
          }
        })
      ),
    detail: () => [detail, '-/+ steps it, ⏎ types a value.']
  })
  const keysRow = (kind: 'paper' | 'live'): FormRow => ({
    section: 'Broker',
    label: `Alpaca ${kind} keys`,
    value: () => (view.snapshot!.keys[kind] ? 'saved ✓' : 'not set'),
    valueStyle: () => (view.snapshot!.keys[kind] ? { fg: C.green } : { fg: C.muted }),
    edit: () => linkAlpaca(view, kind),
    reset: async () => {
      view.snapshot = await invoke<TradingSnapshot>('trading:clear-keys', kind)
    },
    detail: () => [`Keys for Alpaca's ${kind} account. d removes them.`]
  })
  const brokers: BrokerKind[] = ['simulator', 'alpaca-paper', 'alpaca-live']
  view.app.push(
    new FormModal({
      title: '⍑ EAON · Trading setup',
      columns: ['SETTING', 'VALUE', '', ''],
      width: 104,
      rows: () => [
        {
          section: 'Broker',
          label: 'Broker',
          value: () => BROKERS.find((b) => b.id === config().broker)?.label ?? config().broker,
          valueStyle: () => ({ fg: config().broker === 'alpaca-live' ? C.red : C.text, bold: true }),
          cycle: (by) => {
            const next = brokers[(brokers.indexOf(config().broker) + by + brokers.length) % brokers.length]
            return setConfig(view, { broker: next })
          },
          detail: () => [BROKERS.find((b) => b.id === config().broker)?.description ?? '', 'Switching broker stops a running session.']
        },
        keysRow('paper'),
        keysRow('live'),
        {
          section: 'Broker',
          label: 'Real money',
          value: () => (config().liveConfirmedAt ? `confirmed ${new Date(config().liveConfirmedAt!).toLocaleDateString()}` : 'not confirmed'),
          valueStyle: () => ({ fg: config().liveConfirmedAt ? C.red : C.muted }),
          edit: () =>
            view.app.push(
              new PromptModal({
                title: 'Confirm real-money trading',
                label: `Alpaca live refuses every order until you type exactly:\n“${LIVE_CONFIRMATION}”`,
                onSubmit: async (phrase) => {
                  try {
                    view.snapshot = await invoke<TradingSnapshot>('trading:confirm-live', phrase.trim())
                    view.app.toast('Real-money trading confirmed', 'error')
                  } catch (error) {
                    return message(error)
                  }
                }
              })
            ),
          detail: () => ['Live orders need this typed once, in the CLI too.']
        },
        limitRow('maxOrderUsd', 'Max per order', '$', 250, 'The largest single order, in dollars.'),
        limitRow('maxPositionPct', 'Max per stock', '%', 1, 'The largest holding in one stock, as a share of equity.'),
        limitRow('maxInvestedPct', 'Max invested', '%', 5, 'At most this share of equity in stocks; the rest stays cash.'),
        limitRow('maxDailyLossPct', 'Daily loss stop', '%', 0.5, 'Buying stops for the day once equity is down this much since the open. Selling stays allowed.'),
        limitRow('maxOrdersPerDay', 'Orders per day', '', 5, 'A cap on orders per day, all sources together.'),
        {
          section: 'Limits',
          label: 'Allowed symbols',
          value: () => (config().limits.allowedSymbols.length ? config().limits.allowedSymbols.join(' ') : 'any US stock or ETF'),
          edit: () =>
            view.app.push(
              new PromptModal({
                title: 'Allowed symbols',
                label: 'Only these tickers, separated by spaces. Leave empty for any US stock or ETF.',
                initial: config().limits.allowedSymbols.join(' '),
                onSubmit: async (value) => {
                  const list = value.toUpperCase().split(/[\s,]+/).filter(Boolean)
                  try {
                    await setConfig(view, { limits: { allowedSymbols: list } })
                  } catch (error) {
                    return message(error)
                  }
                }
              })
            ),
          reset: () => setConfig(view, { limits: { allowedSymbols: [] } }),
          detail: () => ['⏎ edits the list, d allows everything.']
        },
        {
          section: 'Simulator',
          label: 'Starting cash',
          value: () => usd(config().simulatorCash, 0),
          edit: () =>
            view.app.push(
              new PromptModal({
                title: 'Simulator starting cash',
                initial: String(config().simulatorCash),
                onSubmit: async (value) => {
                  try {
                    await setConfig(view, { simulatorCash: num(value) })
                  } catch (error) {
                    return message(error)
                  }
                }
              })
            ),
          detail: () => ['What the simulator starts with, and goes back to on reset.']
        },
        {
          section: 'Simulator',
          label: 'Fill any time',
          value: () => (config().simulatorAnytime ? 'on — fills at the last price, market open or not' : 'off — only while the market is open'),
          cycle: () => setConfig(view, { simulatorAnytime: !config().simulatorAnytime }),
          detail: () => ['For practising outside market hours.']
        },
        {
          section: 'Simulator',
          label: 'Reset simulator',
          value: () => 'press ⏎',
          valueStyle: () => ({ fg: C.muted }),
          edit: () =>
            run(async () => {
              if (!(await ask(view, 'Reset the simulator?', `Back to ${usd(config().simulatorCash, 0)} cash, no holdings, and its order history cleared.`, true, 'reset'))) return
              view.snapshot = await invoke<TradingSnapshot>('trading:reset-simulator')
              view.app.toast('Simulator reset')
            }),
          detail: () => ['Wipes the simulator’s account, ledger and equity curve.']
        },
        {
          section: 'Agent',
          label: 'Trading model',
          value: () => (config().model ? config().model!.modelId : `${modelLabel(chatModel())} (follows chat)`),
          valueStyle: () => ({ fg: config().model ? C.text : C.muted }),
          edit: () =>
            openModelPicker(view.app, (model) => run(() => setConfig(view, { model: model ? { providerId: model.providerId, modelId: model.id } : null })), {
              title: 'Model for trading sessions',
              follow: 'Follow the chat model'
            }),
          reset: () => setConfig(view, { model: null }),
          detail: () => ['The model each session check runs on. A fast, capable model with tool use works best.']
        },
        {
          section: 'Agent',
          label: 'Kill switch',
          value: () => (config().halted ? 'ON — nothing trades' : 'off'),
          valueStyle: () => ({ fg: config().halted ? C.red : C.muted, bold: config().halted }),
          edit: () => confirmKill(view),
          cycle: () => confirmKill(view),
          detail: () => ['Refuses every order and stops sessions until switched off.']
        }
      ],
      footer: () => (view.snapshot?.error ? `⚠ ${view.snapshot.error}` : view.snapshot?.dataSource ?? ''),
      hints: [['↑↓', 'setting'], ['←→', 'change'], ['-/+', 'step'], ['⏎', 'edit'], ['d', 'clear'], ['esc', 'close']]
    })
  )
}
