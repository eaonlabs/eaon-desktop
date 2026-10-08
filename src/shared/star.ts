/**
 * The "star Eaon on GitHub" popup (main/starPrompt.ts, components/StarPrompt.tsx).
 */

export const STAR_REPO = 'eaonlabs/eaon-desktop'
export const STAR_REPO_URL = `https://github.com/${STAR_REPO}`

/** What the person said to the popup. Closing it, or Escape, is "later". */
export type StarAnswer = 'star' | 'later' | 'never'

/** What pressing "Star on GitHub" did. The repository page always opens. */
export interface StarResult {
  /** The star was put on the person's GitHub account, through the GitHub CLI they are signed in with. */
  starred: boolean
  /** Why it wasn't, for a sentence under the button. Absent when it was. */
  reason?: 'no-gh' | 'not-signed-in' | 'failed'
}

/** How much use of the app comes before the popup in a session: somewhere from 10 to 20 minutes. */
export const ASK_AFTER_MIN_MS = 10 * 60_000
export const ASK_AFTER_MAX_MS = 20 * 60_000

/** This session's wait, from a random number in [0, 1). */
export const askAfterMs = (random: number): number => ASK_AFTER_MIN_MS + Math.floor(Math.min(Math.max(random, 0), 0.999999) * (ASK_AFTER_MAX_MS - ASK_AFTER_MIN_MS))
