// Adapted from AICSS (MIT, Copyright (c) 2026 AICSS); see components/aicss/LICENSE.
import type { CSSProperties, JSX, ReactNode } from 'react'
import type { TableAlign } from './markdownBlocks'
import { cellMark, tableKind } from './tableKind'

/**
 * Markdown tables in a reply. A muted header band sits on the card, and the
 * rows sit on an inset sheet with hairlines between cells. A table of ticks
 * and dashes (or one whose first header cell is blank) is drawn as a
 * comparison: its yes cells become a green tick and its no cells a dash.
 *
 * Cells keep their inline Markdown, so `**bold**` and links still render,
 * and their column alignment. A wide table scrolls sideways in its own box
 * rather than widening the thread.
 */

interface TableProps {
  header: string[]
  rows: string[][]
  align: TableAlign[]
  /** Renders a cell's inline Markdown; passed in so this file doesn't import the renderer back. */
  renderCell: (text: string, key: string) => ReactNode
  id: string
}

const JUSTIFY: Record<NonNullable<TableAlign>, CSSProperties['justifyContent']> = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end'
}

function cellStyle(align: TableAlign): CSSProperties | undefined {
  return align ? { justifyContent: JUSTIFY[align], textAlign: align } : undefined
}

/** One table, drawn as a comparison or as data depending on what it holds. */
export function MarkdownTable(props: TableProps): JSX.Element {
  const comparison = tableKind(props.header, props.rows) === 'comparison'
  return (
    <div className="md__table-wrap">
      <div
        className="tbl"
        data-kind={comparison ? 'comparison' : 'data'}
        role="table"
        // Many columns scroll instead of squeezing each to a sliver.
        style={{ minWidth: props.header.length * 100 }}
      >
        <div className="tbl__head" role="row">
          {props.header.map((cell, c) => (
            <div key={c} className="tbl__cell" role="columnheader" style={cellStyle(props.align[c])} title={cell}>
              <span className="tbl__text">{props.renderCell(cell, `${props.id}-h${c}`)}</span>
            </div>
          ))}
        </div>
        <div className="tbl__body" role="rowgroup">
          {props.rows.map((row, r) => (
            <div key={r} className="tbl__row" role="row">
              {row.map((cell, c) => {
                const mark = comparison && c > 0 ? cellMark(cell) : null
                return (
                  <div key={c} className="tbl__cell" role="cell" style={cellStyle(props.align[c])}>
                    {mark === 'yes' ? (
                      <span className="tbl__yes" aria-label="Yes">
                        ✓
                      </span>
                    ) : mark === 'no' ? (
                      <span className="tbl__no" aria-label="No">
                        —
                      </span>
                    ) : (
                      <span className="tbl__text">{props.renderCell(cell, `${props.id}-${r}-${c}`)}</span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
