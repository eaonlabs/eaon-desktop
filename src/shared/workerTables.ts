/**
 * Tables a worker keeps for itself: leads, orders, results over time. A table
 * is named columns and rows of text, saved per worker, which the worker reads
 * and writes with `table_read`, `table_write` and `table_delete_rows` and the
 * user looks at from the worker's menu. All the rules are here, as pure
 * functions over the list, so they are the same for the tools, the page and
 * the tests.
 */

export interface WorkerTable {
  name: string
  columns: string[]
  rows: Record<string, string>[]
  updatedAt: number
}

export const MAX_TABLES = 20
export const MAX_COLUMNS = 30
export const MAX_ROWS = 5000
export const MAX_CELL = 2000
export const MAX_NAME = 60

const clean = (value: unknown, max: number): string => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '').slice(0, max)

/** A table or column name as typed: single spaces, trimmed, bounded. */
export const tidyName = (value: unknown): string => clean(value, MAX_NAME).replace(/\s+/g, ' ').trim()

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Saved tables as read back: well-formed ones only, within the limits. */
export function normalizeTables(raw: unknown): WorkerTable[] {
  if (!Array.isArray(raw)) return []
  const out: WorkerTable[] = []
  for (const item of raw) {
    if (out.length >= MAX_TABLES) break
    if (!item || typeof item !== 'object') continue
    const t = item as Partial<WorkerTable>
    const name = tidyName(t.name)
    if (!name || out.some((o) => sameName(o.name, name))) continue
    const columns: string[] = []
    for (const column of Array.isArray(t.columns) ? t.columns : []) {
      const c = tidyName(column)
      if (c && !columns.some((x) => sameName(x, c)) && columns.length < MAX_COLUMNS) columns.push(c)
    }
    const rows = ((Array.isArray(t.rows) ? t.rows : []) as unknown[])
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r))
      .slice(0, MAX_ROWS)
      .map((r) => Object.fromEntries(columns.map((c) => [c, clean(r[c], MAX_CELL)])))
    out.push({ name, columns, rows, updatedAt: typeof t.updatedAt === 'number' && Number.isFinite(t.updatedAt) ? t.updatedAt : 0 })
  }
  return out
}

export const findTable = (tables: readonly WorkerTable[], name: string): WorkerTable | undefined => tables.find((t) => sameName(t.name, tidyName(name)))

/** The column a typed name means, whatever its case. */
const columnOf = (table: WorkerTable, name: string): string | undefined => table.columns.find((c) => sameName(c, tidyName(name)))

export interface WriteResult {
  tables: WorkerTable[]
  added: number
  updated: number
  /** Columns the write added to the table. */
  newColumns: string[]
}

/**
 * Adds rows to a table, making it if there is none. With `key` (a column
 * name), a row whose key matches an existing row's updates that row instead of
 * adding another. A column a row names that the table lacks is added.
 * Throws a message for the worker when a limit is hit or the key is unknown.
 */
export function writeRows(tables: readonly WorkerTable[], name: string, rows: readonly Record<string, unknown>[], options: { key?: string; now: number }): WriteResult {
  const tableName = tidyName(name)
  if (!tableName) throw new Error('Name the table.')
  if (rows.length === 0) throw new Error('Give at least one row.')
  const list = tables.map((t) => ({ ...t, columns: [...t.columns], rows: t.rows.map((r) => ({ ...r })) }))
  let table = list.find((t) => sameName(t.name, tableName))
  if (!table) {
    if (list.length >= MAX_TABLES) throw new Error(`There can be up to ${MAX_TABLES} tables. Remove one first.`)
    table = { name: tableName, columns: [], rows: [], updatedAt: options.now }
    list.push(table)
  }
  const target = table
  const newColumns: string[] = []
  const column = (raw: string): string => {
    const found = target.columns.find((c) => sameName(c, tidyName(raw)))
    if (found) return found
    const c = tidyName(raw)
    if (!c) throw new Error('A column needs a name.')
    if (target.columns.length >= MAX_COLUMNS) throw new Error(`A table can have up to ${MAX_COLUMNS} columns.`)
    target.columns.push(c)
    newColumns.push(c)
    for (const row of target.rows) row[c] = ''
    return c
  }
  // Columns first, so `key` may name one a row brings.
  for (const row of rows) for (const name of Object.keys(row)) column(name)
  const keyColumn = options.key ? columnOf(target, options.key) : undefined
  if (options.key && !keyColumn) throw new Error(`The table has no column called ${options.key}.`)
  let added = 0
  let updated = 0
  for (const row of rows) {
    const values = Object.fromEntries(Object.entries(row).map(([k, v]) => [columnOf(target, k)!, clean(v, MAX_CELL)]))
    const match = keyColumn && values[keyColumn] ? target.rows.find((r) => r[keyColumn] === values[keyColumn]) : undefined
    if (match) {
      Object.assign(match, values)
      updated++
      continue
    }
    if (target.rows.length >= MAX_ROWS) throw new Error(`A table can have up to ${MAX_ROWS} rows.`)
    target.rows.push(Object.fromEntries(target.columns.map((c) => [c, values[c] ?? ''])))
    added++
  }
  target.updatedAt = options.now
  return { tables: list, added, updated, newColumns }
}

/** The rows whose columns hold exactly the given values (case ignored); every row when `where` is empty. */
export function matchRows(table: WorkerTable, where: Record<string, unknown> | undefined): Record<string, string>[] {
  const entries = Object.entries(where ?? {})
  if (entries.length === 0) return table.rows
  const wanted = entries.map(([k, v]) => [columnOf(table, k), clean(v, MAX_CELL).trim().toLowerCase()] as const)
  if (wanted.some(([c]) => !c)) throw new Error(`The table has no column called ${entries[wanted.findIndex(([c]) => !c)][0]}. Its columns: ${table.columns.join(', ') || 'none yet'}.`)
  return table.rows.filter((r) => wanted.every(([c, v]) => (r[c!] ?? '').trim().toLowerCase() === v))
}

/** Removes the rows `where` matches; with no condition nothing is removed (a table is emptied by removing it). */
export function deleteRows(tables: readonly WorkerTable[], name: string, where: Record<string, unknown>, now: number): { tables: WorkerTable[]; removed: number } {
  const table = findTable(tables, name)
  if (!table) throw new Error(`There is no table called ${tidyName(name)}.`)
  if (Object.keys(where).length === 0) throw new Error('Say which rows to remove, with where.')
  const gone = new Set(matchRows(table, where))
  const kept = table.rows.filter((r) => !gone.has(r))
  return { tables: tables.map((t) => (t === table ? { ...t, rows: kept, updatedAt: now } : t)), removed: table.rows.length - kept.length }
}

/** A table as text for the worker: the header, then one line a row. */
export function tableText(table: WorkerTable, rows: readonly Record<string, string>[], total: number): string {
  const line = (cells: string[]): string => `| ${cells.map((c) => c.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')).join(' | ')} |`
  const body = rows.map((r) => line(table.columns.map((c) => r[c] ?? '')))
  const more = total > rows.length ? `\n(${rows.length} of ${total} rows shown)` : ''
  return [`${table.name}: ${total} ${total === 1 ? 'row' : 'rows'}`, line(table.columns), line(table.columns.map(() => '---')), ...body].join('\n') + more
}

/** The tables as a CSV, for the page to copy. */
export function tableCsv(table: WorkerTable): string {
  const cell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return [table.columns, ...table.rows.map((r) => table.columns.map((c) => r[c] ?? ''))].map((cells) => cells.map(cell).join(',')).join('\n')
}
