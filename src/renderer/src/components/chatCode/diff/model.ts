/**
 * The diff viewer's model, kept free of React so the test harness can run it:
 * a line diff of two texts, the hunks a reader sees with unchanged runs folded
 * between them, the words that changed inside a changed line, and the file as
 * it was before a chat's edits, worked back from the file as it is now.
 */

export type RowKind = 'ctx' | 'add' | 'del'

export interface DiffRow {
  kind: RowKind
  text: string
  /** Line number in the old text; null for an added line or when unknown. */
  old: number | null
  /** Line number in the new text; null for a removed line or when unknown. */
  cur: number | null
}

/**
 * What a file's diff draws, top to bottom: runs of rows, and between them the
 * unchanged lines left out. A gap knows its rows when the texts are known and
 * can open in place; one from a patch knows only how many lines it stands for
 * until the file is read. A break sits between edits whose place in the file
 * isn't known.
 */
export type DiffBlock =
  | { type: 'rows'; rows: DiffRow[] }
  | { type: 'gap'; count: number; old: number; cur: number; rows: DiffRow[] | null }
  | { type: 'break' }

/** One file's diff, ready to draw. */
export interface DiffFileModel {
  /** Stable across reloads: the path, and the scope it was read in. */
  key: string
  /** Relative to the chat's folder. */
  path: string
  oldPath?: string | null
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  added: number
  removed: number
  binary?: boolean
  blocks: DiffBlock[]
}

/** Lines of unchanged context kept around each change. */
export const CONTEXT = 3
/** A run of unchanged lines this short is shown rather than folded: folding it saves nothing. */
const MIN_GAP = 3
/** Past this many edit steps between two texts, the rest of the middle is drawn as removed then added. */
const MAX_EDITS = 2000

/** A text's lines; a final newline ends the last line rather than starting an empty one. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

type Op = 0 | 1 | 2 // equal, delete, insert

/**
 * The shortest edit script from `a` to `b` (Myers, 1986), as one op per
 * line. Each round's frontier is kept only as wide as it can be (2d+1), so a
 * few hundred changed lines in a long file stay small.
 */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDITS) return null
    // The frontier as it stood before this round, k from -d to d.
    trace.push(v.slice(offset - d, offset + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d]
    const at = (k: number): number => v[k + d]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push(0)
      x--
      y--
    }
    ops.push(prevK === k + 1 ? 2 : 1)
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    ops.push(0)
    x--
    y--
  }
  return ops.reverse()
}

/**
 * Every line of both texts in order, numbered: unchanged, removed or added.
 * Within a run of changes the removed lines come first, the way a review
 * reads (and so a changed line's two versions sit one above the other).
 */
export function diffLines(beforeLines: string[], afterLines: string[]): DiffRow[] {
  // The unchanged head and tail are most of a typical edit and cost nothing to set aside.
  let head = 0
  while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) head++
  let tail = 0
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  )
    tail++
  const a = beforeLines.slice(head, beforeLines.length - tail)
  const b = afterLines.slice(head, afterLines.length - tail)
  const ops = myers(a, b) ?? [...a.map((): Op => 1), ...b.map((): Op => 2)]

  const rows: DiffRow[] = []
  for (let i = 0; i < head; i++) rows.push({ kind: 'ctx', text: beforeLines[i], old: i + 1, cur: i + 1 })
  let i = 0
  let j = 0
  let dels: DiffRow[] = []
  let adds: DiffRow[] = []
  const flush = (): void => {
    rows.push(...dels, ...adds)
    dels = []
    adds = []
  }
  for (const op of ops) {
    if (op === 0) {
      flush()
      rows.push({ kind: 'ctx', text: a[i], old: head + i + 1, cur: head + j + 1 })
      i++
      j++
    } else if (op === 1) {
      dels.push({ kind: 'del', text: a[i], old: head + i + 1, cur: null })
      i++
    } else {
      adds.push({ kind: 'add', text: b[j], old: null, cur: head + j + 1 })
      j++
    }
  }
  flush()
  for (let t = 0; t < tail; t++) {
    const oi = beforeLines.length - tail + t
    const ni = afterLines.length - tail + t
    rows.push({ kind: 'ctx', text: beforeLines[oi], old: oi + 1, cur: ni + 1 })
  }
  return rows
}

/** Lines added and removed between two texts. */
export function countChanges(before: string, after: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const row of diffLines(splitLines(before), splitLines(after))) {
    if (row.kind === 'add') added++
    else if (row.kind === 'del') removed++
  }
  return { added, removed }
}

