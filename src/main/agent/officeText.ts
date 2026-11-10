import type { Zip } from './zipRead'

/**
 * The text of Word and Excel files (.docx, .xlsx), for a model that can only
 * read text.
 *
 * Both are zips of XML, and what a reader needs from them is words and cells,
 * not layout: paragraphs, headings and lists from a document, rows of cells
 * from a sheet. The XML is scanned for the few tags that carry that rather
 * than parsed into a tree, which also means no entity expansion, no external
 * references and nothing for a hostile file to exploit; the only entities
 * decoded are the five XML defines and numeric ones. Images, comments,
 * tracked deletions, headers and footers are left out.
 */

/** The most one XML part is read at: a real document's text is a small fraction of this, and a sheet of a few hundred thousand cells fits. */
const PART_MAX_BYTES = 48 * 1024 * 1024

export interface OfficeText {
  text: string
  /** What there was, for the note beside it ("3 sheets"). */
  detail: string
  /** True when `limit` stopped it. */
  cut: boolean
}

const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXml(text: string): string {
  return text.replace(ENTITY, (_, name: string) => {
    if (name[0] !== '#') return NAMED[name] ?? ''
    const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ''
  })
}

/** Lines up to a character budget; `cut` is set once something did not fit. */
class Lines {
  readonly out: string[] = []
  size = 0
  cut = false
  constructor(private readonly limit: number) {}
  /** False once the budget is spent: stop reading. */
  add(line: string): boolean {
    if (this.cut) return false
    if (this.size + line.length + 1 > this.limit) {
      const room = this.limit - this.size - 1
      if (room > 200) this.out.push(line.slice(0, room))
      this.cut = true
      return false
    }
    this.out.push(line)
    this.size += line.length + 1
    return true
  }
}

const part = (zip: Zip, name: string): string | null => zip.read(name, PART_MAX_BYTES)?.toString('utf8') ?? null

/** One attribute's value from a tag's attribute text. */
function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1]
}

/* ---------------------------------------------------------------- Word */

const WORD_TOKENS = /<(\/?)w:(p|t|tab|br|cr|tc|tr|pStyle|numPr|instrText|delText)\b([^>]*?)(\/?)>|([^<]+)/g

/**
 * The words of a .docx: one line per paragraph, `#` marks on headings, `-` on
 * list items, and a table row on one line with its cells between `|`.
 */
export function docxText(zip: Zip, limit: number): OfficeText | null {
  const xml = part(zip, 'word/document.xml')
  if (xml === null) return null
  // A text box is in the file twice (a modern copy and a fallback one).
  const body = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '')
  const lines = new Lines(limit)
  let paragraph = ''
  let heading = 0
  let listed = false
  let capture = false
  let row: string[] | null = null
  let cell: string[] | null = null
  let paragraphs = 0

  const finish = (): boolean => {
    const text = paragraph.replace(/[ \t]+$/g, '')
    const marked = text ? `${'#'.repeat(heading)}${heading ? ' ' : ''}${listed && !heading ? '- ' : ''}${text}` : ''
    paragraph = ''
    heading = 0
    listed = false
    if (marked) paragraphs++
    if (cell) {
      if (text) cell.push(text)
      return true
    }
    // Blank paragraphs count once, as the gap they are.
    if (!marked && (lines.out.length === 0 || lines.out[lines.out.length - 1] === '')) return true
    return lines.add(marked)
  }

  for (const match of body.matchAll(WORD_TOKENS)) {
    if (match[5] !== undefined) {
      if (capture) paragraph += decodeXml(match[5])
      continue
    }
    const closing = match[1] === '/'
    const selfClosed = match[4] === '/'
    switch (match[2]) {
      case 't':
        capture = !closing && !selfClosed
        break
      case 'p':
        if (closing || selfClosed) {
          if (!finish()) return result(lines, paragraphs)
        } else if (paragraph) {
          // A paragraph inside a text box starts before the outer one ends.
          if (!finish()) return result(lines, paragraphs)
        }
        break
      case 'tab':
        paragraph += '\t'
        break
      case 'br':
      case 'cr':
        paragraph += ' '
        break
      case 'pStyle': {
        const style = attribute(match[3], 'w:val') ?? ''
        const level = /^Heading\s?(\d)$/i.exec(style)
        heading = level ? Math.min(Number(level[1]), 6) : /^Title$/i.test(style) ? 1 : 0
        break
      }
      case 'numPr':
        listed = !closing
        break
      case 'tr':
        if (!closing) row = []
        else {
          const cells = row ?? []
          row = null
          if (cells.some((c) => c) && !lines.add(`| ${cells.join(' | ')} |`)) return result(lines, paragraphs)
        }
        break
      case 'tc':
        if (!closing) cell = []
        else {
          row?.push((cell ?? []).join(' ').trim())
          cell = null
        }
        break
      default:
        // Field codes and deleted text are not the document's words: their text is not captured.
        break
    }
  }
  finish()
  return result(lines, paragraphs)
}

function result(lines: Lines, paragraphs: number): OfficeText {
  const text = lines.out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, detail: paragraphs === 1 ? '1 paragraph' : `${paragraphs} paragraphs`, cut: lines.cut }
}

/* --------------------------------------------------------------- Excel */

/** Number formats Excel builds in that show a date or a time. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])

/** Whether a custom format code shows a date or time: a y, m, d, h or s outside quotes, escapes and [colour] brackets. */
export function isDateFormat(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '')
  return /[ymdhs]/i.test(bare) && !/^general$/i.test(bare.trim())
}

