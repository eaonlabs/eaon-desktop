/**
 * A card an agent designs itself (show_ui), for when no ready-made card
 * (workerCards.ts) fits: "How's NVDA doing?" answered with the stock's live
 * price and chart, a few figures, what moved it and a button to set an alert;
 * a revenue figure with its trend by week, month and year; a flight, its
 * gate and boarding time. Workers have it, and so does Chat (the IDE).
 *
 * A card with an `id` is one the agent keeps: showing a card with the same id
 * again changes it where it first appeared instead of adding another, so an
 * agent can keep a build's status, a flight or a dashboard up to date over a
 * conversation (cardDeck, below). A field's old value shows struck through
 * beside its new one, given as `was` or worked out from the version before.
 *
 * It is made of blocks, not code: the worker picks and fills them, Eaon
 * draws them in its own style, and nothing the worker writes runs. The
 * interactive parts are Eaon's: tabs, a chart's views and its readout under
 * the pointer, a table sorted by a column, a stock's ranges (fetched live),
 * and buttons that answer the worker or open a link.
 *
 * As with show_card, the card is the call's input, kept in the transcript,
 * and both the tool (to refuse a malformed one with a useful error) and the
 * renderer read it through `normalizeUi`, which drops what it doesn't know.
 */

import { cardActions, type CardAction } from './workerCards'

export type UiTone = 'up' | 'down' | 'neutral' | 'good' | 'warn' | 'bad' | 'info'
export type ChartStyle = 'line' | 'area' | 'bar'
export type StockRange = '1d' | '5d' | '1mo' | '6mo' | '1y'

export interface UiPoint {
  /** What the point is at: a date, a time, a name ("Q3"). */
  x: string
  y: number
}
export interface UiSeries {
  name: string
  points: UiPoint[]
}

/** A place on a route: its code, big ("LIS"), and its name and time under it. */
export interface UiPlace {
  code: string
  name?: string
  time?: string
  /** The time it was before it changed, shown struck through. */
  was?: string
  tone?: UiTone
}
export type RouteMode = 'plane' | 'train' | 'car' | 'bus' | 'ship' | 'walk' | 'bike' | 'arrow'

/** A field in a grid: a label over its value, and the value it was before, struck through, if it changed. */
export interface UiField {
  label: string
  value: string
  was?: string
  tone?: UiTone
  detail?: string
}

export type UiBlock =
  | { type: 'heading'; text: string; detail?: string }
  /** One big figure: its label, the value large, and how it changed in a pill. */
  | { type: 'metric'; label: string; value: string; change?: string; tone?: UiTone; detail?: string }
  | { type: 'fields'; items: UiField[]; columns?: number }
  | { type: 'route'; from: UiPlace; to: UiPlace; mode: RouteMode; detail?: string }
  | { type: 'text'; text: string }
  | { type: 'stats'; items: { label: string; value: string; change?: string; tone?: UiTone }[] }
  | { type: 'chart'; style: ChartStyle; unit?: string; views: { label: string; series: UiSeries[] }[]; at?: 'bottom' }
  | { type: 'stock'; symbol: string; range: StockRange; news: boolean }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'list'; items: { title: string; detail?: string; value?: string; tone?: UiTone }[] }
  | { type: 'progress'; label: string; value: number; max: number; detail?: string; tone?: UiTone }
  | { type: 'badges'; items: { label: string; tone?: UiTone }[] }
  /** Views of the card to switch between; at the bottom, a segmented control under them (Week · Month · Year). */
  | { type: 'tabs'; tabs: { label: string; blocks: UiBlock[] }[]; at?: 'bottom' }
  | { type: 'buttons'; actions: CardAction[] }
  /** A rule; "ticket" is a perforation with a notch at each side, as on a boarding pass. */
  | { type: 'divider'; style?: 'ticket' }

export type UiBlockType = UiBlock['type']

/** The small pictures a card's header can carry. */
export const UI_ICONS = [
  'plane', 'train', 'car', 'bus', 'ship', 'package', 'truck', 'chart', 'dollar', 'wallet', 'calendar', 'clock', 'cloud', 'sun', 'home',
  'server', 'git', 'bug', 'check', 'alert', 'rocket', 'user', 'music', 'food', 'ticket', 'mail', 'globe', 'code', 'database', 'cpu', 'terminal', 'test'
] as const
export type UiIcon = (typeof UI_ICONS)[number]

