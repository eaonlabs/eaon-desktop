import type { UsageDay, UsageModelRow, UsageProjectRow, UsageSourceRow, UsageSummary, UsageToolRow } from '@shared/usage'

/**
 * Settings → Usage as a spreadsheet: the daily bars, and the tool, model,
 * source and project tables, for the range on screen, in one file with a
 * `section` column to filter on (a spreadsheet takes one table). Numbers are
 * plain, with no thousands separators or currency signs; dollars are the same
 * estimates the page shows (Tokn's published API rates), and a plan's use is
 * in `plan_usd`, never in `spend_usd`. A blank is "not known", never zero.
 */

export const CSV_COLUMNS = [
  'section',
  'name',
  'provider',
  'billing',
  'requests',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'total_tokens',
  'spend_usd',
  'plan_usd'
] as const

type Cell = string | number | null | undefined
type Row = Partial<Record<(typeof CSV_COLUMNS)[number], Cell>>

/**
 * One cell. A text that a spreadsheet would run as a formula (a model id
 * named `=HYPERLINK(...)`, from a custom endpoint) gets a quote in front, and
 * anything with a comma, quote or line break is quoted.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Dollars to a millionth, which is finer than any figure the page shows. */
const usd = (n: number): number => Math.round(n * 1e6) / 1e6

function dayRow(day: UsageDay): Row {
  return { section: 'day', name: day.day, requests: day.requests, total_tokens: day.tokens, spend_usd: usd(day.costUsd), plan_usd: usd(day.planUsd ?? 0) }
}

const toolRow = (row: UsageToolRow): Row => ({ section: 'tool', name: row.tool, requests: row.requests, total_tokens: row.tokens, spend_usd: usd(row.costUsd), plan_usd: usd(row.planUsd) })

function modelRow(row: UsageModelRow): Row {
  const write = row.cacheWrite + (row.cacheWrite1h ?? 0)
  return {
    section: 'model',
    name: row.modelId,
    provider: row.providerId,
    billing: row.billing,
    requests: row.requests,
    input_tokens: row.input,
    output_tokens: row.output,
    cache_read_tokens: row.cacheRead,
    cache_write_tokens: write,
    total_tokens: row.input + row.output + row.cacheRead + write,
    // No price (or no token counts) is a blank, not a free model.
    spend_usd: row.costUsd !== null && row.billing !== 'plan' ? usd(row.costUsd) : null,
    plan_usd: row.costUsd !== null && row.billing === 'plan' ? usd(row.costUsd) : null
  }
}

const sourceRow = (row: UsageSourceRow): Row => ({ section: 'source', name: row.source, requests: row.requests, total_tokens: row.tokens, spend_usd: usd(row.costUsd), plan_usd: usd(row.planUsd) })

const PROJECT_NAME: Record<UsageProjectRow['kind'], string> = { folder: '', none: 'No project folder', unattributed: 'Unattributed' }
const projectRow = (row: UsageProjectRow): Row => ({
  section: 'project',
  name: row.kind === 'folder' ? row.path : PROJECT_NAME[row.kind],
  requests: row.requests,
  total_tokens: row.tokens,
  spend_usd: usd(row.costUsd),
  plan_usd: usd(row.planUsd)
})

/** The summary as CSV text: a header, then the rows of each table that has any. Lines end CRLF, and a byte order mark leads so Excel reads UTF-8. */
export function usageCsv(summary: UsageSummary): string {
  const rows: Row[] = [
    ...summary.chart.filter((d) => d.requests > 0 || d.tokens > 0 || d.costUsd > 0 || (d.planUsd ?? 0) > 0).map(dayRow),
    ...summary.tools.map(toolRow),
    ...summary.models.map(modelRow),
    ...summary.sources.map(sourceRow),
    ...summary.projects.map(projectRow)
  ]
  const lines = [CSV_COLUMNS.join(','), ...rows.map((row) => CSV_COLUMNS.map((column) => csvCell(row[column])).join(','))]
  return `﻿${lines.join('\r\n')}\r\n`
}

/** `eaon-usage-2026-10-09-to-2026-11-07.csv`. */
export const usageCsvName = (summary: Pick<UsageSummary, 'span'>): string => `eaon-usage-${summary.span.from}-to-${summary.span.to}.csv`
