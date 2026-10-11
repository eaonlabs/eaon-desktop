/**
 * Whether a pane is working: what turns its dot (and its session's ring) into
 * a spinner. Output alone used to be enough, so typing at a prompt, focusing a
 * pane or resizing one (every one of which a CLI answers by echoing or
 * redrawing) made an idle agent look busy.
 *
 * Now output counts only when it isn't an answer to something you just did,
 * and only once it keeps coming: an agent at work prints a spinner and its
 * output for seconds on end; an echo or a redraw is one short burst.
 */

/** Output this soon after you typed, pasted, focused or resized is the terminal answering you. */
export const ECHO_MS = 600
/** Output has to keep coming this long before the pane counts as working. */
export const SUSTAIN_MS = 800
/** Quiet this long and a working pane is idle again. */
export const WORKING_MS = 1500

export interface Activity {
  /** The last time the terminal was poked: a key, a paste, a focus report, a resize. */
  poked: number
  /** When the current stretch of output (not counting answers to pokes) began. */
  since: number
  /** The last output that wasn't an answer to a poke. */
  last: number
}

export const quietActivity = (): Activity => ({ poked: 0, since: 0, last: 0 })

/**
 * Output arrived at `now`. Returns whether the pane should be working now.
 * A pane already working keeps counting output while you type, so typing at a
 * busy agent (queueing a message) doesn't make it look done.
 */
export function noteOutput(a: Activity, now: number, working: boolean): boolean {
  if (!working && now - a.poked < ECHO_MS) return false
  if (now - a.last > WORKING_MS) a.since = now
  a.last = now
  return working || now - a.since >= SUSTAIN_MS
}

/** Whether a working pane has gone quiet. */
export const wentQuiet = (a: Activity, now: number): boolean => now - a.last > WORKING_MS
