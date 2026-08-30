import { useMemo, type JSX } from 'react'

/**
 * The change an `edit_file` or `write_file` call made, as a unified diff.
 *
 * Computed here rather than in the tool: `edit_file` is given `old_text` and
 * `new_text`, and both travel with the call in the transcript, so the renderer
 * already holds everything a diff needs. The tool's own output stays the one
 * line the model should read ("Edited src/foo.ts (+3 lines)") instead of
 * carrying a rendering of itself.
 *
 * There are no line numbers because there are honestly none to show — the tool
 * matches a snippet by content and never reports where in the file it landed,
 * so any number here would be relative to the fragment and read as a file
 * offset. The +/− marker column carries the same information without lying.
 */

type RowKind = 'add' | 'del' | 'ctx'
interface Row {
  kind: RowKind
  text: string
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

const MARKER: Record<RowKind, string> = { add: '+', del: '−', ctx: ' ' }

export function FileDiff({
  file,
  before,
  after
}: {
  file: string
  before: string
  after: string
}): JSX.Element {
  const rows = useMemo(() => {
    // A brand-new file has no "before" — every line reads as an addition rather
    // than as a diff against an empty string, which would look the same but
    // costs a table.
    if (before.length === 0) return after.split('\n').map((text): Row => ({ kind: 'add', text }))
    return diffLines(before.split('\n'), after.split('\n'))
  }, [before, after])

  const added = rows.filter((r) => r.kind === 'add').length
  const removed = rows.filter((r) => r.kind === 'del').length

  return (
    <div className="diff">
      <div className="diff__head">
        <span className="diff__file">{file}</span>
        <span className="diff__stat">
          {added > 0 && <span className="diff__stat-add">+{added}</span>}
          {removed > 0 && <span className="diff__stat-del">−{removed}</span>}
        </span>
      </div>
      <div className="diff__body scroll">
        {rows.map((row, index) => (
          <div key={index} className="diff__row" data-kind={row.kind}>
            <span className="diff__marker" aria-hidden>
              {MARKER[row.kind]}
            </span>
            <span className="diff__text">{row.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
