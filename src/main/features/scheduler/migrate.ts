import { store } from '../../store'
import { mergeRuns, repairRuns, repairTasks } from './records'

export const TASKS_FILE = 'scheduled-tasks.json'
export const RUNS_FILE = 'scheduled-runs.json'

/**
 * 2026.6.2: runs move out of their task (`history`, inside
 * scheduled-tasks.json) into scheduled-runs.json, one record each. The
 * migration runner backs both files up first. The engine folds embedded
 * runs in on every load as well, so a profile that went back to 2026.6.1
 * and forward again keeps what that version recorded.
 */
export function migrateScheduledRuns(): void {
  const raw = store.getJson<unknown>(TASKS_FILE, [])
  if (!Array.isArray(raw)) return
  const embedded = raw.some((task) => typeof task === 'object' && task !== null && Array.isArray((task as { history?: unknown }).history))
  if (!embedded) return
  const loaded = repairTasks(raw, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone)
  const runs = mergeRuns(repairRuns(store.getJson<unknown>(RUNS_FILE, [])).runs, repairRuns(loaded.embedded).runs)
  store.setJson(RUNS_FILE, runs)
  // Written as the engine would: repaired, less their history, with any
  // task from a newer Eaon kept as it was.
  store.setJson(TASKS_FILE, [...loaded.tasks.map(({ history: _history, ...task }) => task), ...loaded.foreign])
}
