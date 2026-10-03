/**
 * Which way a Markdown table in a reply is drawn: as a comparison (features
 * down the side, a tick or a dash per option) or as a plain data table.
 * Kept free of React so the test harness can check it.
 */

export type TableKind = 'comparison' | 'data'
export type Mark = 'yes' | 'no'

const YES = /^(✓|✔|✔️|✅|☑|☑️|yes|y|true|included|supported)$/i
const NO = /^(✗|✘|✕|×|❌|no|n|false|—|–|-|not included|unsupported|none)$/i

/** A cell that is only a yes or a no, once Markdown emphasis around it is set aside. */
export function cellMark(text: string): Mark | null {
  const bare = text
    .trim()
    .replace(/^(\*\*|__|\*|_|`)(.*)\1$/, '$2')
    .trim()
  if (!bare) return null
  if (YES.test(bare)) return 'yes'
  if (NO.test(bare)) return 'no'
  return null
}

/**
 * A comparison when the first header cell is empty (the column of row labels
 * a feature matrix leaves blank), or when most cells right of the first column
 * are ticks and dashes. Anything else is data.
 */
export function tableKind(header: string[], rows: string[][]): TableKind {
  if (header.length < 2 || rows.length === 0) return 'data'
  if (header[0].trim() === '') return 'comparison'
  let cells = 0
  let marks = 0
  for (const row of rows) {
    for (const cell of row.slice(1)) {
      if (cell.trim() === '') continue
      cells++
      if (cellMark(cell)) marks++
    }
  }
  return cells > 0 && marks / cells >= 0.6 ? 'comparison' : 'data'
}
