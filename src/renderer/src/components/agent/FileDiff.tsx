// Adapted from AICSS (MIT, Copyright (c) 2026 AICSS); see components/aicss/LICENSE.
import { memo, useMemo, type JSX } from 'react'

/**
 * The change an `edit_file` or `write_file` call made, as a unified diff: a
 * card with the file and its +/− counts, then two line-number gutters, the
 * sign, and the line with light syntax colouring.
 *
 * Computed here rather than in the tool: `edit_file` is given `old_text` and
 * `new_text`, and both travel with the call in the transcript, so the renderer
 * already holds everything a diff needs. The tool's own output stays the one
 * line the model should read ("Edited src/foo.ts (+3 lines)") instead of
 * carrying a rendering of itself.
 *
 * Line numbers are shown only when they are true. A new or rewritten file
 * (`write_file`) numbers from 1. An `edit_file` change is a snippet matched by
 * content, and the tool never says where in the file it landed, so its
 * numbers would be offsets into the snippet that read as file lines; those
 * gutters stay empty unless a caller passes where the change starts.
 */

type RowKind = 'add' | 'del' | 'ctx'
interface Row {
  kind: RowKind
  text: string
}

interface NumberedRow extends Row {
  old: number | null
  cur: number | null
}

/** Above this, the LCS table costs more than the diff is worth. */
const MAX_LINES = 600

function diffLines(before: string[], after: string[]): Row[] {
  if (before.length > MAX_LINES || after.length > MAX_LINES) {
    return [
      ...before.map((text): Row => ({ kind: 'del', text })),
      ...after.map((text): Row => ({ kind: 'add', text }))
    ]
  }

  const n = before.length
  const m = after.length
  // Longest common subsequence, filled from the end so the walk below can read
  // it forwards and keep runs of context in their original order.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const rows: Row[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      rows.push({ kind: 'ctx', text: before[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: 'del', text: before[i] })
      i++
    } else {
      rows.push({ kind: 'add', text: after[j] })
      j++
    }
  }
  while (i < n) rows.push({ kind: 'del', text: before[i++] })
  while (j < m) rows.push({ kind: 'add', text: after[j++] })
  return rows
}

/** Lines added and removed by one change, counted the way the diff draws them. */
export function diffStats(before: string, after: string): { added: number; removed: number } {
  if (before.length === 0) return { added: after.length === 0 ? 0 : after.split('\n').length, removed: 0 }
  let added = 0
  let removed = 0
  for (const row of diffLines(before.split('\n'), after.split('\n'))) {
    if (row.kind === 'add') added++
    else if (row.kind === 'del') removed++
  }
  return { added, removed }
}

/**
 * The rows of a change, with the old and new line numbers each would have
 * when the change starts at `oldStart`/`newStart`. A side with no known start
 * gets no numbers.
 */
export function numberRows(rows: Row[], oldStart: number | null, newStart: number | null): NumberedRow[] {
  let old = oldStart
  let cur = newStart
  return rows.map((row) => {
    const numbered: NumberedRow = {
      ...row,
      old: row.kind === 'add' || old === null ? null : old,
      cur: row.kind === 'del' || cur === null ? null : cur
    }
    if (row.kind !== 'add' && old !== null) old++
    if (row.kind !== 'del' && cur !== null) cur++
    return numbered
  })
}

const KEYWORDS = new Set([
  'export', 'function', 'return', 'const', 'let', 'var', 'if', 'else', 'throw', 'new',
  'import', 'from', 'async', 'await', 'class', 'extends', 'typeof', 'void', 'true',
  'false', 'null', 'undefined', 'for', 'while', 'switch', 'case', 'break', 'continue',
  'try', 'catch', 'finally', 'this', 'super', 'static', 'type', 'interface', 'enum', 'as', 'of', 'in',
  // A few that other languages share, so a Python or Go change isn't all one colour.
  'def', 'elif', 'except', 'lambda', 'pass', 'raise', 'with', 'yield', 'None', 'True', 'False',
  'func', 'package', 'struct', 'fn', 'pub', 'impl', 'use', 'mut', 'match'
])

export type TokenKind = 'txt' | 'kw' | 'str' | 'num' | 'fn' | 'cm'

