import { readlinkSync } from 'node:fs'

/**
 * The machine's time zone, kept current in the main process.
 *
 * Node reads the zone once and caches it, so after the user travels (or
 * changes the zone by hand) the main process would keep working out "every
 * day at 9" and "today's usage" in the zone it started in. On macOS and
 * Linux the system zone is the target of `/etc/localtime`; when that no
 * longer matches, setting `TZ` makes Node and ICU load the new one (Node
 * resets its time zone cache whenever `process.env.TZ` is assigned).
 *
 * A `TZ` the process was started with is the user's choice (or a test's),
 * and is left alone. Windows has no such link; there the zone is whatever
 * Eaon started with.
 */

const startedWithTz = Boolean(process.env.TZ)

/** The zone `/etc/localtime` points at, e.g. `Europe/Paris`; null when it can't be told. */
export function systemZoneFromLink(read: (path: string) => string = readlinkSync): string | null {
  if (process.platform === 'win32') return null
  try {
    const target = read('/etc/localtime')
    const match = /zoneinfo\/(.+)$/.exec(target)
    return match && /^[A-Za-z0-9_+\-/]+$/.test(match[1]) ? match[1] : null
  } catch {
    return null
  }
}

/** The link's target as last seen; a change from it is a change of zone. */
let lastSeen: string | null = null

/**
 * The zone in effect, after picking up a system change if there was one.
 * Only a change of the link since it was last looked at counts: at startup
 * the process already has the system zone, perhaps under another name for
 * the same place (Asia/Calcutta for Asia/Kolkata).
 */
export function currentZone(read?: (path: string) => string): string {
  const inEffect = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (startedWithTz) return inEffect
  const system = systemZoneFromLink(read)
  const changed = system !== null && lastSeen !== null && system !== lastSeen
  if (system !== null) lastSeen = system
  if (!changed || system === null) return inEffect
  process.env.TZ = system
  const now = Intl.DateTimeFormat().resolvedOptions().timeZone
  console.log(`[time zone] the system zone changed from ${inEffect} to ${now}`)
  return now
}

/** Tests: forget the link last seen. */
export function resetZoneForTests(): void {
  lastSeen = null
}
