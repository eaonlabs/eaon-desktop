import { charWidth, strWidth, truncate, type Style } from './term'
import { C, S } from './theme'

/**
 * Markdown to styled terminal lines, for the agent's replies.
 *
 * Covers what models actually write: headings, paragraphs with bold,
 * italic, code and links, bullet and numbered lists (nested by indent),
 * block quotes, fenced code, rules and pipe tables. A reply still
 * streaming may end mid-construct (an unclosed fence or `**`); that renders
 * as text until the rest arrives, never as an error.
 */

export interface Segment {
  text: string
  style?: Style
}
export type Line = Segment[]

const CODE_BG = '#161618'
const codeStyle: Style = { fg: '#E4C07A' }
const blockCode: Style = { fg: '#D4D4D4', bg: CODE_BG }

/* ---------------------------------------------------------------- inline */

export function inline(text: string, base: Style = S.text): Segment[] {
  const out: Segment[] = []
  const pattern = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<![\w*])\*(?!\s)([^*]+?)\*(?!\w)|(?<![\w_])_(?!\s)([^_]+?)_(?!\w)|~~([^~]+?)~~|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)>\]]+)/g
  let last = 0
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at), style: base })
    if (m[2] !== undefined) out.push({ text: m[2], style: codeStyle })
    else if (m[3] !== undefined || m[4] !== undefined) out.push(...inline(m[3] ?? m[4], { ...base, bold: true }))
    else if (m[5] !== undefined || m[6] !== undefined) out.push(...inline(m[5] ?? m[6], { ...base, italic: true }))
    else if (m[7] !== undefined) out.push({ text: m[7], style: { ...base, dim: true } })
    else if (m[8] !== undefined) out.push({ text: m[8], style: { fg: C.cyan, underline: true } })
    else if (m[10] !== undefined) out.push({ text: m[10], style: { fg: C.cyan, underline: true } })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), style: base })
  return out
}

/* ------------------------------------------------------------------ wrap */

/**
 * Wraps styled segments to `width`, with `first` before the first line and
 * `rest` before the others (a bullet, then its hanging indent).
 */
export function wrapSegments(segments: Segment[], width: number, first: Segment[] = [], rest: Segment[] = first): Line[] {
  const lines: Line[] = []
  let line: Line = [...first]
  let used = first.reduce((s, x) => s + strWidth(x.text), 0)
  const restWidth = rest.reduce((s, x) => s + strWidth(x.text), 0)
  const newLine = (): void => {
    // Trailing spaces at a break are dropped.
    while (line.length && /^\s+$/.test(line[line.length - 1].text)) line.pop()
    lines.push(line)
    line = [...rest]
    used = restWidth
  }
  for (const seg of segments) {
    for (const token of seg.text.match(/\s+|[^\s]+/g) ?? []) {
      const w = strWidth(token)
      if (/^\s+$/.test(token)) {
        if (used + w <= width && used > restWidth) {
          line.push({ text: token, style: seg.style })
          used += w
        }
        continue
      }
      if (used + w > width && used > restWidth) newLine()
      if (w <= width - used) {
        line.push({ text: token, style: seg.style })
        used += w
        continue
      }
      let chunk = ''
      for (const ch of token) {
        const cw = charWidth(ch)
        if (used + strWidth(chunk) + cw > width) {
          if (chunk) line.push({ text: chunk, style: seg.style })
          chunk = ''
          newLine()
        }
        chunk += ch
      }
      if (chunk) {
        line.push({ text: chunk, style: seg.style })
        used += strWidth(chunk)
      }
    }
  }
  if (line.length > rest.length || lines.length === 0) newLine()
  return lines
}

/* ---------------------------------------------------------------- tables */

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim())
}

