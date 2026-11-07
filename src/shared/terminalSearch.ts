/**
 * Find in a terminal's output: the search over a pane's buffer, kept apart
 * from xterm so it runs under plain Node (the registry reads the rows).
 *
 * A row is one line of the buffer. A long line that the terminal wrapped is
 * several rows, the later ones marked `wrapped`; a search reads those as the
 * one line they are, so a word the terminal broke in two is still found, and
 * a match that crosses the break comes back as one segment per row.
 */

export interface SearchRow {
  /** The row's text, as the buffer holds it. Rows that a wrapped row follows keep their trailing spaces. */
  text: string
  /** This row continues the one before it. */
  wrapped: boolean
  /**
   * With wide characters (CJK, emoji), where each character of `text` starts
   * on the screen: `cols[i]` is the cell of the character that holds code
   * unit i, and `cols[text.length]` is where the row ends. Left out when
   * every character takes one cell.
   */
  cols?: number[]
}

export interface SearchOptions {
  caseSensitive?: boolean
  /** The query is a regular expression. */
  regex?: boolean
  /** Whole words only. */
  word?: boolean
}

/** The part of a match on one row, in terminal cells. */
export interface SearchSegment {
  row: number
  col: number
  width: number
}

export interface SearchMatch {
  /** Where it starts. */
  row: number
  col: number
  segments: SearchSegment[]
}

export interface SearchResult {
  matches: SearchMatch[]
  /** Stopped at the limit: there are more. */
  truncated: boolean
  /** Why the query can't be searched for (a regular expression that doesn't parse). */
  error?: string
}

/** The part of xterm's buffer the search reads (a real one satisfies it, so does a headless one). */
export interface BufferLike {
  length: number
  getLine(y: number):
    | {
        isWrapped: boolean
        length: number
        translateToString(trimRight?: boolean): string
        getCell(x: number, cell?: never): { getWidth(): number; getChars(): string } | undefined
      }
    | undefined
}

/** What the buffer shows, a row at a time, for the search. */
export function readRows(buffer: BufferLike): SearchRow[] {
  const rows: SearchRow[] = []
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (!line) {
      rows.push({ text: '', wrapped: false })
      continue
    }
    // A row a wrapped row follows keeps its trailing spaces: they are part of the line.
    const text = line.translateToString(!buffer.getLine(i + 1)?.isWrapped)
    const row: SearchRow = { text, wrapped: line.isWrapped }
    // Wide characters (CJK, emoji) take two cells, so a position in the text is not a column.
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7e]/.test(text)) {
      const cols: number[] = []
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)
        if (!cell || cell.getWidth() === 0) continue
        const chars = cell.getChars() || ' '
        for (let u = 0; u < chars.length; u++) cols.push(x)
      }
      cols.push(line.length)
      // The text may be shorter than the row (its trailing spaces were cut): its end is where the next character would start.
      if (cols.length >= text.length + 1) row.cols = cols.slice(0, text.length + 1)
    }
    rows.push(row)
  }
  return rows
}

/** More matches than this are counted as "this many or more": a log can hold a hundred thousand. */
export const MATCH_LIMIT = 2000

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The pattern a query stands for; the problem when a regular expression doesn't parse. */
export function patternFor(query: string, options: SearchOptions): RegExp | { error: string } {
  if (!query) return { error: '' }
  const source = options.regex ? query : escapeRegex(query)
  try {
    return new RegExp(options.word ? `\\b(?:${source})\\b` : source, options.caseSensitive ? 'g' : 'gi')
  } catch (error) {
    return { error: error instanceof Error ? error.message.replace(/^Invalid regular expression: /, '') : 'That isn’t a pattern.' }
  }
}

/** Every match of `query` in `rows`, oldest first, up to `limit`. */
export function searchRows(rows: SearchRow[], query: string, options: SearchOptions = {}, limit = MATCH_LIMIT): SearchResult {
  const pattern = patternFor(query, options)
  if (!(pattern instanceof RegExp)) return { matches: [], truncated: false, ...(pattern.error ? { error: pattern.error } : {}) }
  const matches: SearchMatch[] = []

  let start = 0
  while (start < rows.length) {
    // The rows of one line: the first, and every wrapped row after it.
    let end = start + 1
    while (end < rows.length && rows[end].wrapped) end++
    const offsets: number[] = []
    let text = ''
    for (let r = start; r < end; r++) {
      offsets.push(text.length)
      text += rows[r].text
    }
    if (text.length > 0) {
      pattern.lastIndex = 0
      for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
        // An empty match (`a*` against `b`) is nothing to show; step past it.
        if (m[0].length === 0) {
          pattern.lastIndex++
          continue
        }
        const segments = segmentsOf(rows, start, end, offsets, m.index, m.index + m[0].length)
        if (segments.length > 0) matches.push({ row: segments[0].row, col: segments[0].col, segments })
        if (matches.length >= limit) return { matches, truncated: true }
      }
    }
    start = end
  }
  return { matches, truncated: false }
}

function segmentsOf(rows: SearchRow[], first: number, end: number, offsets: number[], from: number, to: number): SearchSegment[] {
  const segments: SearchSegment[] = []
  for (let r = first; r < end; r++) {
    const row = rows[r]
    const base = offsets[r - first]
    const s = Math.max(from, base) - base
    const e = Math.min(to, base + row.text.length) - base
    if (e <= s) continue
    const col = row.cols ? row.cols[s] : s
    const stop = row.cols ? row.cols[e] : e
    if (stop > col) segments.push({ row: r, col, width: stop - col })
  }
  return segments
}

/**
 * The match to show after moving from `current` by `step` (1 is the next
 * older match, -1 the next newer), wrapping round at either end. With no
 * match to start from, the newest: that is where a search of a log begins.
 */
export function stepIndex(current: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1
  if (current < 0 || current >= count) return count - 1
  return (current - step + count) % count
}

/**
 * Which match to keep on screen after the buffer was searched again (new
 * output arrived): the one at the same place, else the closest index.
 */
export function keepMatch(before: SearchMatch | null, matches: SearchMatch[], index: number): number {
  if (matches.length === 0) return -1
  if (before) {
    const same = matches.findIndex((m) => m.row === before.row && m.col === before.col)
    if (same >= 0) return same
  }
  return Math.min(Math.max(index, 0), matches.length - 1)
}
