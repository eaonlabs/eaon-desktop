import { useEffect, useMemo, useState, type JSX } from 'react'
import { CircleCheck, CircleDashed, CircleX, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Loader2 } from 'lucide-react'
import type { PullRequestInfo } from '@shared/adeReview'
import { useApp } from '../../../state/store'
import { openInBrowser } from '../../browser/browserStore'
import { GitActions } from '../../chatCode/GitActions'
import { useReview } from '../../code/reviewStore'
import { useTerminalPulls } from '../adeDock'
import { useDockPlace } from '../dockPlace'
import { linkedPulls, type LinkedPull } from './linkedPulls'

/**
 * The dock's pull request surfaces. Pull request: the one open for the
 * folder's branch, its state, review and checks. Linked pull requests: the
 * pull requests this chat has named by their links, or in the ADE the ones
 * its session's terminals show, newest first.
 */

/** The branch's pull request: undefined while asking, null when there is none, or why it couldn't be asked. */
export function useBranchPullRequest(): PullRequestInfo | null | undefined | { problem: string } {
  const { folder, status } = useDockPlace()
  const branch = status?.branch ?? null
  const remote = Boolean(status?.remote)
  const [pr, setPr] = useState<PullRequestInfo | null | undefined | { problem: string }>(undefined)
  useEffect(() => {
    if (!folder || !remote || !branch) return setPr(null)
    let live = true
    setPr(undefined)
    void window.api.chatCode
      .pullRequest(folder)
      .then((res) => live && setPr(res.ok ? res.pr : { problem: res.problem }))
      .catch(() => live && setPr({ problem: 'GitHub couldn’t be asked about this branch.' }))
    return () => {
      live = false
    }
  }, [folder, branch, remote])
  return pr
}

const STATE: Record<PullRequestInfo['state'] | 'DRAFT', { label: string; icon: JSX.Element }> = {
  OPEN: { label: 'Open', icon: <GitPullRequest size={14} strokeWidth={2} /> },
  DRAFT: { label: 'Draft', icon: <GitPullRequestDraft size={14} strokeWidth={2} /> },
  MERGED: { label: 'Merged', icon: <GitMerge size={14} strokeWidth={2} /> },
  CLOSED: { label: 'Closed', icon: <GitPullRequestClosed size={14} strokeWidth={2} /> }
}

const REVIEW: Record<string, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REVIEW_REQUIRED: 'Review required'
}

const MERGE: Record<string, string> = {
  CLEAN: 'Ready to merge',
  BLOCKED: 'Blocked by the rules on its branch',
  BEHIND: 'Behind its base branch',
  DIRTY: 'Has conflicts with its base branch',
  UNSTABLE: 'Some checks didn’t pass'
}

