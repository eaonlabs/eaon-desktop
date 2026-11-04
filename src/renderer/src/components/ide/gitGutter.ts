import { diffLines, splitLines } from '../chatCode/diff/model'

/**
 * The editor's gutter marks: each line's change since the last commit, the
 * way an editor's git gutter shows it. A run of added lines that replaces
 * removed ones is "changed"; added with nothing removed is "added"; removed
 * with nothing added marks the line after the gap.
 */

export type GutterMark = 'added' | 'changed' | 'deleted'

/** Past this many lines either side, the gutter stays empty rather than slow typing down. */
export const GUTTER_MAX_LINES = 20_000

/** 1-based line numbers of `now` with their mark. Null `base` (a file git doesn't have): no marks. */
export function gutterMarks(base: string | null, now: string): Map<number, GutterMark> {
  const marks = new Map<number, GutterMark>()
  if (base === null || base === now) return marks
  const before = splitLines(base)
  const after = splitLines(now)
  if (before.length > GUTTER_MAX_LINES || after.length > GUTTER_MAX_LINES) return marks
  const rows = diffLines(before, after)
  let removed = 0
  let added: number[] = []
  let lastCur = 0
  const flush = (nextLine: number): void => {
    if (added.length > 0) for (const line of added) marks.set(line, removed > 0 ? 'changed' : 'added')
    else if (removed > 0) marks.set(Math.max(1, Math.min(nextLine, after.length || 1)), 'deleted')
    removed = 0
    added = []
  }
  for (const row of rows) {
    if (row.kind === 'del') removed++
    else if (row.kind === 'add' && row.cur !== null) {
      added.push(row.cur)
      lastCur = row.cur
    } else {
      flush(row.cur ?? lastCur + 1)
      if (row.cur !== null) lastCur = row.cur
    }
  }
  flush(lastCur + 1)
  return marks
}