export interface WorkerUi {
  /** The card's own name: showing one with the same id again changes it where it is (see cardDeck). */
  id?: string
  title?: string
  subtitle?: string
  icon?: UiIcon
  /** A pill at the header's end: "Delayed", "Passing", "Live". */
  status?: { label: string; tone?: UiTone }
  blocks: UiBlock[]
}

export const UI_BLOCK_TYPES: UiBlockType[] = ['heading', 'metric', 'text', 'stats', 'fields', 'route', 'chart', 'stock', 'table', 'list', 'progress', 'badges', 'tabs', 'buttons', 'divider']
export const ROUTE_MODES: RouteMode[] = ['plane', 'train', 'car', 'bus', 'ship', 'walk', 'bike', 'arrow']
export const STOCK_RANGES: StockRange[] = ['1d', '5d', '1mo', '6mo', '1y']
const TONES: UiTone[] = ['up', 'down', 'neutral', 'good', 'warn', 'bad', 'info']
const STYLES: ChartStyle[] = ['line', 'area', 'bar']

const MAX_BLOCKS = 24
const MAX_ITEMS = 12
const MAX_TABLE_ROWS = 30
const MAX_COLUMNS = 6
const MAX_SERIES = 4
const MAX_VIEWS = 6
const MAX_POINTS = 400
const MAX_TEXT = 1200

type Raw = Record<string, unknown>
const obj = (value: unknown): Raw | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null)
const text = (value: unknown, max = 160): string => {
  const s = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  const trimmed = s.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}
const optional = (value: unknown, max = 160): string | undefined => text(value, max) || undefined
const tone = (value: unknown): UiTone | undefined => (TONES.includes(value as UiTone) ? (value as UiTone) : undefined)
const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.replace(/[,$%\s]/g, '')) : NaN
  return Number.isFinite(n) ? n : null
}
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : [])

/** A series' points: `[{x, y}]`, `[[x, y]]`, or bare numbers (counted 1, 2, 3…). */
function points(value: unknown): UiPoint[] {
  return list(value, MAX_POINTS)
    .map((p, i): UiPoint | null => {
      if (typeof p === 'number') return Number.isFinite(p) ? { x: String(i + 1), y: p } : null
      if (Array.isArray(p)) {
        const y = num(p[1])
        return y === null ? null : { x: text(p[0], 40) || String(i + 1), y }
      }
      const o = obj(p)
      const y = num(o?.y ?? o?.value)
      return o && y !== null ? { x: text(o.x ?? o.label ?? o.date ?? o.t, 40) || String(i + 1), y } : null
    })
    .filter((p): p is UiPoint => p !== null)
}

function series(value: unknown): UiSeries[] {
  return list(value, MAX_SERIES)
    .map((s, i): UiSeries | null => {
      const o = obj(s)
      const pts = points(o ? (o.points ?? o.data ?? o.values) : s)
      return pts.length >= 2 ? { name: text(o?.name, 40) || `Series ${i + 1}`, points: pts } : null
    })
    .filter((s): s is UiSeries => s !== null)
}

/** "+2.4%" reads as up and "−3" as down, when no tone is given. */
const signTone = (change: string | undefined): UiTone | undefined =>
  change?.startsWith('-') || change?.startsWith('−') ? 'down' : change?.startsWith('+') ? 'up' : undefined

function place(value: unknown): UiPlace | null {
  const o = typeof value === 'string' ? { code: value } : obj(value)
  const code = text(o?.code ?? o?.label, 12)
  if (!o || !code) return null
  const time = optional(o.time, 24)
  const was = optional(o.was, 24)
  const t = tone(o.tone)
  return { code, ...(optional(o.name, 40) ? { name: optional(o.name, 40) } : {}), ...(time ? { time } : {}), ...(was && was !== time ? { was } : {}), ...(t ? { tone: t } : {}) }
}

/** A card's id: letters, digits and - _ . : (up to 60), so the agent can name it ("flight-nw214", "ci:main"). */
export function cardId(value: unknown): string | undefined {
  const id = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  return /^[\w.:-]{1,60}$/.test(id) ? id : undefined
}