/**
 * Light colouring for one line: keywords, strings, numbers, comments and
 * names that are called. Not a grammar, just enough for a diff to scan like
 * code; anything it doesn't recognise stays plain.
 */
export function tokenize(line: string): { t: TokenKind; v: string }[] {
  const raw: { kind: TokenKind | 'id'; v: string }[] = []
  const re =
    /(\s+)|(\/\/.*|#(?=\s|$).*)|(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)|(\S)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    if (m[1]) raw.push({ kind: 'txt', v: m[1] })
    else if (m[2] || m[3]) raw.push({ kind: 'cm', v: m[0] })
    else if (m[4]) raw.push({ kind: 'str', v: m[0] })
    else if (m[5]) raw.push({ kind: 'num', v: m[0] })
    else if (m[6]) raw.push({ kind: 'id', v: m[0] })
    else raw.push({ kind: 'txt', v: m[0] })
  }
  const out: { t: TokenKind; v: string }[] = []
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i]
    if (cur.kind !== 'id') {
      out.push({ t: cur.kind, v: cur.v })
      continue
    }
    if (KEYWORDS.has(cur.v)) {
      out.push({ t: 'kw', v: cur.v })
      continue
    }
    let j = i + 1
    while (j < raw.length && raw[j].kind === 'txt' && /^\s+$/.test(raw[j].v)) j++
    const next = raw[j]
    out.push({ t: next && next.v.startsWith('(') ? 'fn' : 'txt', v: cur.v })
  }
  return out
}

/** One line, coloured. Memoised on its text: a long diff re-renders as a whole when it opens. */
export const Code = memo(function Code({ text }: { text: string }): JSX.Element {
  const tokens = useMemo(() => tokenize(text), [text])
  return (
    <code className="diff__code">
      {tokens.map((token, index) =>
        token.t === 'txt' ? (
          token.v
        ) : (
          <span key={index} className={`tk-${token.t}`}>
            {token.v}
          </span>
        )
      )}
    </code>
  )
})

/** Memoised: its props are strings, and an open diff can be a thousand rows. */
export const FileDiff = memo(function FileDiff({
  file,
  before,
  after,
  oldStart,
  newStart,
  bare = false
}: {
  file: string
  before: string
  after: string
  /** Where the change starts in the old and new file, when known. */
  oldStart?: number
  newStart?: number
  /** Leaves out the file-and-stats header, for a list whose rows already show both. */
  bare?: boolean
}): JSX.Element {
  const created = before.length === 0
  const rows = useMemo(() => {
    // A brand-new file has no "before": every line reads as an addition rather
    // than as a diff against an empty string, which would look the same but
    // costs a table. Its lines are numbered from 1, since that is the file.
    const plain = created ? after.split('\n').map((text): Row => ({ kind: 'add', text })) : diffLines(before.split('\n'), after.split('\n'))
    return numberRows(plain, created ? null : (oldStart ?? null), created ? 1 : (newStart ?? null))
  }, [before, after, created, oldStart, newStart])

  const added = rows.filter((r) => r.kind === 'add').length
  const removed = rows.filter((r) => r.kind === 'del').length
  // Without a single true number, the two gutters fold away rather than sit empty.
  const numbered = rows.some((r) => r.old !== null || r.cur !== null)

  return (
    <div className="diff" data-numbered={numbered || undefined} data-bare={bare || undefined}>
      {!bare && (
        <div className="diff__head">
          <span className="diff__file-wrap" title={file}>
            <svg className="diff__icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="diff__file">{file}</span>
          </span>
          <span className="diff__stat">
            <span className="diff__stat-add">+{added}</span>
            <span className="diff__stat-del">-{removed}</span>
          </span>
        </div>
      )}
      <div className="diff__body scroll">
        <div className="diff__lines">
          {rows.map((row, index) => (
            <div key={index} className="diff__row" data-kind={row.kind}>
              <span className="diff__ln diff__ln--old">{row.old ?? ''}</span>
              <span className="diff__ln diff__ln--new">{row.cur ?? ''}</span>
              <span className="diff__sign" aria-hidden>
                {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''}
              </span>
              <Code text={row.text || ' '} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
})
