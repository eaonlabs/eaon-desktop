import type { RunStatus } from '@shared/scheduler'

/** Time helpers for the Scheduled page. Local time throughout, like the schedules themselves. */

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function startOfDay(at: number): number {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Calendar days between two instants, counted in local dates (DST-safe). */
function dayDelta(at: number, now: number): number {
  return Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000)
}

/** "Today at 9:00 AM", "Tomorrow at 9:00 AM", "Thu at 9:00 AM", "Sep 30 at 9:00 AM". */
export function formatWhen(at: number, now = Date.now()): string {
  const days = dayDelta(at, now)
  if (days === 0) return `Today at ${clock(at)}`
  if (days === 1) return `Tomorrow at ${clock(at)}`
  if (days === -1) return `Yesterday at ${clock(at)}`
  if (days > 1 && days < 7) return `${new Date(at).toLocaleDateString([], { weekday: 'long' })} at ${clock(at)}`
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  const date = new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
  return `${date} at ${clock(at)}`
}

/** Compact stamp for the history list: "9:00 AM" today, "Sep 22, 9:00 AM" otherwise. */
export function formatStamp(at: number, now = Date.now()): string {
  if (dayDelta(at, now) === 0) return clock(at)
  return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' })

/** "in 14 hr", "5 min ago", "now". */
export function formatRelative(at: number, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 45) return 'now'
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour')
  return relative.format(Math.round(seconds / 86_400), 'day')
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Stopped',
  missed: 'Missed'
}

/** `<input type="datetime-local">` speaks "YYYY-MM-DDTHH:MM" in local time. */
export function toLocalInput(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromLocalInput(value: string): number {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? new Date(value).getTime() : NaN
}
