/**
 * Goal runs the user paused, told to what runs inside them. The loop stops a
 * paused run at its next step; a `wait` in hand ends at once instead of
 * sleeping on (for up to two hours) under a banner that says paused.
 */

const paused = new Set<string>()
const listeners = new Map<string, Set<() => void>>()

/** The run writing `messageId` was paused. */
export function markGoalPaused(messageId: string): void {
  paused.add(messageId)
  const waiting = listeners.get(messageId)
  listeners.delete(messageId)
  for (const fn of waiting ?? []) fn()
}

export const isGoalPaused = (messageId: string): boolean => paused.has(messageId)

/** Calls `fn` when the run writing `messageId` is paused. Returns what stops listening. */
export function onGoalPause(messageId: string, fn: () => void): () => void {
  const set = listeners.get(messageId) ?? new Set<() => void>()
  set.add(fn)
  listeners.set(messageId, set)
  return () => {
    set.delete(fn)
    if (set.size === 0 && listeners.get(messageId) === set) listeners.delete(messageId)
  }
}

/** The run ended: nothing is paused or waiting for it any more. */
export function forgetGoalPause(messageId: string): void {
  paused.delete(messageId)
  listeners.delete(messageId)
}
