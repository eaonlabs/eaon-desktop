/**
 * A card a worker designs itself (show_ui), for when no ready-made card
 * (workerCards.ts) fits: "How's NVDA doing?" answered with the stock's live
 * price and chart, a few figures, what moved it and a button to set an alert.
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

export type UiBlock =
  | { type: 'heading'; text: string; detail?: string }
  | { type: 'text'; text: string }
  | { type: 'stats'; items: { label: string; value: string; change?: string; tone?: UiTone }[] }
  | { type: 'chart'; style: ChartStyle; unit?: string; views: { label: string; series: UiSeries[] }[] }
  | { type: 'stock'; symbol: string; range: StockRange; news: boolean }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'list'; items: { title: string; detail?: string; value?: string; tone?: UiTone }[] }
  | { type: 'progress'; label: string; value: number; max: number; detail?: string; tone?: UiTone }
  | { type: 'badges'; items: { label: string; tone?: UiTone }[] }
  | { type: 'tabs'; tabs: { label: string; blocks: UiBlock[] }[] }
  | { type: 'buttons'; actions: CardAction[] }
  | { type: 'divider' }

export type UiBlockType = UiBlock['type']

export interface WorkerUi {
  title?: string
  subtitle?: string
  blocks: UiBlock[]
}

export const UI_BLOCK_TYPES: UiBlockType[] = ['heading', 'text', 'stats', 'chart', 'stock', 'table', 'list', 'progress', 'badges', 'tabs', 'buttons', 'divider']
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
    case 'stats': {
      const items = list(b.items ?? b.stats, MAX_ITEMS)
        .map((i) => {
          const o = obj(i)
          const label = text(o?.label, 40)
          const value = text(o?.value, 40)
          if (!o || !label || !value) return null
          const change = optional(o.change ?? o.delta, 24)
          const t = tone(o.tone) ?? (change?.startsWith('-') || change?.startsWith('−') ? 'down' : change?.startsWith('+') ? 'up' : undefined)
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
      return { type, style, views, ...(optional(b.unit, 12) ? { unit: optional(b.unit, 12) } : {}) }
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
      return tabs.length >= 2 ? { type, tabs } : 'tabs needs two tabs or more, each {label, blocks}'
    }
    case 'buttons': {
      const actions = cardActions(b.actions ?? b.buttons)
      return actions ? { type, actions } : 'buttons needs actions: [{label, reply | url}]'
    }
    case 'divider':
      return { type }
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
  return { ui: { ...(title ? { title } : {}), ...(subtitle ? { subtitle } : {}), blocks }, skipped }
}

/** A short line for the tool's answer and the thread's preview: what the card shows. */
export function uiSummary(ui: WorkerUi): string {
  const stock = ui.blocks.find((b): b is Extract<UiBlock, { type: 'stock' }> => b.type === 'stock')
  return ui.title ?? (stock ? `${stock.symbol}` : 'a card')
}
