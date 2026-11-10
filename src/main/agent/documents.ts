import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { docxText, xlsxText, type OfficeText } from './officeText'
import { openZip, ZipError } from './zipRead'

/**
 * PDFs, Word documents and Excel spreadsheets attached to a message, turned
 * into text the model can read.
 *
 * A model can't open these, and as raw bytes they are noise, so an attached
 * one is converted here and the text goes into the message with a note that it
 * was converted (`documentNote`). Conversion runs once per file and is
 * remembered by its size and modification time; `buildHistory` only reads the
 * remembered result, because it runs on every turn and must stay quick and
 * give the same text each time (the prompt cache depends on it).
 *
 * Old Office formats (.doc, .xls), PowerPoint and OpenDocument files are not
 * read: each is a different format that needs its own reader.
 */

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx'

const FORMATS: Record<string, DocumentFormat> = { '.pdf': 'pdf', '.docx': 'docx', '.docm': 'docx', '.xlsx': 'xlsx', '.xlsm': 'xlsx' }

export function documentFormat(path: string): DocumentFormat | null {
  return FORMATS[extname(path).toLowerCase()] ?? null
}

const LABEL: Record<DocumentFormat, string> = { pdf: 'PDF', docx: 'Word document', xlsx: 'Excel spreadsheet' }
/** What conversion drops, as the note says it. */
const LOST: Record<DocumentFormat, string> = {
  pdf: 'page layout, tables as drawn and images are not included',
  docx: 'formatting, images, comments and headers are not included',
  xlsx: 'each cell is shown as the value it last calculated, and formatting, charts and images are not included'
}

export interface DocumentLimits {
  /** A file larger than this is not opened. */
  fileBytes: number
  /** The most characters of text kept; the rest is cut (and the note says so). */
  textChars: number
  /** A PDF is read for at most this many pages, and this long. */
  pdfPages: number
  pdfMs: number
}

export const DOCUMENT_LIMITS: DocumentLimits = { fileBytes: 30 * 1024 * 1024, textChars: 100_000, pdfPages: 400, pdfMs: 20_000 }

export type DocumentResult =
  | { ok: true; format: DocumentFormat; text: string; detail: string; cut: boolean }
  | { ok: false; format: DocumentFormat; reason: string }

const megabytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`

/** A PDF's text, page by page under a character, page and time budget, yielding between pages so the app stays responsive. */
async function pdfText(data: Buffer, limits: DocumentLimits): Promise<OfficeText> {
  // Loaded when first needed: the PDF reader is large and most chats never attach one.
  const { getDocumentProxy } = await import('unpdf')
  const started = Date.now()
  const pdf = await getDocumentProxy(new Uint8Array(data), {
    // No fonts built from the file and no console chatter: only the words are wanted.
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0
  })
  try {
    const total = pdf.numPages
    const pages: string[] = []
    let size = 0
    let cut = false
    let read = 0
    for (let n = 1; n <= total; n++) {
      if (n > limits.pdfPages || Date.now() - started > limits.pdfMs || size > limits.textChars) {
        cut = true
        break
      }
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      page.cleanup()
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      read = n
      if (text) {
        pages.push(`[Page ${n}]\n${text}`)
        size += text.length + 12
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { text: pages.join('\n\n'), detail: read < total ? `${total} pages, the first ${read} read` : total === 1 ? '1 page' : `${total} pages`, cut }
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined)
  }
}

/** The cut at the character limit, at the end of a line when there is one close enough. */
function clip(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false }
  const head = text.slice(0, limit)
  const line = head.lastIndexOf('\n')
  return { text: line > limit * 0.8 ? head.slice(0, line) : head, cut: true }
}

/** Why a file could not be read, in words for the note. */
function reasonFor(error: unknown, format: DocumentFormat): string {
  const name = (error as { name?: string })?.name
  if (name === 'PasswordException') return 'it is password protected'
  if (name === 'InvalidPDFException') return 'it is not a valid PDF'
  if (error instanceof ZipError) {
    if (/encrypted/.test(error.message)) return 'it is password protected'
    if (/too large|too many/.test(error.message)) return 'its contents are too large to read'
    return `it is not a valid ${format === 'docx' ? 'Word' : 'Excel'} file`
  }
  return 'it could not be read'
}

/**
 * Converts one file. Never throws: a file that can't be read comes back as
 * `{ ok: false }` with the reason, which goes into the message in place of text.
 */
export async function extractDocument(path: string, limits: DocumentLimits = DOCUMENT_LIMITS): Promise<DocumentResult> {
  const format = documentFormat(path)
  if (!format) throw new Error(`${path} is not a document format that is read`)
  try {
    const size = statSync(path).size
    if (size > limits.fileBytes) return { ok: false, format, reason: `it is ${megabytes(size)}, and files over ${megabytes(limits.fileBytes)} are not read` }
    const data = await readFile(path)
    let converted: OfficeText | null
    if (format === 'pdf') {
      if (!data.subarray(0, 1024).includes('%PDF')) return { ok: false, format, reason: 'it is not a valid PDF' }
      converted = await pdfText(data, limits)
    } else {
      const zip = openZip(data)
      converted = format === 'docx' ? docxText(zip, limits.textChars) : xlsxText(zip, limits.textChars)
      if (!converted) return { ok: false, format, reason: `it is not a valid ${format === 'docx' ? 'Word' : 'Excel'} file` }
    }
    const clipped = clip(converted.text, limits.textChars)
    if (!clipped.text.trim()) {
      return { ok: false, format, reason: format === 'pdf' ? 'it has no text in it (it may be a scan or made of images)' : 'it has no text in it' }
    }
    return { ok: true, format, text: clipped.text, detail: converted.detail, cut: converted.cut || clipped.cut }
  } catch (error) {
    return { ok: false, format, reason: reasonFor(error, format) }
  }
}

/** A backtick fence longer than any run of backticks in `text`, so the text cannot close it early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * What goes into the message for an attached document: the text, with a note
 * that it was converted and what that loses; or, when it could not be read,
 * a line saying so. Both start the way the other attachment notes do
 * (`Attached file ` / `[Attached: `), which the Claude engine's history check relies on.
 */
export function documentNote(path: string, result: DocumentResult, limits: DocumentLimits = DOCUMENT_LIMITS): string {
  const label = LABEL[result.format]
  if (!result.ok) return `\n\n[Attached: ${path}. This ${label} could not be turned into text: ${result.reason}.]`
  const stops = result.cut ? ` The text stops after about ${limits.textChars.toLocaleString('en-US')} characters, so the rest of the document is missing.` : ''
  const fence = fenceFor(result.text)
  return `\n\nAttached file ${path}, a ${label} (${result.detail}). It was converted to text so you can read it: ${LOST[result.format]}.${stops}\n${fence}\n${result.text}\n${fence}`
}

/* ---------------------------------------------------------------- cache */

interface Remembered {
  size: number
  modified: number
  result: DocumentResult
}

const CACHE_ENTRIES = 24
const remembered = new Map<string, Remembered>()

function stamp(path: string): { size: number; modified: number } | null {
  try {
    const info = statSync(path)
    return info.isFile() ? { size: info.size, modified: info.mtimeMs } : null
  } catch {
    return null
  }
}

/** The converted text of `path` if it was converted and the file has not changed since; else null. */
export function cachedDocument(path: string): DocumentResult | null {
  const now = stamp(path)
  const hit = remembered.get(path)
  if (!now || !hit || hit.size !== now.size || hit.modified !== now.modified) return null
  remembered.delete(path)
  remembered.set(path, hit)
  return hit.result
}

/** Converts the documents among `paths` that are not already converted, one at a time. */
export async function prepareDocuments(paths: Iterable<string>, limits: DocumentLimits = DOCUMENT_LIMITS): Promise<void> {
  for (const path of new Set(paths)) {
    if (!documentFormat(path) || cachedDocument(path)) continue
    const now = stamp(path)
    if (!now) continue
    const result = await extractDocument(path, limits)
    remembered.set(path, { ...now, result })
    while (remembered.size > CACHE_ENTRIES) remembered.delete(remembered.keys().next().value as string)
  }
}

/** Forgets every converted document (tests). */
export function forgetDocuments(): void {
  remembered.clear()
}