/** One block, or why it can't be drawn. Tabs hold blocks of their own, one level deep. */
function block(raw: unknown, depth: number): UiBlock | string {
  const b = obj(raw)
  if (!b) return 'a block is an object with a type'
  const type = text(b.type, 20) as UiBlockType
  switch (type) {
    case 'heading': {
      const t = text(b.text ?? b.title)
      return t ? { type, text: t, ...(optional(b.detail ?? b.subtitle) ? { detail: optional(b.detail ?? b.subtitle) } : {}) } : 'heading needs text'
    }
    case 'text': {
      const t = text(b.text ?? b.body, MAX_TEXT)
      return t ? { type, text: t } : 'text needs text'
    }
    case 'metric': {
      const label = text(b.label, 60)
      const value = text(b.value, 32)
      if (!label || !value) return 'metric needs label and value'
      const change = optional(b.change ?? b.delta, 24)
      const t = tone(b.tone) ?? signTone(change)
      return { type, label, value, ...(change ? { change } : {}), ...(t ? { tone: t } : {}), ...(optional(b.detail, 120) ? { detail: optional(b.detail, 120) } : {}) }
    }
    case 'fields': {
      const items = list(b.items ?? b.fields, MAX_ITEMS)
        .map((i) => {
          const o = obj(i)
          const label = text(o?.label, 40)
          const value = text(o?.value, 60)
          if (!o || !label || !value) return null
          const was = optional(o.was ?? o.before, 60)
          const t = tone(o.tone)
          return { label, value, ...(was && was !== value ? { was } : {}), ...(t ? { tone: t } : {}), ...(optional(o.detail, 80) ? { detail: optional(o.detail, 80) } : {}) }
        })
        .filter((i): i is NonNullable<typeof i> => i !== null)
      const columns = num(b.columns)
      return items.length ? { type, items, ...(columns && columns >= 1 && columns <= 4 ? { columns: Math.round(columns) } : {}) } : 'fields needs items: [{label, value}]'
    }
    case 'route': {
      const from = place(b.from)
      const to = place(b.to)
      if (!from || !to) return 'route needs from and to, each {code, name, time}'
      const mode = ROUTE_MODES.includes(b.mode as RouteMode) ? (b.mode as RouteMode) : 'arrow'
      return { type, from, to, mode, ...(optional(b.detail, 120) ? { detail: optional(b.detail, 120) } : {}) }
    }
    case 'stats': {
      const items = list(b.items ?? b.stats, MAX_ITEMS)
        .map((i) => {
          const o = obj(i)
          const label = text(o?.label, 40)
          const value = text(o?.value, 40)
          if (!o || !label || !value) return null
          const change = optional(o.change ?? o.delta, 24)
          const t = tone(o.tone) ?? signTone(change)
          return { label, value, ...(change ? { change } : {}), ...(t ? { tone: t } : {}) }
        })
        .filter((i): i is NonNullable<typeof i> => i !== null)
      return items.length ? { type, items } : 'stats needs items: [{label, value}]'
    }
    case 'chart': {
      const style = STYLES.includes(b.style as ChartStyle) ? (b.style as ChartStyle) : 'line'
      // One set of series, or views to switch between ("1W", "1M", "1Y").
      const views = Array.isArray(b.views)
        ? list(b.views, MAX_VIEWS)
            .map((v) => {
              const o = obj(v)
              const s = series(o?.series)
              return o && s.length ? { label: text(o.label, 20) || 'View', series: s } : null
            })
            .filter((v): v is NonNullable<typeof v> => v !== null)
        : (() => {
            const s = series(b.series ?? (b.points ? [{ name: text(b.name, 40) || 'Value', points: b.points }] : undefined))
            return s.length ? [{ label: '', series: s }] : []
          })()
      if (!views.length) return 'chart needs series: [{name, points: [{x, y}, …]}] with two points or more'
      return { type, style, views, ...(optional(b.unit, 12) ? { unit: optional(b.unit, 12) } : {}), ...(b.at === 'bottom' && views.length > 1 ? { at: 'bottom' as const } : {}) }
    }
    case 'stock': {
      const symbol = text(b.symbol, 12).toUpperCase().replace(/^\$/, '')
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) return 'stock needs a US ticker in symbol, like "NVDA"'
      const range = STOCK_RANGES.includes(b.range as StockRange) ? (b.range as StockRange) : '1d'
      return { type, symbol, range, news: b.news === true }
    }
    case 'table': {
      const columns = list(b.columns, MAX_COLUMNS).map((c) => text(c, 40)).filter(Boolean)
      const rows = list(b.rows, MAX_TABLE_ROWS)
        .map((r) => (Array.isArray(r) ? r.slice(0, columns.length).map((cell) => text(cell, 80)) : null))
        .filter((r): r is string[] => r !== null && r.some(Boolean))
      return columns.length && rows.length ? { type, columns, rows: rows.map((r) => [...r, ...Array(columns.length - r.length).fill('')]) } : 'table needs columns and rows'
    }
    case 'list': {
      const items = list(b.items, MAX_ITEMS)
        .map((i) => {
          const o = typeof i === 'string' ? { title: i } : obj(i)
          const title = text(o?.title ?? o?.label, 100)
          if (!o || !title) return null
          const t = tone(o.tone)
          return { title, ...(optional(o.detail, 200) ? { detail: optional(o.detail, 200) } : {}), ...(optional(o.value, 40) ? { value: optional(o.value, 40) } : {}), ...(t ? { tone: t } : {}) }
        })
        .filter((i): i is NonNullable<typeof i> => i !== null)
      return items.length ? { type, items } : 'list needs items'
    }
    case 'progress': {
      const label = text(b.label, 60)
      const value = num(b.value)
      const max = num(b.max) ?? 100
      if (!label || value === null || max <= 0) return 'progress needs label and value (and max, 100 by default)'
      const t = tone(b.tone)
      return { type, label, value: Math.max(0, Math.min(value, max)), max, ...(optional(b.detail, 80) ? { detail: optional(b.detail, 80) } : {}), ...(t ? { tone: t } : {}) }
    }
    case 'badges': {
      const items = list(b.items, MAX_ITEMS)
        .map((i) => {
          const o = typeof i === 'string' ? { label: i } : obj(i)
          const label = text(o?.label, 32)
          const t = tone(o?.tone)
          return label ? { label, ...(t ? { tone: t } : {}) } : null
        })
        .filter((i): i is NonNullable<typeof i> => i !== null)
      return items.length ? { type, items } : 'badges needs items'
    }
    case 'tabs': {
      if (depth > 0) return 'tabs can’t hold tabs'
      const tabs = list(b.tabs, MAX_VIEWS)
        .map((t) => {
          const o = obj(t)
          const label = text(o?.label, 24)
          const inner = list(o?.blocks, MAX_BLOCKS)
            .map((x) => block(x, depth + 1))
            .filter((x): x is UiBlock => typeof x !== 'string')
          return label && inner.length ? { label, blocks: inner } : null
        })
        .filter((t): t is NonNullable<typeof t> => t !== null)
      return tabs.length >= 2 ? { type, tabs, ...(b.at === 'bottom' ? { at: 'bottom' as const } : {}) } : 'tabs needs two tabs or more, each {label, blocks}'
    }
    case 'buttons': {
      const actions = cardActions(b.actions ?? b.buttons)
      return actions ? { type, actions } : 'buttons needs actions: [{label, reply | url}]'
    }
    case 'divider':
      return b.style === 'ticket' ? { type, style: 'ticket' } : { type }
    default:
      return `unknown block type "${type || String(b.type)}" (use ${UI_BLOCK_TYPES.join(', ')})`
  }
}

