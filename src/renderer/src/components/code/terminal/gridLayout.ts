import { gridColumns } from '@shared/terminals'

/**
 * The ADE's grid of terminals as tracks the user can resize: columns and rows
 * of `fr` sizes with a draggable divider between each pair. Plain functions,
 * so the arithmetic is tested apart from the pointer handling.
 *
 * The grid is laid out on CSS grid lines with a divider track between every
 * two tracks — `col 8px col 8px col` — so the dividers sit in the grid itself
 * and nothing has to be measured to place them.
 */

/** The space between two terminals, which is also the divider's grab area. */
export const DIVIDER_PX = 8
/** Narrower or shorter than this and a terminal shows too little to use. */
export const MIN_COLUMN_PX = 160
export const MIN_ROW_PX = 96

export interface Shape {
  cols: number
  rows: number
}

export interface Sizes {
  /** One `fr` weight per column / row. */
  cols: number[]
  rows: number[]
}

export function shapeFor(count: number): Shape {
  const cols = gridColumns(count)
  return { cols, rows: Math.max(1, Math.ceil(count / cols)) }
}

export const equalSizes = (shape: Shape): Sizes => ({ cols: Array(shape.cols).fill(1), rows: Array(shape.rows).fill(1) })

/** Sizes read back from storage, or equal ones when they don't fit this shape. */
export function validSizes(value: unknown, shape: Shape): Sizes {
  const v = value as Partial<Sizes> | null
  const ok = (list: unknown, n: number): list is number[] =>
    Array.isArray(list) && list.length === n && list.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)
  return v && ok(v.cols, shape.cols) && ok(v.rows, shape.rows) ? { cols: v.cols, rows: v.rows } : equalSizes(shape)
}

/** `grid-template-columns` (or rows): the tracks with a divider track between each two. */
export function template(weights: number[]): string {
  return weights.map((w) => `minmax(0, ${Number(w.toFixed(4))}fr)`).join(` ${DIVIDER_PX}px `)
}

/** Where the pane at `index` goes, on grid lines: the last pane of a short last row stretches to the end. */
export function placement(index: number, count: number, shape: Shape): { gridColumn: string; gridRow: string } {
  const row = Math.floor(index / shape.cols)
  const col = index % shape.cols
  const last = index === count - 1
  const startCol = 2 * col + 1
  const endCol = last ? 2 * shape.cols : startCol + 1
  return { gridColumn: `${startCol} / ${endCol}`, gridRow: `${2 * row + 1} / ${2 * row + 2}` }
}

/**
 * The column dividers, and the rows each one runs through. A divider between
 * columns k and k+1 runs the whole height, except where a short last row has
 * no terminal on its right: there it stops above that row.
 */
export function columnDividers(count: number, shape: Shape): { index: number; gridColumn: string; gridRow: string }[] {
  const lastRowCount = count - (shape.rows - 1) * shape.cols
  const out: { index: number; gridColumn: string; gridRow: string }[] = []
  for (let k = 0; k < shape.cols - 1; k++) {
    const throughLastRow = k < lastRowCount - 1
    if (!throughLastRow && shape.rows === 1) continue
    out.push({ index: k, gridColumn: `${2 * k + 2} / ${2 * k + 3}`, gridRow: throughLastRow ? '1 / -1' : `1 / ${2 * shape.rows - 1}` })
  }
  return out
}

export function rowDividers(shape: Shape): { index: number; gridColumn: string; gridRow: string }[] {
  return Array.from({ length: shape.rows - 1 }, (_, k) => ({ index: k, gridColumn: '1 / -1', gridRow: `${2 * k + 2} / ${2 * k + 3}` }))
}

/**
 * Moves the divider between tracks `k` and `k+1` by `deltaPx`: one grows and
 * its neighbour shrinks by the same amount, and neither goes under `minPx`.
 * `available` is the room the tracks share (the grid less its dividers).
 */
export function resizeTracks(weights: number[], k: number, deltaPx: number, available: number, minPx: number): number[] {
  if (k < 0 || k >= weights.length - 1 || available <= 0) return weights
  const total = weights.reduce((a, b) => a + b, 0)
  const perPx = total / available
  const pair = weights[k] + weights[k + 1]
  // Each of the two keeps at least minPx, unless there isn't room for both: then they share it evenly.
  const min = Math.min(minPx * perPx, pair / 2)
  const a = Math.min(pair - min, Math.max(min, weights[k] + deltaPx * perPx))
  const next = weights.slice()
  next[k] = a
  next[k + 1] = pair - a
  return next
}

/** What a divider's position is, as a percentage of the two tracks it sits between (for screen readers). */
export function dividerValue(weights: number[], k: number): number {
  const pair = weights[k] + weights[k + 1]
  return pair > 0 ? Math.round((weights[k] / pair) * 100) : 50
}

/** The panes with two of them swapped (by id); the same array when either isn't there. */
export function swapped<T extends { id: string }>(panes: T[], a: string, b: string): T[] {
  const i = panes.findIndex((p) => p.id === a)
  const j = panes.findIndex((p) => p.id === b)
  if (i === -1 || j === -1 || i === j) return panes
  const next = panes.slice()
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

/* ------------------------------------------------------------------ remembered sizes */

const KEY = 'eaon.ade.gridSizes'

/** Sizes are remembered per folder and grid shape: three terminals' columns say nothing about four's. */
const keyFor = (cwd: string, shape: Shape): string => `${cwd}|${shape.cols}x${shape.rows}`

function readAll(): Record<string, Sizes> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return value && typeof value === 'object' ? (value as Record<string, Sizes>) : {}
  } catch {
    return {}
  }
}

export function loadSizes(cwd: string, shape: Shape): Sizes {
  return validSizes(readAll()[keyFor(cwd, shape)], shape)
}

export function saveSizes(cwd: string, shape: Shape, sizes: Sizes): void {
  try {
    const all = readAll()
    const key = keyFor(cwd, shape)
    const equal = sizes.cols.every((w) => w === sizes.cols[0]) && sizes.rows.every((w) => w === sizes.rows[0])
    if (equal) delete all[key]
    else all[key] = sizes
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* sizes are remembered where storage allows; the grid works without */
  }
}