/**
 * Rows folded for reading: each change with `context` unchanged lines either
 * side, and the unchanged runs between them as gaps that keep their rows.
 */
export function toBlocks(rows: DiffRow[], context = CONTEXT): DiffBlock[] {
  const blocks: DiffBlock[] = []
  if (!rows.some((r) => r.kind !== 'ctx')) return rows.length ? [{ type: 'gap', count: rows.length, old: rows[0].old ?? 1, cur: rows[0].cur ?? 1, rows }] : []
  let shown: DiffRow[] = []
  const pushGap = (hidden: DiffRow[]): void => {
    if (hidden.length < MIN_GAP) {
      shown.push(...hidden)
      return
    }
    if (shown.length) blocks.push({ type: 'rows', rows: shown })
    shown = []
    blocks.push({ type: 'gap', count: hidden.length, old: hidden[0].old ?? 0, cur: hidden[0].cur ?? 0, rows: hidden })
  }
  let i = 0
  while (i < rows.length) {
    if (rows[i].kind !== 'ctx') {
      shown.push(rows[i++])
      continue
    }
    let end = i
    while (end < rows.length && rows[end].kind === 'ctx') end++
    const run = rows.slice(i, end)
    const first = i === 0
    const last = end === rows.length
    const keepHead = first ? 0 : context
    const keepTail = last ? 0 : context
    if (run.length <= keepHead + keepTail + MIN_GAP - 1) shown.push(...run)
    else {
      shown.push(...run.slice(0, keepHead))
      pushGap(run.slice(keepHead, run.length - keepTail))
      shown.push(...run.slice(run.length - keepTail))
    }
    i = end
  }
  if (shown.length) blocks.push({ type: 'rows', rows: shown })
  return blocks
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * A patch's hunks as blocks, with the unchanged lines between them as gaps.
 * Given the new file's lines, every gap (the end of the file's too) carries
 * its rows and opens in place; without them it only says how many lines.
 */
export function blocksFromHunks(hunks: { header: string; lines: DiffRow[] }[], newLines: string[] | null): DiffBlock[] {
  const blocks: DiffBlock[] = []
  let prevOld = 0
  let prevCur = 0
  const gapRows = (old: number, cur: number, count: number): DiffRow[] | null =>
    newLines && cur - 1 + count <= newLines.length
      ? Array.from({ length: count }, (_, k) => ({ kind: 'ctx' as const, text: newLines[cur - 1 + k], old: old + k, cur: cur + k }))
      : null
  for (const hunk of hunks) {
    const m = HUNK_HEADER.exec(hunk.header)
    const oldStart = m ? Number(m[1]) : (hunk.lines.find((l) => l.old !== null)?.old ?? prevOld + 1)
    const curStart = m ? Number(m[2]) : (hunk.lines.find((l) => l.cur !== null)?.cur ?? prevCur + 1)
    // A hunk that adds a whole file starts at old 0, one that deletes it at new 0.
    const count = curStart > 0 ? curStart - prevCur - 1 : oldStart - prevOld - 1
    if (count > 0) blocks.push({ type: 'gap', count, old: prevOld + 1, cur: prevCur + 1, rows: gapRows(prevOld + 1, prevCur + 1, count) })
    blocks.push({ type: 'rows', rows: hunk.lines })
    for (const line of hunk.lines) {
      if (line.old !== null) prevOld = Math.max(prevOld, line.old)
      if (line.cur !== null) prevCur = Math.max(prevCur, line.cur)
    }
  }
  if (newLines && hunks.length && newLines.length > prevCur) {
    const count = newLines.length - prevCur
    blocks.push({ type: 'gap', count, old: prevOld + 1, cur: prevCur + 1, rows: gapRows(prevOld + 1, prevCur + 1, count) })
  }
  return blocks
}

/* ------------------------------------------------------------ word diff */

export interface Span {
  from: number
  to: number
}

const WORD = /\w+|\s+|[^\w\s]/g
/** Lines with more tokens than this get no word-level marks: the table would cost more than it shows. */
const MAX_TOKENS = 400

/**
 * Where two versions of one line differ, word by word, as character ranges in
 * each. Null when the lines share too little for the marks to help: then the
 * whole line is the change, and the line's own tint already says so.
 */
