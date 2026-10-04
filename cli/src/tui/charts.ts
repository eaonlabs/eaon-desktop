import type { Canvas } from './screen'
import type { Style } from './term'
import { C, S } from './theme'

/**
 * Charts drawn with text: a braille line chart (each cell is a 2×4 grid of
 * dots, so a 60-column chart has 120 points across), candles, sparklines
 * and bars made of eighth-blocks.
 */

const BRAILLE_BASE = 0x2800
// Dot bit for (column 0..1, row 0..3) inside one braille cell.
const DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80]
]

export interface LineChartOptions {
  style?: Style
  /** A dotted reference line (the previous close, the starting equity). */
  baseline?: number | null
  baselineStyle?: Style
  min?: number
  max?: number
  /** Colour the line green above the baseline and red below it, as a desk does. */
  splitColors?: boolean
}

export function scaleOf(values: number[], baseline?: number | null, min?: number, max?: number): { lo: number; hi: number } {
  const finite = values.filter((v) => Number.isFinite(v))
  let lo = min ?? Math.min(...finite, ...(baseline != null ? [baseline] : []))
  let hi = max ?? Math.max(...finite, ...(baseline != null ? [baseline] : []))
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 }
  if (hi - lo < 1e-9) {
    const pad = Math.abs(hi) * 0.01 || 1
    lo -= pad
    hi += pad
  }
  const pad = (hi - lo) * 0.06
  return { lo: lo - pad, hi: hi + pad }
}

/** Draws `values` (oldest first) as a line across the whole canvas. Returns the scale used. */
export function lineChart(c: Canvas, values: number[], options: LineChartOptions = {}): { lo: number; hi: number } {
  const w = c.w
  const h = c.h
  const scale = scaleOf(values, options.baseline, options.min, options.max)
  if (w < 2 || h < 1 || values.length === 0) return scale
  const dotsW = w * 2
  const dotsH = h * 4
  const yOf = (v: number): number => Math.round(((scale.hi - v) / (scale.hi - scale.lo)) * (dotsH - 1))
  const cells = new Uint8Array(w * h)
  const above = new Int8Array(w * h)
  const set = (x: number, y: number, sign: number): void => {
    if (x < 0 || y < 0 || x >= dotsW || y >= dotsH) return
    const i = Math.floor(y / 4) * w + Math.floor(x / 2)
    cells[i] |= DOTS[y % 4][x % 2]
    if (sign !== 0) above[i] = sign
  }
  // Baseline first, as a sparse dotted row.
  let baseY = -1
  if (options.baseline != null && Number.isFinite(options.baseline)) {
    baseY = yOf(options.baseline)
    for (let x = 0; x < dotsW; x += 4) set(x, baseY, 0)
  }
  const n = values.length
  let prev: { x: number; y: number } | null = null
  for (let x = 0; x < dotsW; x++) {
    const index = n === 1 ? 0 : Math.round((x / (dotsW - 1)) * (n - 1))
    const v = values[index]
    if (!Number.isFinite(v)) {
      prev = null
      continue
    }
    const y = yOf(v)
    const sign = options.baseline != null ? (v >= options.baseline ? 1 : -1) : 0
    if (prev) {
      // Join to the previous point so steep moves stay connected.
      const [a, b] = prev.y <= y ? [prev.y, y] : [y, prev.y]
      for (let yy = a; yy <= b; yy++) set(x, yy, sign)
    } else set(x, y, sign)
    prev = { x, y }
  }
  const lineStyle = options.style ?? { fg: C.blue }
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const i = row * w + col
      if (!cells[i]) continue
      const isBase = baseY >= 0 && Math.floor(baseY / 4) === row && above[i] === 0
      const style = isBase
        ? (options.baselineStyle ?? S.faint)
        : options.splitColors && above[i] !== 0
          ? { fg: above[i] > 0 ? C.green : C.red }
          : lineStyle
      c.text(col, row, String.fromCharCode(BRAILLE_BASE + cells[i]), style)
    }
  }
  return scale
}

export interface Candle {
  o: number
  h: number
  l: number
  c: number
}

/** One column per candle (the newest on the right), wicks as │ and bodies as █. */
export function candleChart(c: Canvas, candles: Candle[], scale?: { lo: number; hi: number }): { lo: number; hi: number } {
  const shown = candles.slice(-c.w)
  const s = scale ?? scaleOf(shown.flatMap((k) => [k.h, k.l]))
  const rowOf = (v: number): number => Math.max(0, Math.min(c.h - 1, Math.round(((s.hi - v) / (s.hi - s.lo)) * (c.h - 1))))
  const offset = c.w - shown.length
  shown.forEach((k, i) => {
    const up = k.c >= k.o
    const style: Style = { fg: up ? C.green : C.red }
    const top = rowOf(k.h)
    const bottom = rowOf(k.l)
    const bodyTop = rowOf(Math.max(k.o, k.c))
    const bodyBottom = rowOf(Math.min(k.o, k.c))
    for (let r = top; r <= bottom; r++) c.text(offset + i, r, r >= bodyTop && r <= bodyBottom ? '█' : '│', style)
  })
  return s
}

/** Merges candles into `buckets` groups so a long history fits the width. */
export function bucketCandles(candles: Candle[], buckets: number): Candle[] {
  if (candles.length <= buckets) return candles
  const out: Candle[] = []
  const size = candles.length / buckets
  for (let b = 0; b < buckets; b++) {
    const group = candles.slice(Math.floor(b * size), Math.floor((b + 1) * size))
    if (group.length === 0) continue
    out.push({ o: group[0].o, c: group[group.length - 1].c, h: Math.max(...group.map((k) => k.h)), l: Math.min(...group.map((k) => k.l)) })
  }
  return out
}

const SPARK = '▁▂▃▄▅▆▇█'

export function sparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) return ''
  const sample = Array.from({ length: Math.min(width, values.length) }, (_, i) => values[Math.round((i / Math.max(1, Math.min(width, values.length) - 1)) * (values.length - 1))])
  const lo = Math.min(...sample)
  const hi = Math.max(...sample)
  return sample.map((v) => SPARK[hi - lo < 1e-12 ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join('')
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A horizontal bar `fraction` (0–1) of `width`, in eighth-blocks. */
export function bar(fraction: number, width: number): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  const eighths = Math.round(f * width * 8)
  return '█'.repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8]
}

/** Vertical bars along the bottom row(s) of the canvas, for volume under a price chart. */
export function columnBars(c: Canvas, values: number[], styleOf: (i: number) => Style): void {
  const shown = values.slice(-c.w)
  const hi = Math.max(...shown, 1)
  const offset = c.w - shown.length
  shown.forEach((v, i) => {
    const height = (v / hi) * c.h * 8
    const full = Math.floor(height / 8)
    const part = Math.round(height % 8)
    for (let r = 0; r < full && r < c.h; r++) c.text(offset + i, c.h - 1 - r, '█', styleOf(i))
    if (part > 0 && full < c.h) c.text(offset + i, c.h - 1 - full, SPARK[part - 1], styleOf(i))
  })
}

/** Price labels for a chart's right edge: top, middle, bottom. */
export function axisLabels(scale: { lo: number; hi: number }, rows: number, format: (v: number) => string): { row: number; text: string }[] {
  if (rows < 2) return []
  const at = (row: number): number => scale.hi - ((scale.hi - scale.lo) * row) / (rows - 1)
  const picks = rows >= 7 ? [0, Math.floor((rows - 1) / 3), Math.floor((2 * (rows - 1)) / 3), rows - 1] : [0, rows - 1]
  return picks.map((row) => ({ row, text: format(at(row)) }))
}