/** A date serial as text: 2026-11-07, 2026-11-07 14:30, or 14:30 for a time alone. */
export function excelDate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2_958_466) return null
  // Day 1 is 1900-01-01, and Excel counts a 29 February 1900 that never was: from serial 61 on the epoch is 1899-12-30.
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const days = date1904 || serial >= 60 ? serial : serial + 1
  const iso = new Date(epoch + Math.round(days * 86_400_000)).toISOString()
  if (!date1904 && serial < 1) return iso.slice(11, 16)
  return Math.abs(serial % 1) > 1e-9 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10)
}

/** Column letters as a zero-based index: A is 0, AB is 27. */
export function columnIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** A relationship file's targets by id, as paths from the package root. */
function relationships(zip: Zip, path: string, base: string): Map<string, string> {
  const targets = new Map<string, string>()
  const xml = part(zip, path)
  if (xml === null) return targets
  for (const tag of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attribute(tag[1], 'Id')
    const target = attribute(tag[1], 'Target')
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `${base}${target}`)
  }
  return targets
}

/** Shared strings, in order: the text cells point at. Rich-text runs are joined; phonetic hints dropped. */
function sharedStrings(zip: Zip): string[] {
  const xml = part(zip, 'xl/sharedStrings.xml')
  if (xml === null) return []
  const strings: string[] = []
  for (const item of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    const inner = (item[1] ?? '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
    strings.push([...inner.matchAll(/<t\b[^>]*?>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join(''))
  }
  return strings
}

/** Which cell styles show dates, by style index. */
function dateStyles(zip: Zip): Set<number> {
  const xml = part(zip, 'xl/styles.xml')
  const dates = new Set<number>()
  if (xml === null) return dates
  const custom = new Map<number, string>()
  for (const fmt of xml.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
    const id = Number(attribute(fmt[1], 'numFmtId'))
    const code = attribute(fmt[1], 'formatCode')
    if (Number.isFinite(id) && code !== undefined) custom.set(id, decodeXml(code))
  }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
  let index = 0
  for (const xf of block.matchAll(/<xf\b([^>]*?)\/?>/g)) {
    const id = Number(attribute(xf[1], 'numFmtId'))
    const code = custom.get(id)
    if (BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && isDateFormat(code))) dates.add(index)
    index++
  }
  return dates
}

/** A number as Excel shows it to 15 digits, without the floating-point tail (0.1 + 0.2 is 0.3, not 0.30000000000000004). */
const plainNumber = (raw: string): string => {
  const n = Number(raw)
  return raw.trim() === '' || !Number.isFinite(n) ? raw : String(Number.parseFloat(n.toPrecision(15)))
}

/** The widest sheet read: a column past this is a stray cell, not a table. */
const MAX_COLUMNS = 512

/**
 * The cells of a .xlsx: for each sheet its name, then each non-empty row on
 * one line with the cells between `|`. Formula cells show the value Excel last
 * worked out; dates are shown as dates.
 */
export function xlsxText(zip: Zip, limit: number): OfficeText | null {
  const workbook = part(zip, 'xl/workbook.xml')
  if (workbook === null) return null
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(workbook)
  const targets = relationships(zip, 'xl/_rels/workbook.xml.rels', 'xl/')
  const strings = sharedStrings(zip)
  const dates = dateStyles(zip)
  const lines = new Lines(limit)
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)]

  let shown = 0
  for (const sheet of sheets) {
    const name = decodeXml(attribute(sheet[1], 'name') ?? `Sheet ${shown + 1}`)
    const target = targets.get(attribute(sheet[1], 'r:id') ?? '')
    const xml = target ? part(zip, target) : null
    if (xml === null) continue
    const hidden = (attribute(sheet[1], 'state') ?? 'visible') !== 'visible'
    shown++
    if (!lines.add(`${shown > 1 ? '\n' : ''}## Sheet: ${name}${hidden ? ' (hidden)' : ''}`)) break

    for (const rowTag of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: string[] = []
      let next = 0
      for (const cellTag of (rowTag[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cellTag[1]
        const ref = /^([A-Za-z]{1,3})\d*$/.exec(attribute(attrs, 'r') ?? '')
        const column = ref ? columnIndex(ref[1]) : next
        next = column + 1
        if (column >= MAX_COLUMNS || !cellTag[2]) continue
        const type = attribute(attrs, 't') ?? 'n'
        const value = /<v\b[^>]*?>([\s\S]*?)<\/v>/.exec(cellTag[2])?.[1]
        let text = ''
        if (type === 'inlineStr') text = [...cellTag[2].matchAll(/<t\b[^>]*?>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join('')
        else if (value === undefined) text = ''
        else if (type === 's') text = strings[Number(value)] ?? ''
        else if (type === 'b') text = value.trim() === '1' ? 'TRUE' : 'FALSE'
        else if (type === 'str' || type === 'e' || type === 'd') text = decodeXml(value)
        else {
          const styled = dates.has(Number(attribute(attrs, 's') ?? 0))
          text = (styled && excelDate(Number(value), date1904)) || plainNumber(decodeXml(value))
        }
        cells[column] = text.replace(/\s*\n\s*/g, ' ').trim()
      }
      let width = cells.length
      while (width > 0 && !cells[width - 1]) width--
      if (width === 0) continue
      const row = Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')
      if (!lines.add(row)) break
    }
    if (lines.cut) break
  }
  if (shown === 0) return null
  return { text: lines.out.join('\n').trim(), detail: shown === 1 ? '1 sheet' : `${shown} sheets`, cut: lines.cut }
}
