import { useEffect, useState } from 'react'
import type { Worker } from '@shared/workers'
import { listText, settingsOf } from '@shared/workerSetup'
import type { WorkerVersion } from '@shared/workerVersions'
import { Modal } from '../ui'
import { notify } from '../Notice'
import { errorText, useWorkers } from './workersStore'

/**
 * A worker's earlier setups (shared/workerVersions.ts): when each was
 * replaced and what the change altered. Opening one shows what it said next
 * to what the worker says now; restoring it keeps the setup it replaces, so
 * a restore can be undone from this same list.
 */

const when = (at: number): string => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** The text fields a person would want to compare, before and now. */
const COMPARED: { key: 'purpose' | 'personality' | 'name'; label: string }[] = [
  { key: 'purpose', label: 'Purpose' },
  { key: 'personality', label: 'Personality' },
  { key: 'name', label: 'Name' }
]

export function WorkerVersions({ worker, open, onClose }: { worker: Worker; open: boolean; onClose: () => void }): JSX.Element {
  const [versions, setVersions] = useState<WorkerVersion[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = (): void => {
    setError(null)
    window.api.workers
      .versions(worker.id)
      .then((list) => setVersions([...list].reverse()))
      .catch((e: unknown) => setError(errorText(e)))
  }
  // Reads the list each time it opens: a restore or an edit since changes it.
  useEffect(() => {
    if (open) {
      setVersions(null)
      setOpenId(null)
      load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, worker.id])

  const restore = (version: WorkerVersion): void => {
    setBusy(version.id)
    setError(null)
    window.api.workers
      .restoreVersion(worker.id, version.id)
      .then((restored) => {
        // The change event carries it too; merging here shows it at once.
        useWorkers.setState((s) => ({ workers: s.workers.map((w) => (w.id === restored.id ? restored : w)) }))
        notify(`Put ${worker.name} back to how it was on ${when(version.savedAt)}.`)
        load()
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(null))
  }

  const now = settingsOf(worker)
  return (
    <Modal open={open} onClose={onClose} title={`${worker.name}’s earlier versions`} actions={<button className="btn" onClick={onClose}>Done</button>}>
      {error && (
        <div className="worker-run__detail" data-error role="alert">
          {error}
        </div>
      )}
      {!versions && !error && <div className="worker-activity__empty">Loading…</div>}
      {versions && versions.length === 0 && (
        <div className="worker-activity__empty">Nothing yet. Each time you change {worker.name}’s setup, the one it had before is kept here.</div>
      )}
      {versions?.map((version) => {
        const expanded = openId === version.id
        const diffs = COMPARED.filter(({ key }) => version.settings[key] !== now[key])
        return (
          <div key={version.id} className="worker-version">
            <button className="worker-version__row" aria-expanded={expanded} onClick={() => setOpenId(expanded ? null : version.id)}>
              <span className="worker-version__when">{when(version.savedAt)}</span>
              <span className="worker-version__what">{version.changed.length ? `Before you changed ${listText(version.changed)}` : 'An earlier setup'}</span>
            </button>
            {expanded && (
              <div className="worker-version__body">
                {diffs.length === 0 && <div className="worker-run__meta">Its text matches what {worker.name} has now. Other settings (model, freedom, plugins, limits) may differ.</div>}
                {diffs.map(({ key, label }) => (
                  <div key={key} className="worker-version__diff">
                    <div className="worker-run__meta">{label} then</div>
                    <div className="worker-version__text">{version.settings[key] || 'Empty'}</div>
                    <div className="worker-run__meta">{label} now</div>
                    <div className="worker-version__text">{now[key] || 'Empty'}</div>
                  </div>
                ))}
                <button className="btn btn--sm" disabled={busy !== null} onClick={() => restore(version)}>
                  {busy === version.id ? 'Restoring…' : 'Restore this version'}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </Modal>
  )
}
