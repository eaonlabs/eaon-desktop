import { highlight, type Token } from '../../agent/highlight'
import type { Span } from './model'

/** A file's language for colouring, from its extension or its name (`Makefile`, `Dockerfile`). */
export function languageOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const lower = name.toLowerCase()
  if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile'
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile'
  if (lower.startsWith('.env')) return 'env'
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Lines coloured as one text, so a comment or string that spans lines is
 * coloured on each of them, then cut back into lines.
 */
export function lineTokens(lines: string[], lang: string): Token[][] {
  const out: Token[][] = lines.map(() => [])
  if (lines.length === 0) return out
  let line = 0
  for (const token of highlight(lines.join('\n'), lang)) {
    const parts = token.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) line++
      if (part && line < out.length) out[line].push({ text: part, kind: token.kind })
    })
  }
  return out
}

export interface Piece {
  text: string
  kind: Token['kind']
  /** Inside a changed word. */
  em: boolean
}

/** A line's tokens cut at its changed words' edges, so each piece is one colour and marked or not. */
export function pieces(tokens: Token[], marks: Span[] | undefined): Piece[] {
  if (!marks || marks.length === 0) return tokens.map((t) => ({ text: t.text, kind: t.kind, em: false }))
  const out: Piece[] = []
  let at = 0
  let m = 0
  for (const token of tokens) {
    let start = 0
    const end = token.text.length
    while (start < end) {
      while (m < marks.length && marks[m].to <= at + start) m++
      const mark = marks[m]
      const inside = mark !== undefined && mark.from <= at + start
      const stop = mark === undefined ? end : inside ? Math.min(end, mark.to - at) : Math.min(end, mark.from - at)
      out.push({ text: token.text.slice(start, stop), kind: token.kind, em: inside })
      start = stop
    }
    at += end
  }
  return out
}
