/**
 * The user's own message, read for what it holds besides words: fenced code
 * (a paste, or a selection the editor added with ⌘L or ⌘K) and `inline
 * code`. A fence right under a line that is only a `path:line` reference
 * takes that line as its heading. Everything else stays exactly as typed.
 */

export type UserSegment = { kind: 'text'; text: string } | { kind: 'code'; text: string; lang: string; ref: string | null }

const FENCE = /^(`{3,})([^`\s]*)\s*$/
const REF = /^`([^`\n]+:\d+(?:-\d+)?)`$/

export function userSegments(text: string): UserSegment[] {
  const lines = text.split('\n')
  const out: UserSegment[] = []
  let buffer: string[] = []
  const flushText = (): void => {
    // The line break around a block is the block's own, not a blank line of text.
    const joined = buffer.join('\n').replace(/^\n/, '').replace(/\n$/, '')
    if (joined) out.push({ kind: 'text', text: joined })
    buffer = []
  }
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i])
    if (!open) {
      buffer.push(lines[i])
      continue
    }
    const close = lines.findIndex((line, j) => j > i && new RegExp(`^${open[1]}\`*\\s*$`).test(line))
    // A fence never closed is just text.
    if (close === -1) {
      buffer.push(lines[i])
      continue
    }
    const previous = buffer.at(-1)
    const ref = previous !== undefined ? (REF.exec(previous.trim())?.[1] ?? null) : null
    if (ref) buffer.pop()
    flushText()
    out.push({ kind: 'code', text: lines.slice(i + 1, close).join('\n'), lang: open[2], ref })
    i = close
  }
  flushText()
  return out
}

/** Text with `inline code` split out: odd pieces are code. */
export function inlineCode(text: string): string[] {
  return text.split(/`([^`\n]+)`/)
}
