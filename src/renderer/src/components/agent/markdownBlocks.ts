/**
 * The block parser behind `Markdown.tsx`, kept free of React so the main
 * process test harness can check it.
 *
 * A streaming reply only ever grows at the end, and everything before its last
 * blank line (outside a code fence) is final: a blank line ends every block
 * this parser knows except a fence, and a list, which models often space out
 * with blank lines between items; a blank line after a list settles it only
 * once the next line plainly isn't more of it. So a re-parse starts from there and keeps
 * the earlier blocks as the same objects — which is what lets `Markdown` skip
 * re-rendering them. Without this, each batch of tokens re-parsed and
 * re-rendered the whole reply, which made a long one quadratic.
 */

export interface ListItem {
  /** The item's first paragraph (its own line plus any lines continuing it). */
  text: string
  /** `- [ ]` / `- [x]` task items; null for an ordinary item. */
  checked: boolean | null
  /** Anything indented under the item after that: nested lists, code, more paragraphs. */
  children: Block[]
}

export type TableAlign = 'left' | 'center' | 'right' | null

export type Block =
  | { kind: 'code'; lang: string; code: string; streaming: boolean }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'table'; align: TableAlign[]; header: string[]; rows: string[][] }
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
/** A list item: its indent, its marker (`-`, `*`, `+`, `1.`, `1)`) and its text. */
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
/** A table's second line: `|---|:---:|---:|`, with or without the outer pipes. */
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const TASK = /^\[([ xX])\]\s+/

/** Leading spaces, with a tab counted as four. */
function indentOf(line: string): number {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n++
    else if (ch === '\t') n += 4
    else break
  }
  return n
}

function item(line: string): { indent: number; ordered: boolean; number: number; text: string } | null {
  const match = ITEM.exec(line.replace(/\t/g, '    '))
  if (!match) return null
  // A rule ("---", "* * *") is not a list of empty items.
  if (RULE.test(line)) return null
  const ordered = /\d/.test(match[2])
  return { indent: match[1].length, ordered, number: ordered ? Number.parseInt(match[2], 10) : 1, text: match[3] ?? '' }
}

/** A table row's cells, without the outer pipes. `\|` stays a literal pipe. */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

/**
 * Whether a line still being written, or the next one, could turn out to
 * continue a list: an indented line, or the start of an item. Until that is
 * ruled out, the list before it is not settled.
 */
function couldContinueList(line: string): boolean {
  return /^\s/.test(line) || /^([-*+]|\d{1,9}([.)]|$))(\s|$)/.test(line) || /^\d{1,9}$/.test(line)
}

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

  /**
   * One list, starting at line `first`: its items, each with the lines
   * indented under it (parsed as blocks of their own, which is how lists
   * nest), and blank lines between items, which models often leave. Returns
   * the index of its last line.
   */
  const list = (first: number): number => {
    const head = item(lines[first])!
    const items: { text: string; body: string[] }[] = [{ text: head.text, body: [] }]
    let i = first
    while (i + 1 < lines.length) {
      const next = lines[i + 1]
      if (next.trim() === '') {
        // A blank line stays in the list only if the list carries on after it.
        let j = i + 1
        while (j < lines.length && lines[j].trim() === '') j++
        if (j >= lines.length) break
        const after = item(lines[j])
        const sameList = after && after.indent <= head.indent + 1 && after.ordered === head.ordered
        if (!sameList && indentOf(lines[j]) <= head.indent + 1) break
        for (let k = i + 1; k < j; k++) items[items.length - 1].body.push('')
        i = j - 1
        continue
      }
      const nextItem = item(next)
      if (nextItem && nextItem.indent <= head.indent + 1) {
        if (nextItem.ordered !== head.ordered) break
        items.push({ text: nextItem.text, body: [] })
        i++
        continue
      }
      // Indented under the item: its continuation, or a nested block.
      if (indentOf(next) > head.indent + 1) {
        items[items.length - 1].body.push(next)
        i++
        continue
      }
      break
    }

    blocks.push({
      kind: 'list',
      ordered: head.ordered,
      start: head.number,
      items: items.map(({ text, body }) => {
        while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
        const depth = Math.min(...body.filter((l) => l.trim() !== '').map(indentOf), Number.POSITIVE_INFINITY)
        const dedented = body.map((l) => l.replace(/\t/g, '    ').slice(Number.isFinite(depth) ? depth : 0))
        const task = TASK.exec(text)
        const own = task ? text.slice(task[0].length) : text
        const inner = parse([own, ...dedented].join('\n')).blocks
        const lead = inner[0]?.kind === 'para' ? inner[0].text : ''
        return {
          text: lead,
          checked: task ? task[1] !== ' ' : null,
          children: inner[0]?.kind === 'para' ? inner.slice(1) : inner
        }
      })
    })
    return i
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
      // Only a finished line counts: the last line may still be growing. And
      // a list can carry on past a blank line, so after one the blank settles
      // things only once the next line is plainly not more of it.
      if (i < lines.length - 1) {
        const last = blocks[blocks.length - 1]
        let j = i + 1
        while (j < lines.length - 1 && lines[j].trim() === '') j++
        if (last?.kind !== 'list' || (lines[j].trim() !== '' && !couldContinueList(lines[j]))) {
          settledChars = starts[i + 1]
          settledBlocks = blocks.length
        }
      }
      continue
    }

    if (RULE.test(line) && !item(line)) {
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

    // A table: a row of cells, then its |---|---| line with as many columns.
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = cells(line)
      const rule = cells(lines[i + 1])
      if (rule.length === header.length && (line.includes('|') || lines[i + 1].includes('|'))) {
        flush()
        const align = rule.map((cell): TableAlign =>
          cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null
        )
        const rows: string[][] = []
        i++
        while (i + 1 < lines.length && lines[i + 1].trim() !== '' && lines[i + 1].includes('|')) {
          const row = cells(lines[i + 1])
          rows.push(header.map((_, c) => row[c] ?? ''))
          i++
        }
        blocks.push({ kind: 'table', align, header, rows })
        continue
      }
    }

    if (item(line)) {
      flush()
      i = list(i)
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
