import { useEffect } from 'react'
import { create } from 'zustand'
import { branchPrOf, type BranchPr, type PullRequestInfo } from '@shared/adeReview'
import type { AdeSession } from '@shared/adeSessions'
import { useAdeSessions } from './sessionsStore'

/**
 * The pull requests of the ADE's sessions' branches, for the marks on the
 * sidebar's rows: one `gh pr list` per project (main/features/ade/review.ts
 * branchPullRequests), asked when the sidebar shows, every few minutes while
 * Eaon is on screen, and when it comes back to the front. Review's own look at
 * a session's pull request lands here too, so a pull request opened or merged
 * there shows at once. A project whose gh isn't there, or isn't signed in,
 * simply has none.
 */

const EVERY_MS = 3 * 60_000
/** A project isn't asked again sooner than this (Eaon coming to the front again and again). */
const AGAIN_AFTER_MS = 60_000
/** Where GitHub couldn't be asked, it isn't tried again for this long. */
const NONE_FOR_MS = 15 * 60_000

interface BranchPrsState {
  /** By project folder, then by branch. */
  byProject: Record<string, Record<string, BranchPr>>
}

export const useBranchPrs = create<BranchPrsState>(() => ({ byProject: {} }))

const asked = new Map<string, { at: number; failed: boolean }>()

function ask(project: string, cwd: string): void {
  const last = asked.get(project)
  if (last && Date.now() - last.at < (last.failed ? NONE_FOR_MS : AGAIN_AFTER_MS)) return
  asked.set(project, { at: Date.now(), failed: false })
  const failed = (): void => void asked.set(project, { at: Date.now(), failed: true })
  window.api.ade.branchPrs(cwd).then((prs) => {
    if (!prs) return failed()
    useBranchPrs.setState((s) => ({ byProject: { ...s.byProject, [project]: prs } }))
  }, failed)
}

/** Each repository's project, asked from its own folder when that is a session, else from its first session. */
function askAll(sessions: readonly AdeSession[]): void {
  const from = new Map<string, string>()
  for (const session of sessions) {
    if (!session.repo || session.missing || session.archivedAt !== undefined) continue
    if (!from.has(session.project) || session.cwd === session.project) from.set(session.project, session.cwd)
  }
  for (const [project, cwd] of from) ask(project, cwd)
}

/** Keeps every project's pull requests current while the sidebar is up. */
export function useBranchPrsForAll(loaded: boolean): void {
  const sessions = useAdeSessions((s) => s.sessions)
  useEffect(() => {
    if (!loaded) return
    // Once as the sidebar shows, and as sessions come and go, whether or not the window is on screen yet; again only while it is.
    askAll(useAdeSessions.getState().sessions)
    const look = (): void => {
      if (document.visibilityState === 'visible') askAll(useAdeSessions.getState().sessions)
    }
    const timer = window.setInterval(look, EVERY_MS)
    window.addEventListener('focus', look)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', look)
    }
  }, [loaded, sessions])
}

/** The pull request of a session's branch, once known. */
export const useBranchPr = (session: AdeSession): BranchPr | null =>
  useBranchPrs((s) => (session.branch ? (s.byProject[session.project]?.[session.branch] ?? null) : null))

/** What Review found for a session's branch (ReviewPanel), so its row's mark follows at once. */
export function noteReviewPr(cwd: string, branch: string | null, pr: PullRequestInfo | null): void {
  if (!branch || !pr) return
  const session = useAdeSessions.getState().sessions.find((s) => s.cwd === cwd)
  if (!session) return
  useBranchPrs.setState((s) => ({ byProject: { ...s.byProject, [session.project]: { ...s.byProject[session.project], [branch]: branchPrOf(pr) } } }))
}
