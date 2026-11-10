/**
 * Running one automation, or one task for a worker, over a list: each line of
 * a pasted list, or one column of pasted CSV, becomes one run, one after the
 * other. Every run costs what a run costs, so there is a cap on rows, and a
 * summary of how each went at the end. Parsing and the summary are here so the
 * dialog's preview and the main process agree on what the rows are.
 */

/** The most rows one list may run. Each is a model run; a longer list is run in parts. */
export const MAX_BULK_ROWS = 50
/** A row is data for one run, not a document: more than this is cut. */
export const MAX_BULK_ROW_CHARS = 2000
/** Runs in a row that fail before the rest are left alone: something is wrong that more tries won't fix. */
export const BULK_FAILURES_BEFORE_STOP = 3

export type BulkMode = 'lines' | 'csv'

export interface BulkInput {
  text: string
  mode: BulkMode
  /** CSV only: the first row names the columns. */
  header?: boolean
  /** CSV only: the column to use, by its name (with a header) or its number from 1. */
  column?: string
}

export interface BulkParsed {
  /** The rows that will run, in order, at most MAX_BULK_ROWS. */
  rows: string[]
  /** How many there were before the cap. */
  found: number
  /** Rows left out because they were empty. */
  empty: number
  /** Rows cut to MAX_BULK_ROW_CHARS. */
  cut: number
  /** CSV: the column names (or "Column 1"…) to pick from. */
  columns: string[]
  /** Why nothing can run, when that is so. */
  problem: string | null
}

/** The delimiter a CSV's first line uses: a comma, a tab or a semicolon, whichever it has most of. */
export function csvDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  let best = ','
  let most = 0
  for (const d of [',', '\t', ';']) {
    const n = first.split(d).length - 1
    if (n > most) {
      best = d
      most = n
    }
  }
  return best
}

/** Cells of CSV as spreadsheets write it: quotes protect delimiters and line breaks, and "" is a quote. */
export function parseCsv(text: string, delimiter = csvDelimiter(text)): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const body = text.replace(/^﻿/, '')
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"' && cell === '') quoted = true
    else if (c === delimiter) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      rows.push(row)
      row = []
    } else cell += c
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  // A line break at the very end, or a blank line, isn't a row.
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** The rows a pasted list or CSV column makes, and what was left out. Never throws: a bad paste comes back as `problem`. */
export function parseBulk(input: BulkInput): BulkParsed {
  const none = (problem: string, columns: string[] = []): BulkParsed => ({ rows: [], found: 0, empty: 0, cut: 0, columns, problem })
  if (!input.text.trim()) return none('Paste a list first, one item to a line.')
  let raw: string[]
  let columns: string[] = []
  let empty = 0
  if (input.mode === 'csv') {
    const table = parseCsv(input.text)
    if (table.length === 0) return none('Paste a list first, one item to a line.')
    const header = input.header !== false
    const width = Math.max(...table.map((r) => r.length))
    columns = header ? table[0].map((name, i) => name.trim() || `Column ${i + 1}`) : Array.from({ length: width }, (_, i) => `Column ${i + 1}`)
    const wanted = (input.column ?? '').trim()
    let index = wanted ? columns.findIndex((name) => name.toLowerCase() === wanted.toLowerCase()) : 0
    if (index === -1 && /^\d+$/.test(wanted)) index = Number(wanted) - 1
    if (index < 0 || index >= width) return none(`There is no column “${wanted}”. The columns are ${columns.map((c) => `“${c}”`).join(', ')}.`, columns)
    const body = header ? table.slice(1) : table
    raw = body.map((r) => (r[index] ?? '').trim())
    if (raw.length === 0) return none('The list has a header and nothing under it.', columns)
  } else {
    raw = input.text.split(/\r?\n/).map((l) => l.trim())
  }
  const kept = raw.filter((line) => {
    if (line) return true
    empty++
    return false
  })
  // Blank lines between items are routine; a list of only blanks isn't a list.
  if (kept.length === 0) return none('Every row is empty.', columns)
  const rows = kept.slice(0, MAX_BULK_ROWS).map((line) => clip(line, MAX_BULK_ROW_CHARS))
  return { rows, found: kept.length, empty, cut: kept.slice(0, MAX_BULK_ROWS).filter((l) => l.length > MAX_BULK_ROW_CHARS).length, columns, problem: null }
}

/** What the run over a list is aimed at: an automation (its own prompt is the instruction) or a worker with an instruction typed here. */
export type BulkTarget = { kind: 'automation'; id: string } | { kind: 'worker'; id: string; instruction: string }

export interface BulkStart {
  target: BulkTarget
  input: BulkInput
}

export type BulkRowStatus = 'waiting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'

export interface BulkRow {
  index: number
  input: string
  status: BulkRowStatus
  /** The reply's first line, for a row that worked. */
  summary?: string
  error?: string
  /** An automation's run: the chat it wrote. */
  chatId?: string
  /** A worker's run: the task thread it ran in. */
  threadId?: string
}

export type BulkStatus = 'running' | 'finished' | 'cancelled' | 'stopped'

export interface BulkRun {
  id: string
  /** The automation's name, or the worker's. */
  targetName: string
  kind: BulkTarget['kind']
  workerId?: string
  startedAt: number
  finishedAt: number | null
  status: BulkStatus
  /** Why it stopped before the end, for `stopped`. */
  stopReason?: string
  /** Rows beyond the cap that were left out, so the summary can say so. */
  leftOut: number
  rows: BulkRow[]
}

const count = (run: BulkRun, status: BulkRowStatus): number => run.rows.filter((r) => r.status === status).length

/** "18 of 20 finished, 2 failed." */
export function bulkSummary(run: BulkRun): string {
  const total = run.rows.length
  const done = count(run, 'succeeded')
  const failed = count(run, 'failed')
  const unrun = count(run, 'waiting') + count(run, 'skipped') + count(run, 'cancelled')
  const parts = [`${done} of ${total} finished`]
  if (failed > 0) parts.push(`${failed} failed`)
  if (run.status !== 'running' && unrun > 0) parts.push(`${unrun} not run`)
  if (run.status === 'running') {
    const at = run.rows.findIndex((r) => r.status === 'running')
    if (at !== -1) parts.push(`row ${at + 1} is running`)
  }
  let text = `${parts.join(', ')}.`
  if (run.status === 'stopped' && run.stopReason) text += ` Stopped: ${run.stopReason}`
  if (run.status === 'cancelled') text += ' Stopped by you.'
  if (run.leftOut > 0) text += ` ${run.leftOut} more ${run.leftOut === 1 ? 'row was' : 'rows were'} over the ${MAX_BULK_ROWS}-row limit and weren’t run.`
  return text
}

const cell = (text: string): string => (/[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)

/** The results as CSV: the row, how it went, and its reply or error. */
export function bulkCsv(run: BulkRun): string {
  const lines = ['row,input,status,result']
  for (const r of run.rows) lines.push([r.index + 1, cell(r.input), r.status, cell(r.summary ?? r.error ?? '')].join(','))
  return `${lines.join('\n')}\n`
}

/** One row's task as a worker reads it, or an automation's prompt with the row beside it: the instruction, then the row fenced as data. */
export function bulkRowLabel(index: number, total: number, input: string): string {
  return `Row ${index + 1} of ${total}: ${clip(input.replace(/\s+/g, ' '), 60)}`
}