function renderTable(rows: string[][], width: number): Line[] {
  const cols = Math.max(...rows.map((r) => r.length))
  const natural = Array.from({ length: cols }, (_, i) => Math.max(3, ...rows.map((r) => strWidth(r[i] ?? ''))))
  const room = width - (cols + 1) - cols * 2
  let widths = natural
  const total = natural.reduce((a, b) => a + b, 0)
  if (total > room) {
    // Shrink the widest columns first, never below 6.
    widths = natural.slice()
    let over = total - room
    while (over > 0) {
      const i = widths.indexOf(Math.max(...widths))
      if (widths[i] <= 6) break
      widths[i]--
      over--
    }
  }
  const border = S.border
  const edge = (l: string, m: string, r: string): Line => [{ text: l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r, style: border }]
  const out: Line[] = [edge('┌', '┬', '┐')]
  rows.forEach((row, ri) => {
    const line: Line = [{ text: '│', style: border }]
    widths.forEach((w, i) => {
      const cell = truncate(row[i] ?? '', w)
      const segs = inline(cell, ri === 0 ? { ...S.text, bold: true } : S.text)
      line.push({ text: ' ' })
      line.push(...segs)
      line.push({ text: ' '.repeat(Math.max(0, w - strWidth(segs.map((s) => s.text).join('')))) + ' ' })
      line.push({ text: '│', style: border })
    })
    out.push(line)
    if (ri === 0) out.push(edge('├', '┼', '┤'))
  })
  out.push(edge('└', '┴', '┘'))
  return out
}

/* ---------------------------------------------------------------- blocks */

export function renderMarkdown(text: string, rawWidth: number): Line[] {
  const width = Math.max(12, rawWidth)
  const out: Line[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length === 0) return
    out.push(...wrapSegments(inline(paragraph.join(' ')), width))
    paragraph = []
  }
  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.replace(/\s+$/, '')

    const fence = /^(\s*)(```+|~~~+)\s*([\w+-]*)/.exec(line)
    if (fence) {
      flush()
      const marker = fence[2]
      const lang = fence[3]
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++])
      i++
      if (lang) out.push([{ text: ` ${lang} `, style: { fg: C.muted, bg: CODE_BG } }])
      for (const codeLine of body.length ? body : ['']) {
        const expanded = codeLine.replace(/\t/g, '  ')
        let rest = expanded
        do {
          const piece = truncate(rest, width - 2, '')
          const pad = Math.max(0, width - 2 - strWidth(piece))
          out.push([{ text: ` ${piece}${' '.repeat(pad)} `, style: blockCode }])
          rest = rest.slice(piece.length)
        } while (rest.length > 0)
      }
      continue
    }

    if (line.trim() === '') {
      flush()
      if (out.length && out[out.length - 1].length) out.push([])
      i++
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = heading[1].length
      const style: Style = level <= 2 ? { fg: C.amber, bold: true } : { ...S.text, bold: true }
      out.push(...wrapSegments(inline(heading[2].replace(/\s*#+$/, ''), style), width))
      i++
      continue
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      out.push([{ text: '─'.repeat(Math.max(0, width)), style: S.faint }])
      i++
      continue
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush()
      const rows: string[][] = [splitRow(line)]
      i += 2
      while (i < lines.length && /^\s*\|.*\|?\s*$/.test(lines[i]) && lines[i].includes('|')) rows.push(splitRow(lines[i++]))
      out.push(...renderTable(rows, width))
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flush()
      const body: string[] = [quote[1]]
      i++
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      const bar = [{ text: '│ ', style: S.faint }]
      out.push(...wrapSegments(inline(body.join(' '), { fg: C.muted, italic: true }), width, bar, bar))
      continue
    }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line)
    if (item) {
      flush()
      const indent = Math.min(8, Math.floor(item[1].replace(/\t/g, '  ').length / 2) * 2)
      const ordered = /\d/.test(item[2])
      const check = item[3] ? (/x/i.test(item[3]) ? '☑ ' : '☐ ') : ''
      const bullet = ordered ? `${item[2]} ` : '• '
      const body = [item[4]]
      i++
      // Lazy continuation lines belong to the item.
      while (i < lines.length && lines[i].trim() !== '' && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) body.push(lines[i++].trim())
      const first = [{ text: ' '.repeat(indent) }, { text: bullet, style: ordered ? S.muted : { fg: C.amber } }, ...(check ? [{ text: check, style: S.muted }] : [])]
      const rest = [{ text: ' '.repeat(indent + strWidth(bullet) + strWidth(check)) }]
      out.push(...wrapSegments(inline(body.join(' ')), width, first, rest))
      continue
    }

    paragraph.push(line.trim())
    i++
  }
  flush()
  while (out.length && out[out.length - 1].length === 0) out.pop()
  return out
}

/** Plain lines with one style, wrapped: for tool output and errors. */
export function plainLines(text: string, width: number, style: Style = S.text, indent = ''): Line[] {
  const prefix = indent ? [{ text: indent }] : []
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((line) => wrapSegments([{ text: line.replace(/\t/g, '  '), style }], width, prefix, prefix))
}
