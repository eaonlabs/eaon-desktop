import { changedSettings, sameSettings, type WorkerSettings } from './workerSetup'
import type { Worker } from './workers'
import { settingsOf } from './workerSetup'

/**
 * A worker's earlier setups, kept so a change can be looked at and undone.
 * Each time the Edit dialog (or an import) changes what the worker is set up
 * to do, the setup it had before is saved here, newest last. Restoring one
 * is itself a change, so the setup it replaced is saved too and the restore
 * can be undone.
 */
export interface WorkerVersion {
  id: string
  /** When the setup stopped being the current one. */
  savedAt: number
  settings: WorkerSettings
  /** What the change that replaced it altered, as words ("purpose", "model"). */
  changed: string[]
}

export const MAX_VERSIONS = 20

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** Saved versions as read back: only well-formed entries, the newest MAX_VERSIONS. */
export function normalizeVersions(raw: unknown): WorkerVersion[] {
  if (!Array.isArray(raw)) return []
  const out: WorkerVersion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const v = item as Partial<WorkerVersion>
    const savedAt = finite(v.savedAt)
    if (typeof v.id !== 'string' || !v.id || savedAt === null || !v.settings || typeof v.settings !== 'object') continue
    const settings = v.settings as WorkerSettings
    if (typeof settings.name !== 'string' || typeof settings.purpose !== 'string' || typeof settings.personality !== 'string') continue
    out.push({ id: v.id, savedAt, settings, changed: Array.isArray(v.changed) ? v.changed.filter((c): c is string => typeof c === 'string') : [] })
  }
  return out.slice(-MAX_VERSIONS)
}

/**
 * The versions after a change from `before` to the worker's settings now:
 * the same list when nothing that matters changed, otherwise with `before`
 * added.
 */
export function withVersion(versions: readonly WorkerVersion[] | undefined, before: WorkerSettings, worker: Worker, id: string, now: number): WorkerVersion[] {
  const kept = [...(versions ?? [])]
  const after = settingsOf(worker)
  if (sameSettings(before, after)) return kept
  kept.push({ id, savedAt: now, settings: before, changed: changedSettings(before, after) })
  return kept.slice(-MAX_VERSIONS)
}