export function wordDiff(a: string, b: string): { a: Span[]; b: Span[] } | null {
  if (a === b) return null
  const ta = a.match(WORD) ?? []
  const tb = b.match(WORD) ?? []
  if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS || ta.length === 0 || tb.length === 0) return null
  const n = ta.length
  const m = tb.length
  const lcs = new Uint16Array((n + 1) * (m + 1))
  const w = m + 1
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = ta[i] === tb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
  const keepA = new Uint8Array(n)
  const keepB = new Uint8Array(m)
  let common = 0
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (ta[i] === tb[j]) {
      keepA[i++] = 1
      keepB[j++] = 1
      common += ta[i - 1].length
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++
    else j++
  }
  // Mostly rewritten: marking nearly every word reads worse than marking none.
  if ((2 * common) / (a.length + b.length) < 0.4) return null
  const spans = (tokens: string[], keep: Uint8Array): Span[] => {
    const out: Span[] = []
    let at = 0
    for (let i = 0; i < tokens.length; i++) {
      const from = at
      at += tokens[i].length
      if (keep[i]) continue
      const prev = out[out.length - 1]
      // A single space between two changed words joins them into one mark.
      if (prev && (prev.to === from || (from - prev.to <= 1 && /^\s?$/.test(tokens[i - 1] ?? '')))) prev.to = at
      else out.push({ from, to: at })
    }
    return out
  }
  const sa = spans(ta, keepA)
  const sb = spans(tb, keepB)
  if (sa.length === 0 && sb.length === 0) return null
  return { a: sa, b: sb }
}

/**
 * Word marks for a run of rows: within each run of changes, the n-th removed
 * line is paired with the n-th added one. Keyed by the row object.
 */
export function wordMarks(rows: DiffRow[]): Map<DiffRow, Span[]> {
  const marks = new Map<DiffRow, Span[]>()
  let i = 0
  while (i < rows.length) {
    if (rows[i].kind === 'ctx') {
      i++
      continue
    }
    const dels: DiffRow[] = []
    const adds: DiffRow[] = []
    while (i < rows.length && rows[i].kind === 'del') dels.push(rows[i++])
    while (i < rows.length && rows[i].kind === 'add') adds.push(rows[i++])
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const diff = wordDiff(dels[k].text, adds[k].text)
      if (!diff) continue
      if (diff.a.length) marks.set(dels[k], diff.a)
      if (diff.b.length) marks.set(adds[k], diff.b)
    }
  }
  return marks
}

/* ---------------------------------------------------------- side by side */

export interface SplitRow {
  left: DiffRow | null
  right: DiffRow | null
}

/** Rows side by side: unchanged lines on both, each removed line beside the added one that replaced it. */
export function splitPairs(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i].kind === 'ctx') {
      out.push({ left: rows[i], right: rows[i] })
      i++
      continue
    }
    const dels: DiffRow[] = []
    const adds: DiffRow[] = []
    while (i < rows.length && rows[i].kind === 'del') dels.push(rows[i++])
    while (i < rows.length && rows[i].kind === 'add') adds.push(rows[i++])
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null })
  }
  return out
}

/* --------------------------------------------------------- undoing edits */

/** One change a tool made to a file: an exact replacement, or the whole file written. */
export interface EditStep {
  kind: 'edit' | 'write'
  before: string
  after: string
  replaceAll?: boolean
  /** A write whose `before` is the file as it really was, recorded when it ran. */
  seen?: boolean
}

/**
 * The file's text before each step and after the last, worked back from its
 * text now: `states[i]` is the file just before step i, `states[n]` is now.
 * A step that can't be undone exactly (its new text isn't there once, or a
 * write whose old content was never seen) leaves every earlier state null.
 * A write's old content is what it recorded; one from before that was
 * recorded is taken as empty when it is the file's first step (the file was
 * new).
 */
export function unwindEdits(now: string, steps: EditStep[]): (string | null)[] {
  const states: (string | null)[] = new Array(steps.length + 1).fill(null)
  states[steps.length] = now
  let text: string | null = now
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (text === null) break
    if (step.kind === 'write') {
      text = step.seen ? step.before : i === 0 ? '' : null
    } else if (!step.after) {
      text = null
    } else if (step.replaceAll) {
      text = text.includes(step.after) ? text.split(step.after).join(step.before) : null
    } else {
      const at = text.indexOf(step.after)
      text = at >= 0 && text.indexOf(step.after, at + 1) === -1 ? text.slice(0, at) + step.before + text.slice(at + step.after.length) : null
    }
    states[i] = text
  }
  return states
}
