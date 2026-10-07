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
