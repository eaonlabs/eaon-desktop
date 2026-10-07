import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Settings } from '@shared/types'
import { STAR_REPO, STAR_REPO_URL, type StarResult } from '@shared/star'
import { onPath } from './shellEnv'

/**
 * Asks, politely and rarely, whether to star Eaon's repository, and does it
 * when the person says yes.
 *
 * Starring is an act on someone's GitHub account, so it only ever happens
 * from the button that says so. Eaon has no GitHub login of its own; it uses
 * the GitHub CLI the person already signed in (the same one the Pull requests
 * page reads). Without it the repository page still opens, for them to press
 * the star there.
 */

type PromptState = Settings['starPrompt']

/** Launches before the first ask, asks in all, and the wait between them. */
export const MIN_LAUNCHES = 3
export const MAX_ASKS = 3
export const ASK_EVERY_MS = 14 * 24 * 60 * 60 * 1000

/** Whether to put the popup up now. */
export function shouldAsk(state: PromptState, now: number): boolean {
  if (state.status !== 'pending') return false
  if (state.launches < MIN_LAUNCHES || state.asked >= MAX_ASKS) return false
  return state.lastAskedAt === null || now - state.lastAskedAt >= ASK_EVERY_MS
}

/** What asking again would find out, and what starring does: the GitHub CLI, run as a function so a test can stand in for it. */
export type Gh = (args: string[]) => Promise<{ ok: true } | { ok: false; reason: NonNullable<StarResult['reason']> }>

const exec = promisify(execFile)

export const runGh: Gh = async (args) => {
  const gh = onPath('gh')
  if (!gh) return { ok: false, reason: 'no-gh' }
  try {
    // windowsHide: a console window would flash otherwise. A signed-in
    // account other than this call's is the CLI's business, not ours.
    await exec(gh, args, { timeout: 15_000, windowsHide: true })
    return { ok: true }
  } catch (error) {
    const text = `${(error as { stderr?: string }).stderr ?? ''} ${(error as Error).message}`
    if (/gh auth login|not logged in|authentication|401|bad credentials|requires authentication/i.test(text)) return { ok: false, reason: 'not-signed-in' }
    return { ok: false, reason: 'failed' }
  }
}

/** Whether this person's account has already starred it (a 404 means not yet). */
export async function alreadyStarred(gh: Gh = runGh): Promise<boolean> {
  return (await gh(['api', `/user/starred/${STAR_REPO}`])).ok
}

/** Stars the repository for the signed-in GitHub CLI, and opens its page either way. */
export async function starRepository(openUrl: (url: string) => Promise<void>, gh: Gh = runGh): Promise<StarResult> {
  const [outcome] = await Promise.all([gh(['api', '--method', 'PUT', `/user/starred/${STAR_REPO}`]), openUrl(STAR_REPO_URL).catch(() => undefined)])
  return outcome.ok ? { starred: true } : { starred: false, reason: outcome.reason }
}
