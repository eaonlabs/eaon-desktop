/**
 * ADE sessions asleep: their terminals ended to give back the memory their
 * shells and agents held, each pane kept in its place with the conversation
 * it was in, so opening the session starts them again where they were (the
 * archive's parking, without leaving the sidebar). A session nobody has
 * opened since launch is asleep too: its terminals start when it's shown.
 *
 * With Settings → ADE → "Sleep idle sessions" on, a session is put to sleep
 * once nothing in it has printed for that long, unless it's the one open in
 * the ADE, an agent in it is working, or one of its terminals is serving a
 * local dev server someone may be using.
 */

/** The choices Settings offers, in minutes; 0 is never. */
export const AUTO_SLEEP_CHOICES = [0, 15, 30, 60, 120] as const

export const autoSleepLabel = (minutes: number): string =>
  minutes === 0 ? 'Never' : minutes < 60 ? `After ${minutes} minutes` : minutes === 60 ? 'After 1 hour' : `After ${minutes / 60} hours`

/** What the sidebar knows of one of a session's panes (registry `infoOf`). */
export interface PaneLife {
  /** It has a terminal in this window: its shell started (or is starting). */
  known: boolean
  status: 'starting' | 'working' | 'idle' | 'exited' | string
  /** When it last printed, ms. */
  lastData: number
  /** It printed a local server's address that's still in the list. */
  serving: boolean
}

/** Asleep: it has panes, and none of them has a terminal running. */
export function isAsleep(panes: PaneLife[]): boolean {
  return panes.length > 0 && panes.every((p) => !p.known || p.status === 'exited')
}

/** Something in it runs that sleep would end. */
export const isAwake = (panes: PaneLife[]): boolean => panes.some((p) => p.known && p.status !== 'exited')

/**
 * Whether auto-sleep should put a session to sleep now. `current`: it's the
 * session open in the ADE. `minutes` 0 never does.
 */
export function shouldSleep(panes: PaneLife[], opts: { current: boolean; minutes: number; now: number }): boolean {
  if (opts.minutes <= 0 || opts.current || !isAwake(panes)) return false
  const live = panes.filter((p) => p.known && p.status !== 'exited')
  // A pane stays "starting" until it first does some work, so a shell that only ever printed its
  // prompt never leaves it; how long it has been quiet decides, as for any other pane.
  if (live.some((p) => p.status === 'working' || p.serving)) return false
  const quietFor = opts.minutes * 60_000
  return live.every((p) => opts.now - p.lastData >= quietFor)
}
