/**
 * Line diffs: what an edit changed, as hunks the transcript can draw and the
 * model can read.
 *
 * Myers' algorithm on the part of the file that differs: the common prefix
 * and suffix are cut off first, so a one-line edit in a 5,000-line file
 * diffs a handful of lines. Each step keeps only the slice of the frontier
 * it can need when walking back (O(D²) memory for D changes); a change so
 * large that D passes a cap falls back to "all of this replaced by all of
 * that", which is what it effectively is anyway.
 */

export interface DiffLine {
  kind: 'context' | 'add' | 'del'
  text: string
  /** Line number in the old file (context and deletions). */
  oldNo: number | null
  /** Line number in the new file (context and additions). */
  newNo: number | null
}

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  oldPath?: string
  additions: number
  deletions: number
  hunks: Hunk[]
  binary?: boolean
}

type Op = { kind: ' ' | '+' | '-'; text: string }

const MAX_D = 3000

export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // A final newline ends the last line rather than starting another.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: { lo: number; data: Int32Array }[] = []
  let found = -1
  outer: for (let d = 0; d <= max; d++) {
    if (d > MAX_D) return null
    // Keep the slice of the frontier the walk back may read: k in [-d-1, d+1].
    const lo = offset - d - 1
    trace.push({ lo, data: v.slice(Math.max(0, lo), offset + d + 2) })
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break outer
      }
    }
  }
  if (found < 0) return null
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = found; d >= 0; d--) {
    const { lo, data } = trace[d]
    const at = (k: number): number => data[offset + k - Math.max(0, lo)]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ kind: ' ', text: a[x - 1] })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: '+', text: b[y - 1] })
      else ops.push({ kind: '-', text: a[x - 1] })
    }
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

/** The edit script turning `a` into `b`. */
export function diffOps(a: string[], b: string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const middle = myers(midA, midB) ?? [...midA.map((text) => ({ kind: '-' as const, text })), ...midB.map((text) => ({ kind: '+' as const, text }))]
  return [...a.slice(0, start).map((text) => ({ kind: ' ' as const, text })), ...middle, ...a.slice(endA).map((text) => ({ kind: ' ' as const, text }))]
}

/** Groups an edit script into unified hunks with `context` lines around each change. */
export function toHunks(ops: Op[], context = 3): Hunk[] {
  const lines: DiffLine[] = []
  let oldNo = 1
  let newNo = 1
  for (const op of ops) {
    if (op.kind === ' ') lines.push({ kind: 'context', text: op.text, oldNo: oldNo++, newNo: newNo++ })
    else if (op.kind === '-') lines.push({ kind: 'del', text: op.text, oldNo: oldNo++, newNo: null })
    else lines.push({ kind: 'add', text: op.text, oldNo: null, newNo: newNo++ })
  }
  const changed = lines.map((l, i) => (l.kind === 'context' ? -1 : i)).filter((i) => i >= 0)
  if (changed.length === 0) return []
  const hunks: Hunk[] = []
  let from = Math.max(0, changed[0] - context)
  let to = Math.min(lines.length - 1, changed[0] + context)
  const close = (): void => {
    const slice = lines.slice(from, to + 1)
    const firstOld = slice.find((l) => l.oldNo !== null)?.oldNo ?? 0
    const firstNew = slice.find((l) => l.newNo !== null)?.newNo ?? 0
    hunks.push({
      oldStart: firstOld,
      oldLines: slice.filter((l) => l.kind !== 'add').length,
      newStart: firstNew,
      newLines: slice.filter((l) => l.kind !== 'del').length,
      lines: slice
    })
  }
  for (const i of changed.slice(1)) {
    if (i - context <= to + 1) to = Math.min(lines.length - 1, i + context)
    else {
      close()
      from = Math.max(0, i - context)
      to = Math.min(lines.length - 1, i + context)
    }
  }
  close()
  return hunks
}

/** A whole-file diff; `before` null means the file was created, `after` null deleted. */
export function fileDiff(path: string, before: string | null, after: string | null, context = 3): FileDiff {
  const a = splitLines(before ?? '')
  const b = splitLines(after ?? '')
  const ops = diffOps(a, b)
  return {
    path,
    status: before === null ? 'added' : after === null ? 'deleted' : 'modified',
    additions: ops.filter((o) => o.kind === '+').length,
    deletions: ops.filter((o) => o.kind === '-').length,
    hunks: toHunks(ops, context)
  }
}

/** Unified text, as `git diff` writes it: for the model, logs and copying. */
export function toUnified(diff: FileDiff): string {
  const out = [`--- ${diff.status === 'added' ? '/dev/null' : `a/${diff.oldPath ?? diff.path}`}`, `+++ ${diff.status === 'deleted' ? '/dev/null' : `b/${diff.path}`}`]
  for (const h of diff.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    for (const l of h.lines) out.push(`${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`)
  }
  return out.join('\n')
}

/** Parses `git diff` output (several files) into the same shape. */
export function parseUnified(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let hunk: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)
      file = { path: m?.[2] ?? raw.slice(11), status: 'modified', additions: 0, deletions: 0, hunks: [] }
      if (m && m[1] !== m[2]) file.oldPath = m[1]
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (raw.startsWith('new file mode')) file.status = 'added'
    else if (raw.startsWith('deleted file mode')) file.status = 'deleted'
    else if (raw.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = raw.slice(12)
    } else if (raw.startsWith('rename to ')) file.path = raw.slice(10)
    else if (raw.startsWith('Binary files ')) file.binary = true
    else if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
      if (!m) continue
      hunk = { oldStart: Number(m[1]), oldLines: Number(m[2] ?? 1), newStart: Number(m[3]), newLines: Number(m[4] ?? 1), lines: [] }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      file.hunks.push(hunk)
    } else if (hunk && !raw.startsWith('---') && !raw.startsWith('+++')) {
      if (raw.startsWith('+')) {
        hunk.lines.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ })
        file.additions++
      } else if (raw.startsWith('-')) {
        hunk.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null })
        file.deletions++
      } else if (raw.startsWith(' ')) hunk.lines.push({ kind: 'context', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return files
}

/** Totals for a set of file diffs. */
export function totals(diffs: FileDiff[]): { files: number; additions: number; deletions: number } {
  return diffs.reduce((t, d) => ({ files: t.files + 1, additions: t.additions + d.additions, deletions: t.deletions + d.deletions }), { files: 0, additions: 0, deletions: 0 })
}