/**
 * The card, or what is wrong with it. A block that can't be drawn is left out,
 * but the reasons come back to the tool so the worker can mend them, and a
 * card with nothing left is refused.
 */
export function normalizeUi(input: unknown): { ui: WorkerUi; skipped: string[] } | { error: string } {
  const raw = obj(input)
  if (!raw) return { error: 'Give the card as an object with blocks.' }
  const blocks: UiBlock[] = []
  const skipped: string[] = []
  list(raw.blocks, MAX_BLOCKS).forEach((b, i) => {
    const made = block(b, 0)
    if (typeof made === 'string') skipped.push(`block ${i + 1}: ${made}`)
    else blocks.push(made)
  })
  if (!blocks.length) return { error: skipped.length ? `Nothing on the card could be drawn: ${skipped.join('; ')}.` : 'Give the card some blocks.' }
  const title = optional(raw.title, 80)
  const subtitle = optional(raw.subtitle, 120)
  const id = cardId(raw.id)
  const icon = (UI_ICONS as readonly string[]).includes(raw.icon as string) ? (raw.icon as UiIcon) : undefined
  const statusRaw = typeof raw.status === 'string' ? { label: raw.status } : obj(raw.status)
  const statusLabel = text(statusRaw?.label, 32)
  const statusTone = tone(statusRaw?.tone)
  return {
    ui: {
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(icon ? { icon } : {}),
      ...(statusLabel ? { status: { label: statusLabel, ...(statusTone ? { tone: statusTone } : {}) } } : {}),
      blocks
    },
    skipped
  }
}

