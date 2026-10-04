import type { DiffLine, FileDiff } from '../coding/diff'
import { highlightLine, languageOf, onBackground, type HighlightState, type Token } from './highlight'
import type { Line, Segment } from './markdown'
import { charWidth, strWidth, type Style } from './term'
import { C, S } from './theme'

/**
 * Drawing diffs and code listings in the transcript.
 *
 * Unified: a gutter with the old and new line numbers, the +/− sign, then
 * the code with syntax colour on a green or red tint. Split (wide
 * terminals): the old file on the left and the new on the right, removed
 * and added lines paired across. Long lines are cut at the edge rather than
 * wrapped, so the numbers stay lined up with the code.
 */

const ADD_BG = '#14301F'
const DEL_BG = '#3B1619'
const ADD_SIGN: Style = { fg: '#3DDC84', bg: ADD_BG, bold: true }
const DEL_SIGN: Style = { fg: '#FF6B61', bg: DEL_BG, bold: true }
const GUTTER: Style = { fg: '#55555B' }
const HUNK: Style = { fg: '#6E7FA8' }

function clip(tokens: Token[], width: number): Segment[] {
  const out: Segment[] = []
  let used = 0
  for (const t of tokens) {
    if (used >= width) break
    let text = ''
    for (const ch of t.text.replace(/\t/g, '  ')) {
      const w = charWidth(ch)
      if (used + w > width) break
      text += ch
      used += w
    }
    if (text) out.push({ text, style: t.style })
  }
  return out
}

function pad(segments: Segment[], width: number, bg?: string): Segment[] {
  const used = segments.reduce((s, x) => s + strWidth(x.text), 0)
  return used < width ? [...segments, { text: ' '.repeat(width - used), style: bg ? { bg } : undefined }] : segments
}

const num = (n: number | null, width: number): string => (n === null ? ' '.repeat(width) : String(n).padStart(width))

export interface DiffRenderOptions {
  /** Show at most this many diff rows (hunk headers included); the rest are counted. */
  maxRows?: number
  /** Side by side, when there is room. */
  split?: boolean
  indent?: string
}

/** Rows of one file's diff. */
export function renderDiff(diff: FileDiff, width: number, options: DiffRenderOptions = {}): Line[] {
  const indent = options.indent ?? ''
  const inner = Math.max(20, width - indent.length)
  const lang = languageOf(diff.path)
  if (diff.binary) return [[{ text: indent }, { text: 'Binary file changed', style: S.muted }]]
  if (diff.hunks.length === 0) {
    if (diff.status === 'renamed') return [[{ text: indent }, { text: `renamed from ${diff.oldPath}`, style: S.muted }]]
    return [[{ text: indent }, { text: diff.status === 'deleted' ? 'File deleted (it was empty)' : 'No changes to show', style: S.muted }]]
  }
  const rows = options.split && inner >= 120 ? splitRows(diff, inner, lang) : unifiedRows(diff, inner, lang)
  const max = options.maxRows ?? Infinity
  const out = rows.slice(0, max).map((row) => [{ text: indent }, ...row])
  if (rows.length > max) out.push([{ text: indent }, { text: `… ${rows.length - max} more lines · ⌃O shows all · /diff opens the viewer`, style: S.faint }])
  return out
}

