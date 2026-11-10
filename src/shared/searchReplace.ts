import type { SearchOptions } from './chatCode'

/**
 * Replace across the project (Find in project's Replace field): the one set
 * of rules the preview and the replacement both use, so what the person sees
 * as "after" is what is written. A match is a line the search found; the
 * pattern is the search's own, in JavaScript's regular expressions.
 */

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The search as a pattern for one line of text; an error saying why when it can't be one, or would match nothing in particular. */
export function searchPattern(query: string, options: SearchOptions): { pattern: RegExp } | { error: string } {
  if (!query) return { error: 'Type something to find first.' }
  let pattern: RegExp
  try {
    const source = options.regex ? query : escapeRegex(query)
    pattern = new RegExp(options.word ? `\\b(?:${source})\\b` : source, options.caseSensitive ? 'g' : 'gi')
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That isn’t a pattern.' }
  }
  // A pattern that matches nothing at all would put the replacement between every character.
  if (new RegExp(pattern.source, pattern.flags.replace('g', '')).test('')) return { error: 'That pattern matches the empty string, so a replacement would land everywhere. Make it match something.' }
  return { pattern }
}

/**
 * What the replacement becomes for one match: `$1`, `$&`, `$<name>` and
 * `$$` as JavaScript reads them, when the search is a regular expression.
 */
function expand(template: string, m: RegExpMatchArray): string {
  const captures = m.slice(1)
  const index = m.index ?? 0
  const input = m.input ?? ''
  return template.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g, (all, token: string) => {
    if (token === '$') return '$'
    if (token === '&') return m[0]
    if (token === '`') return input.slice(0, index)
    if (token === "'") return input.slice(index + m[0].length)
    if (token[0] === '<') return m.groups ? (m.groups[token.slice(1, -1)] ?? '') : all
    let n = Number(token)
    let tail = ''
    // `$12` is the twelfth group only if there is one; otherwise the first, then a "2".
    if (token.length === 2 && n > captures.length) {
      n = Number(token[0])
      tail = token[1]
    }
    return n >= 1 && n <= captures.length ? (captures[n - 1] ?? '') + tail : all
  })
}

export interface LineReplacement {
  /** The line after, whole. */
  text: string
  /** Matches replaced in it. */
  count: number
  /** The line after in pieces, the replacements marked, for showing what changes. */
  parts: { text: string; hit: boolean }[]
}

/** One line with every match of `pattern` replaced. A plain-text search takes the replacement as typed; a regular expression expands `$1` and the like. */
export function replaceLine(line: string, pattern: RegExp, replacement: string, regex: boolean): LineReplacement {
  const parts: { text: string; hit: boolean }[] = []
  let at = 0
  let count = 0
  for (const m of line.matchAll(pattern)) {
    const from = m.index ?? 0
    if (from > at) parts.push({ text: line.slice(at, from), hit: false })
    parts.push({ text: regex ? expand(replacement, m) : replacement, hit: true })
    at = from + m[0].length
    count++
  }
  if (at < line.length) parts.push({ text: line.slice(at), hit: false })
  return { text: parts.map((p) => p.text).join(''), count, parts }
}

export interface TextReplacement {
  text: string
  /** Matches replaced, over every line chosen. */
  replaced: number
  /** The lines (1-based) that changed. */
  lines: number[]
  /** Chosen lines that no longer match: the file changed since the search. */
  stale: number[]
}

/**
 * A file's text with the chosen lines replaced (every line when none are
 * chosen). Line endings stay as they are. A chosen line that doesn't match
 * any more is left alone and reported, so a file edited since the search is
 * never written from an old answer.
 */
export function replaceInText(text: string, pattern: RegExp, replacement: string, regex: boolean, only?: ReadonlySet<number>): TextReplacement {
  const lines = text.split('\n')
  const changed: number[] = []
  const stale: number[] = []
  let replaced = 0
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1
    if (only && !only.has(n)) continue
    const cr = lines[i].endsWith('\r')
    const body = cr ? lines[i].slice(0, -1) : lines[i]
    const result = replaceLine(body, pattern, replacement, regex)
    if (result.count === 0) {
      if (only) stale.push(n)
      continue
    }
    lines[i] = result.text + (cr ? '\r' : '')
    replaced += result.count
    changed.push(n)
  }
  return { text: lines.join('\n'), replaced, lines: changed, stale }
}

/* ------------------------------------------------------------------ the request and its answer */

export interface ReplaceTarget {
  /** Relative to the folder searched, as the search listed it. */
  path: string
  /** The lines chosen; every matching line of the file when left out. */
  lines?: number[]
}

export interface ReplaceRequest {
  query: string
  options: SearchOptions
  replacement: string
  targets: ReplaceTarget[]
}

export interface ReplacedFile {
  path: string
  replaced: number
  lines: number[]
}

export type ReplaceResult =
  | {
      ok: true
      files: ReplacedFile[]
      /** Files left alone, and why: ignored by git, not text, too large, changed since the search. */
      skipped: { path: string; reason: string }[]
      /** Whether the last replacement here can be put back. */
      undoable: boolean
    }
  | { ok: false; error: string }

export type UndoReplaceResult = { ok: true; restored: string[]; conflicts: string[] } | { ok: false; error: string }

/** The sentence for what a replacement did. */
export function replacedSummary(files: ReplacedFile[]): string {
  const matches = files.reduce((n, f) => n + f.replaced, 0)
  if (files.length === 0) return 'Nothing was replaced.'
  return `Replaced ${matches} ${matches === 1 ? 'match' : 'matches'} in ${files.length} ${files.length === 1 ? 'file' : 'files'}.`
}
