import { useEffect, useState } from 'react'
import type { Worker } from '@shared/workers'
import { tableCsv, type WorkerTable } from '@shared/workerTables'
import { Modal } from '../ui'
import { notify } from '../Notice'
import { errorText } from './workersStore'

/**
 * The tables a worker keeps (shared/workerTables.ts), in its Activity panel:
 * one line a table, shown only once there is one. A table opens as a grid
 * (the first rows), can be copied as CSV, and can be removed.
 */

/** Rows the grid draws: a table may hold thousands, and the CSV has them all. */
const GRID_ROWS = 200

export function WorkerTablesSection({ worker }: { worker: Worker }): JSX.Element | null {
  const [tables, setTables] = useState<WorkerTable[]>([])
  const [shown, setShown] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)

  // Read when the panel opens, and again when the worker's run ends and rewrites its tables.
  useEffect(() => {
    let live = true
    window.api.workers
      .tables(worker.id)
      .then((list) => live && setTables(list))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [worker.id, worker.lastRunAt, worker.status])

  if (tables.length === 0) return null
  const table = tables.find((t) => t.name === shown) ?? null
  const asOf = (at: number): string => (at ? new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '')

  return (
    <section className="worker-activity__section">
      <h2 className="worker-activity__heading">Tables</h2>
      {tables.map((t) => (
        <div key={t.name} className="worker-run">
          <div className="worker-run__main">
            <div className="worker-run__line">
              <span className="worker-run__label">{t.name}</span>
              <span className="worker-run__state">{t.rows.length === 1 ? '1 row' : `${t.rows.length} rows`}</span>
            </div>
            <div className="worker-run__meta">{[t.columns.join(', '), asOf(t.updatedAt) && `updated ${asOf(t.updatedAt)}`].filter(Boolean).join(' · ')}</div>
            <div className="worker-run__actions">
              <button className="btn btn--ghost btn--sm" onClick={() => setShown(t.name)}>
                View
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirm(t.name)}>
                Remove
              </button>
            </div>
          </div>
        </div>
      ))}
      <Modal
        open={table !== null}
        onClose={() => setShown(null)}
        title={table ? `${table.name} · ${table.rows.length} ${table.rows.length === 1 ? 'row' : 'rows'}` : ''}
        width={760}
        actions={
          <>
            <button
              className="btn btn--ghost"
              onClick={() => {
                if (!table) return
                void navigator.clipboard.writeText(tableCsv(table)).then(() => notify('Copied as CSV.'))
              }}
            >
              Copy as CSV
            </button>
            <button className="btn" onClick={() => setShown(null)}>
              Done
            </button>
          </>
        }
      >
        {table && (
          <div className="worker-table scroll">
            <table>
              <thead>
                <tr>
                  {table.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.slice(0, GRID_ROWS).map((row, i) => (
                  <tr key={i}>
                    {table.columns.map((c) => (
                      <td key={c}>{row[c]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {table.rows.length > GRID_ROWS && <div className="worker-run__meta">The first {GRID_ROWS} rows. Copy as CSV for all {table.rows.length}.</div>}
          </div>
        )}
      </Modal>
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={`Remove ${confirm ?? ''}?`}
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              autoFocus
              onClick={() => {
                const name = confirm
                setConfirm(null)
                if (name) window.api.workers.removeTable(worker.id, name).then(setTables).catch((e: unknown) => notify(errorText(e), 'error'))
              }}
            >
              Remove table
            </button>
          </>
        }
      >
        <p>{worker.name} loses these rows. This can’t be undone.</p>
      </Modal>
    </section>
  )
}