function unifiedRows(diff: FileDiff, width: number, lang: string): Line[] {
  const widest = Math.max(...diff.hunks.map((h) => Math.max(h.oldStart + h.oldLines, h.newStart + h.newLines)))
  const nw = Math.max(2, String(widest).length)
  const codeWidth = Math.max(10, width - (nw * 2 + 4))
  const rows: Line[] = []
  diff.hunks.forEach((hunk, index) => {
    if (index > 0 || hunk.oldStart > 1) rows.push([{ text: `${' '.repeat(nw * 2 + 1)} ⋯ @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, style: HUNK }])
    // Colour each side's lines in order, so a comment opened above carries down.
    const oldState: HighlightState = {}
    const newState: HighlightState = {}
    for (const line of hunk.lines) rows.push(unifiedRow(line, nw, codeWidth, lang, line.kind === 'add' ? newState : line.kind === 'del' ? oldState : newState))
  })
  return rows
}

function unifiedRow(line: DiffLine, nw: number, codeWidth: number, lang: string, state: HighlightState): Line {
  const tokens = highlightLine(line.text, lang, state)
  if (line.kind === 'context') {
    return [{ text: `${num(line.oldNo, nw)} ${num(line.newNo, nw)} `, style: GUTTER }, { text: '  ' }, ...clip(tokens, codeWidth)]
  }
  const bg = line.kind === 'add' ? ADD_BG : DEL_BG
  const sign = line.kind === 'add' ? ADD_SIGN : DEL_SIGN
  return [
    { text: `${num(line.oldNo, nw)} ${num(line.newNo, nw)} `, style: { ...GUTTER, bg } },
    { text: line.kind === 'add' ? '+ ' : '- ', style: sign },
    ...pad(clip(onBackground(tokens, bg), codeWidth), codeWidth, bg)
  ]
}

function splitRows(diff: FileDiff, width: number, lang: string): Line[] {
  const widest = Math.max(...diff.hunks.map((h) => Math.max(h.oldStart + h.oldLines, h.newStart + h.newLines)))
  const nw = Math.max(2, String(widest).length)
  const half = Math.floor((width - 1) / 2)
  const code = half - nw - 3
  const side = (line: DiffLine | null, kind: 'old' | 'new', state: HighlightState): Segment[] => {
    if (!line) return [{ text: ' '.repeat(half), style: { bg: '#141416' } }]
    const n = kind === 'old' ? line.oldNo : line.newNo
    const changed = line.kind !== 'context'
    const bg = changed ? (line.kind === 'add' ? ADD_BG : DEL_BG) : undefined
    const tokens = highlightLine(line.text, lang, state)
    const body = changed ? onBackground(tokens, bg!) : tokens
    return [
      { text: `${num(n, nw)} `, style: { ...GUTTER, ...(bg ? { bg } : {}) } },
      { text: changed ? (line.kind === 'add' ? '+ ' : '- ') : '  ', style: changed ? (line.kind === 'add' ? ADD_SIGN : DEL_SIGN) : undefined },
      ...pad(clip(body, code), code, bg)
    ]
  }
  const rows: Line[] = []
  diff.hunks.forEach((hunk, index) => {
    if (index > 0 || hunk.oldStart > 1) rows.push([{ text: `${' '.repeat(nw)} ⋯ @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, style: HUNK }])
    const oldState: HighlightState = {}
    const newState: HighlightState = {}
    let i = 0
    const lines = hunk.lines
    while (i < lines.length) {
      if (lines[i].kind === 'context') {
        rows.push([...side(lines[i], 'old', oldState), { text: '│', style: S.border }, ...side(lines[i], 'new', newState)])
        i++
        continue
      }
      // Pair a run of removals with the run of additions after it.
      const dels: DiffLine[] = []
      const adds: DiffLine[] = []
      while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++])
      while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++])
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        rows.push([...side(dels[k] ?? null, 'old', oldState), { text: '│', style: S.border }, ...side(adds[k] ?? null, 'new', newState)])
      }
    }
  })
  return rows
}

/** A file's text with line numbers and colour: what write_file created. */
export function renderCode(path: string, text: string, width: number, options: { maxRows?: number; indent?: string; from?: number } = {}): Line[] {
  const indent = options.indent ?? ''
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const from = options.from ?? 1
  const nw = Math.max(2, String(from + lines.length).length)
  const codeWidth = Math.max(10, width - indent.length - nw - 2)
  const lang = languageOf(path)
  const state: HighlightState = {}
  const max = options.maxRows ?? Infinity
  const out: Line[] = []
  for (let i = 0; i < lines.length && i < max; i++) {
    out.push([{ text: indent }, { text: `${String(from + i).padStart(nw)}  `, style: GUTTER }, ...clip(highlightLine(lines[i], lang, state), codeWidth)])
  }
  if (lines.length > max) out.push([{ text: indent }, { text: `… ${lines.length - max} more lines · ⌃O shows all`, style: S.faint }])
  return out
}

/** "+12 −3" with colours. */
export function stats(additions: number, deletions: number): Segment[] {
  const out: Segment[] = []
  if (additions) out.push({ text: `+${additions}`, style: { fg: C.green } })
  if (deletions) out.push({ text: `${additions ? ' ' : ''}−${deletions}`, style: { fg: C.red } })
  return out
}

export const STATUS_MARK: Record<FileDiff['status'], { text: string; style: Style }> = {
  added: { text: 'A', style: { fg: C.green, bold: true } },
  modified: { text: 'M', style: { fg: C.amber, bold: true } },
  deleted: { text: 'D', style: { fg: C.red, bold: true } },
  renamed: { text: 'R', style: { fg: C.cyan, bold: true } }
}
