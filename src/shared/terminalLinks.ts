import { parseFileRef } from './fileRef'
import { spanSegments, type SearchRow } from './terminalSearch'

/**
 * Finding file paths in a line of a terminal's output, so they can be clicked:
 * `src/app.ts:42:7`, `./lib/x.py`, `at run (src/a.ts:10:5)`, `src/a.ts(42,5)`,
 * `/Users/me/app/src/a.ts:42`. The words that are only dotted names
 * (`console.log`, `1.2.3`) are not paths: shared/fileRef.ts decides, the same
 * way it does for the paths in a chat reply.
 */

export interface PathRef {
  /** Where it starts and ends in the line's text. */
  start: number
  end: number
  /** The text as printed, with its line number. */
  text: string
  /** The path alone. */
  path: string
  line: number | null
  col: number | null
}

/**
 * A path and what can follow it: `:42`, `:42:7`, or TypeScript's `(42,5)`.
 * Not after a character a path can hold, so a path is never read from the
 * middle of a longer word; a drive (`C:\x\y.ts`) is part of the path.
 */
const PATH =
  /(?<![\w@+.\\/~-])(?<path>(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?[\w@+.-]+(?:[\\/][\w@+.-]+)*)(?:(?::(?<line>\d+)(?::(?<col>\d+))?)|\((?<tsLine>\d+)(?:,\s*(?<tsCol>\d+))?\))?/g

/** A URL, whose path is the address's, not a file: blanked before looking. */
const URL_LIKE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g

/** Every path in `text`, left to right. */
export function findPathRefs(text: string): PathRef[] {
  const masked = text.replace(URL_LIKE, (url) => ' '.repeat(url.length))
  const out: PathRef[] = []
  for (const m of masked.matchAll(PATH)) {
    const groups = m.groups
    if (!groups) continue
    // "see src/app.ts." ends a sentence, not the name.
    const path = groups.path.replace(/[.-]+$/, '')
    // parseFileRef has no drive letter in its alphabet: read the rest.
    if (!path || !parseFileRef(path.replace(/^[A-Za-z]:(?=[\\/])/, ''))) continue
    const dropped = groups.path.length - path.length
    const hasLine = dropped === 0 && (groups.line !== undefined || groups.tsLine !== undefined)
    const start = m.index ?? 0
    const end = start + path.length + (hasLine ? m[0].length - groups.path.length : 0)
    const line = hasLine ? Number(groups.line ?? groups.tsLine) : null
    const col = hasLine ? ((groups.col ?? groups.tsCol) !== undefined ? Number(groups.col ?? groups.tsCol) : null) : null
    out.push({ start, end, text: text.slice(start, end), path, line: line && line > 0 ? line : null, col })
  }
  return out
}

/** A path in the rows of one line, with where it is on screen (cells counted from 1, `y` 1 for the first row given). */
export interface PathLink {
  ref: PathRef
  start: { x: number; y: number }
  end: { x: number; y: number }
}

/**
 * The paths in a line of the terminal, which is `rows` (a row and the rows
 * wrapped onto it), with their places: a path the terminal broke across two
 * rows is one link from its first cell to its last.
 */
export function pathLinksIn(rows: SearchRow[]): PathLink[] {
  const offsets: number[] = []
  let text = ''
  for (const row of rows) {
    offsets.push(text.length)
    text += row.text
  }
  const links: PathLink[] = []
  for (const ref of findPathRefs(text)) {
    const segments = spanSegments(rows, 0, rows.length, offsets, ref.start, ref.end)
    if (segments.length === 0) continue
    const head = segments[0]
    const tail = segments[segments.length - 1]
    links.push({ ref, start: { x: head.col + 1, y: head.row + 1 }, end: { x: tail.col + tail.width, y: tail.row + 1 } })
  }
  return links
}
