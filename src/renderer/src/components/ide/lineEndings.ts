/**
 * A textarea only ever holds `\n`: given `\r\n` it hands back `\n`. A file
 * with Windows line endings came back from the editor changed on every line,
 * saved that way, and — the text it was given never matching what it held —
 * had its value reset under the caret on each render. So the editor is given
 * `\n` text, and the file's own line ending goes back on when it is saved.
 */

export type LineEnding = '\n' | '\r\n'

/** The text with `\n` line endings, and the ending the file mostly uses. */
export function toEditor(text: string): { text: string; eol: LineEnding } {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  if (crlf === 0 && !text.includes('\r')) return { text, eol: '\n' }
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf
  return { text: text.replace(/\r\n?/g, '\n'), eol: crlf > lf ? '\r\n' : '\n' }
}

/** Editor text as it is written to disk. */
export function toDisk(text: string, eol: LineEnding): string {
  return eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text
}