/** A short line for the tool's answer and the thread's preview: what the card shows. */
export function uiSummary(ui: WorkerUi): string {
  const stock = ui.blocks.find((b): b is Extract<UiBlock, { type: 'stock' }> => b.type === 'stock')
  return ui.title ?? (stock ? `${stock.symbol}` : 'a card')
}

/**
 * Every card with an id in a conversation, in order: where each first
 * appeared (the call that draws it) and its versions, oldest first. A later
 * call with the same id is drawn as a line saying the card changed; the
 * first draws the latest version. `calls` are the conversation's show_ui
 * calls in the order they were made.
 */
export interface CardDeck {
  /** By card id: the first call's id, and the input of every call, in order. */
  cards: Map<string, { first: string; versions: Record<string, unknown>[] }>
  /** By call id: the card id it showed. */
  byCall: Map<string, string>
}

export function cardDeck(calls: readonly { id: string; input: Record<string, unknown> }[]): CardDeck {
  const cards = new Map<string, { first: string; versions: Record<string, unknown>[] }>()
  const byCall = new Map<string, string>()
  for (const call of calls) {
    const id = cardId(call.input.id)
    if (!id) continue
    byCall.set(call.id, id)
    const card = cards.get(id)
    if (card) card.versions.push(call.input)
    else cards.set(id, { first: call.id, versions: [call.input] })
  }
  return { cards, byCall }
}

/**
 * The card with what changed since the version before marked: a field (or a
 * place's time on a route) whose value differs, with no `was` of its own,
 * shows the old value struck through, so an agent that only sends the new
 * state still shows what moved. Matched by label (a route by its codes).
 */
export function markChanges(ui: WorkerUi, before: WorkerUi | null): WorkerUi {
  if (!before) return ui
  const oldFields = new Map<string, string>()
  const oldTimes = new Map<string, string>()
  const collect = (blocks: UiBlock[]): void => {
    for (const b of blocks) {
      if (b.type === 'fields') for (const f of b.items) oldFields.set(f.label.toLowerCase(), f.value)
      if (b.type === 'route') for (const p of [b.from, b.to]) if (p.time) oldTimes.set(p.code.toLowerCase(), p.time)
      if (b.type === 'tabs') for (const t of b.tabs) collect(t.blocks)
    }
  }
  collect(before.blocks)
  const mark = (blocks: UiBlock[]): UiBlock[] =>
    blocks.map((b): UiBlock => {
      if (b.type === 'fields')
        return {
          ...b,
          items: b.items.map((f) => {
            const old = oldFields.get(f.label.toLowerCase())
            return f.was || old === undefined || old === f.value ? f : { ...f, was: old }
          })
        }
      if (b.type === 'route') {
        const at = (p: UiPlace): UiPlace => {
          const old = oldTimes.get(p.code.toLowerCase())
          return p.was || !p.time || old === undefined || old === p.time ? p : { ...p, was: old }
        }
        return { ...b, from: at(b.from), to: at(b.to) }
      }
      if (b.type === 'tabs') return { ...b, tabs: b.tabs.map((t) => ({ ...t, blocks: mark(t.blocks) })) }
      return b
    })
  return { ...ui, blocks: mark(ui.blocks) }
}
