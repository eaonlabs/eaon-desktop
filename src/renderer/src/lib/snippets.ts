import type { ModSnippet } from '@shared/mods'

/**
 * Mods' editor snippets: a prefix typed at the caret, then Tab, becomes the
 * snippet's body, indented like the line it's on, with the caret where the
 * body has `$0` (else at its end). Kept free of React for the tests.
 */

const CARET = '$0'

/**
 * The edit that expands the snippet whose prefix ends at `caret`: replace
 * `from`–`to` with `text` and put the caret at `caret`. Null when there's no
 * snippet for `lang` there.
 */
export function expandSnippet(value: string, caret: number, lang: string, snippets: ModSnippet[]): { from: number; to: number; text: string; caret: number } | null {
  if (!lang || snippets.length === 0) return null
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1
  const before = value.slice(lineStart, caret)
  const word = /[A-Za-z_][\w-]*$/.exec(before)?.[0]
  if (!word) return null
  const snippet = snippets.find((s) => s.prefix === word && s.languages.includes(lang))
  if (!snippet) return null
  const indent = /^[ \t]*/.exec(before)?.[0] ?? ''
  const body = snippet.body.replace(/\r\n/g, '\n').split('\n').map((line, i) => (i === 0 || !line ? line : indent + line)).join('\n')
  const at = body.indexOf(CARET)
  const text = body.replace(CARET, '')
  const from = caret - word.length
  return { from, to: caret, text, caret: from + (at === -1 ? text.length : at) }
}