export function PullRequestSurface(): JSX.Element {
  const place = useDockPlace()
  const branch = place.status?.branch ?? null
  const pr = useBranchPullRequest()

  if (pr === undefined) {
    return (
      <div className="dock-note">
        <Loader2 size={16} className="spinner" />
        <span>Asking GitHub about {branch ?? 'this branch'}…</span>
      </div>
    )
  }
  if (pr === null || 'problem' in pr) {
    return (
      <div className="dock-note">
        <GitPullRequest size={22} strokeWidth={1.5} />
        <p className="dock-note__title">{pr === null ? 'No pull request for this branch' : 'Couldn’t reach GitHub'}</p>
        <p className="dock-note__hint">
          {pr === null ? `Push ${branch ?? 'the branch'} and open one${place.id === 'ade' ? ' from Review' : ''} to review it here.` : pr.problem}
        </p>
        {pr === null && (
          <div className="dock-note__action">
            {/* Chat's Git button acts on Chat's folder; the ADE's is Review, in its top bar. */}
            {place.id === 'chat' ? (
              <GitActions row />
            ) : (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => !useReview.getState().open && useReview.getState().toggle()}>
                <GitPullRequest size={14} strokeWidth={2} />
                Open Review
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const state = STATE[pr.draft && pr.state === 'OPEN' ? 'DRAFT' : pr.state]
  const merge = pr.state === 'OPEN' ? (MERGE[pr.mergeState] ?? null) : null
  return (
    <div className="pr-view scroll">
      <div className="pr-view__head">
        <span className="pr-view__state" data-state={pr.draft && pr.state === 'OPEN' ? 'DRAFT' : pr.state}>
          {state.icon}
          {state.label}
        </span>
        <span className="pr-view__number">#{pr.number}</span>
        <div style={{ flex: 1 }} />
        <button type="button" className="pr-view__link" onClick={() => openInBrowser(pr.url)} title="Open it in the browser">
          <ExternalLink size={13} strokeWidth={2} />
          Open
        </button>
      </div>
      <h2 className="pr-view__title">{pr.title}</h2>
      <p className="pr-view__meta">
        {branch} → {pr.baseRef}
      </p>
      <dl className="pr-view__facts">
        {pr.reviewDecision && (
          <>
            <dt>Review</dt>
            <dd>{REVIEW[pr.reviewDecision] ?? pr.reviewDecision}</dd>
          </>
        )}
        {merge && (
          <>
            <dt>Merge</dt>
            <dd>{merge}</dd>
          </>
        )}
        <dt>Checks</dt>
        <dd>
          {pr.checkRuns.length === 0
            ? 'None'
            : [pr.checks.passed && `${pr.checks.passed} passed`, pr.checks.failed && `${pr.checks.failed} failed`, pr.checks.pending && `${pr.checks.pending} running`].filter(Boolean).join(', ')}
        </dd>
      </dl>
      {pr.checkRuns.length > 0 && (
        <ul className="pr-view__checks">
          {pr.checkRuns.map((check, i) => (
            <li key={`${check.name}-${i}`}>
              <button type="button" className="pr-view__check" data-status={check.status} disabled={!check.url} onClick={() => check.url && openInBrowser(check.url)}>
                {check.status === 'passed' ? (
                  <CircleCheck size={14} strokeWidth={2} />
                ) : check.status === 'failed' ? (
                  <CircleX size={14} strokeWidth={2} />
                ) : (
                  <CircleDashed size={14} strokeWidth={2} />
                )}
                <span className="pr-view__check-name">{check.name}</span>
                {check.workflow && <span className="pr-view__check-flow">{check.workflow}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Pull requests linked in the chat, or in the ADE session's terminals. */
export function useLinkedPulls(): LinkedPull[] {
  const place = useDockPlace()
  const chat = place.id === 'chat'
  const messages = useApp((s) => (chat ? s.activeChat()?.messages : undefined))
  const inChat = useMemo(() => linkedPulls(messages ?? []), [messages])
  const inTerminals = useTerminalPulls(chat ? null : place.folder)
  return chat ? inChat : inTerminals
}

export function LinkedPullsSurface(): JSX.Element {
  const chat = useDockPlace().id === 'chat'
  const pulls = useLinkedPulls()
  if (pulls.length === 0) {
    return (
      <div className="dock-note">
        <GitPullRequest size={22} strokeWidth={1.5} />
        <p className="dock-note__title">{chat ? 'No pull requests in this chat' : 'No pull requests in this session'}</p>
        <p className="dock-note__hint">
          {chat ? 'Pull requests this chat opens or links to are listed here.' : 'Pull requests your agents open or link to in this session’s terminals are listed here.'}
        </p>
      </div>
    )
  }
  return (
    <ul className="linked-prs scroll">
      {pulls.map((pull) => (
        <li key={pull.url}>
          <button type="button" className="linked-prs__row" onClick={() => openInBrowser(pull.url)} title={pull.url}>
            <GitPullRequest size={15} strokeWidth={1.9} />
            <span className="linked-prs__repo">{pull.repo}</span>
            <span className="linked-prs__number">#{pull.number}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
