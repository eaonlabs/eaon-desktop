/**
 * The block parser behind `Markdown.tsx`, kept free of React so the main
 * process test harness can check it.
 *
 * A streaming reply only ever grows at the end, and everything before its last
 * blank line (outside a code fence) is final: a blank line ends every block
 * this parser knows except a fence. So a re-parse starts from there and keeps
 * the earlier blocks as the same objects — which is what lets `Markdown` skip
 * re-rendering them. Without this, each batch of tokens re-parsed and
 * re-rendered the whole reply, which made a long one quadratic.
 */

export type Block =
  | { kind: 'code'; lang: string; code: string; streaming: boolean }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'rule' }
  | { kind: 'para'; text: string }

export interface ParsedMarkdown {
  source: string
  blocks: Block[]
  /** Length of the prefix whose blocks can no longer change, and how many blocks it holds. */
  settledChars: number
  settledBlocks: number
}

const FENCE = /^\s*```(\S*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/

function parse(source: string): ParsedMarkdown {
  const lines = source.split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let settledChars = 0
  let settledBlocks = 0
  // Offset of each line's first character, for recording where the settled part ends.
  const starts: number[] = new Array(lines.length)
  for (let i = 0, at = 0; i < lines.length; i++) {
    starts[i] = at
    at += lines[i].length + 1
  }

  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'para', text: paragraph.join('\n') })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      let closed = false
      for (i++; i < lines.length; i++) {
        if (FENCE.test(lines[i])) {
          closed = true
          break
        }
        code.push(lines[i])
      }
      // An unclosed fence is the normal state mid-stream, not a malformed
      // reply — render it as code already, so the block does not pop into
      // existence only once the closing fence arrives.
      blocks.push({ kind: 'code', lang: fence[1] ?? '', code: code.join('\n'), streaming: !closed })
      continue
    }

    if (line.trim() === '') {
      flush()
      // Only a finished line counts: the last line may still be growing.
      if (i < lines.length - 1) {
        settledChars = starts[i + 1]
        settledBlocks = blocks.length
      }
      continue
    }

    if (RULE.test(line)) {
      flush()
      blocks.push({ kind: 'rule' })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      flush()
      const quoted = [quote[1]]
      while (i + 1 < lines.length) {
        const next = QUOTE.exec(lines[i + 1])
        if (!next) break
        quoted.push(next[1])
        i++
      }
      blocks.push({ kind: 'quote', lines: quoted })
      continue
    }

    const bullet = BULLET.exec(line)
    const numbered = NUMBERED.exec(line)
    if (bullet || numbered) {
      flush()
      const ordered = Boolean(numbered)
      const items = [(bullet ?? numbered)![1]]
      while (i + 1 < lines.length) {
        const nextItem = ordered ? NUMBERED.exec(lines[i + 1]) : BULLET.exec(lines[i + 1])
        if (!nextItem) break
        items.push(nextItem[1])
        i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    paragraph.push(line)
  }

  flush()
  return { source, blocks, settledChars, settledBlocks }
}

/**
 * Parses `source`, reusing `previous` when `source` extends its settled part —
 * the case for every batch of a streaming reply. Anything else parses whole.
 */
export function parseMarkdown(source: string, previous?: ParsedMarkdown | null): ParsedMarkdown {
  if (
    !previous ||
    previous.settledChars === 0 ||
    source.length < previous.settledChars ||
    !source.startsWith(previous.source.slice(0, previous.settledChars))
  ) {
    return parse(source)
  }
  // Offsets in the tail's result are relative to where the tail starts.
  const tail = parse(source.slice(previous.settledChars))
  return {
    source,
    blocks: previous.blocks.slice(0, previous.settledBlocks).concat(tail.blocks),
    settledChars: previous.settledChars + tail.settledChars,
    settledBlocks: previous.settledBlocks + tail.settledBlocks
  }
}
