import { WEEKDAYS, WORKDAYS, type Schedule, type TaskDraft } from '@shared/scheduler'

/**
 * The first Scheduled page kept its tasks in localStorage under `scheduled`
 * and never ran them. They move to the scheduler once, at startup, so what
 * the user set up starts working without being re-entered. The old cadences
 * had no time of day; 9:00 is the stand-in, and the editor shows it.
 */

interface LegacyTask {
  prompt?: unknown
  cadence?: unknown
  enabled?: unknown
}

const KEY = 'scheduled'

function scheduleFor(cadence: unknown): Schedule {
  switch (cadence) {
    case 'Every hour':
      return { kind: 'interval', every: 1, unit: 'hours' }
    case 'Every weekday':
      return { kind: 'daily', time: '09:00', days: WORKDAYS }
    case 'Every week':
      return { kind: 'weekly', time: '09:00', day: 1 }
    default:
      return { kind: 'daily', time: '09:00', days: WEEKDAYS }
  }
}

export async function migrateLegacySchedules(): Promise<void> {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return
  }
  if (!raw) return
  let legacy: LegacyTask[] = []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) legacy = parsed as LegacyTask[]
  } catch {
    /* unreadable: nothing worth keeping */
  }
  const drafts: TaskDraft[] = legacy
    .filter((task) => typeof task?.prompt === 'string' && task.prompt.trim())
    .map((task) => {
      const prompt = (task.prompt as string).trim()
      return {
        name: prompt.split('\n')[0].slice(0, 60),
        prompt,
        schedule: scheduleFor(task.cadence),
        mode: 'chat',
        model: null,
        cwd: null,
        allowChanges: false,
        enabled: task.enabled !== false
      }
    })
  if (drafts.length > 0) await window.api.scheduler.importLegacy(drafts)
  // Cleared only once main has them, so a failed import is retried next launch.
  localStorage.removeItem(KEY)
}
