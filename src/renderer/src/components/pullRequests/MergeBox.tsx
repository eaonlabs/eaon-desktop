import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import type { PullRequestAction, PullRequestDetail } from '@shared/types'
import { MenuItem, Popover, useDisclosure } from '../ui'
import { Octicon, type OcticonName } from './octicons'
import { BranchRef, errorText, stateKey } from './parts'
import { ChecksList } from './Checks'

type Method = 'squash' | 'merge' | 'rebase'

const METHOD: Record<Method, { button: string; confirm: string; about: string }> = {
  merge: { button: 'Merge pull request', confirm: 'Confirm merge', about: 'All commits from this branch will be added to the base branch via a merge commit.' },
  squash: { button: 'Squash and merge', confirm: 'Confirm squash and merge', about: 'The commits from this branch will be combined into one commit in the base branch.' },
  rebase: { button: 'Rebase and merge', confirm: 'Confirm rebase and merge', about: 'The commits from this branch will be rebased and added to the base branch.' }
}

type Tone = 'success' | 'danger' | 'attention' | 'neutral' | 'done'

/** One row of the box: a coloured mark (none where the box's own icon says it), a heading, a line under it, and a button at the end if there's something to do. */
function Section({ icon, tone, title, children, action }: { icon?: OcticonName; tone: Tone; title: ReactNode; children?: ReactNode; action?: ReactNode }): JSX.Element {
  return (
    <div className="gh-merge__section">
      {icon && (
        <span className="gh-merge__mark" data-tone={tone}>
          <Octicon name={icon} />
        </span>
      )}
      <div className="gh-merge__text">
        <h4 className="gh-merge__title">{title}</h4>
        {children && <p className="gh-merge__about">{children}</p>}
      </div>
      {action}
    </div>
  )
}

/**
 * The merge box at the foot of the conversation, as GitHub's: whether it's
 * reviewed, how its checks went, whether it merges cleanly, then the merge
 * button with its method. Merging asks for the commit message first, behind
 * Confirm, as on GitHub. Merged, closed and draft pull requests say so instead.
 */
export function MergeBox({ detail, after }: { detail: PullRequestDetail; after: (result: PullRequestAction) => void }): JSX.Element {
  const methods = (['squash', 'merge', 'rebase'] as const).filter((m) => detail.methods[m])
  const [method, setMethod] = useState<Method>(methods[0] ?? 'squash')
  const [confirming, setConfirming] = useState(false)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [deleteBranch, setDeleteBranch] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [showChecks, setShowChecks] = useState(false)
  const methodMenu = useDisclosure()
  const caret = useRef<HTMLButtonElement>(null)

  // The commit GitHub would write, as the starting point.
  useEffect(() => {
    setSubject(method === 'squash' ? `${detail.title} (#${detail.number})` : `Merge pull request #${detail.number} from ${detail.head}`)
    setBody(method === 'squash' ? '' : detail.title)
  }, [method, detail.number, detail.title, detail.head])

  const act = async (label: string, job: () => Promise<PullRequestAction>): Promise<void> => {
    setBusy(label)
    try {
      const result = await job()
      if (result.ok) setConfirming(false)
      after(result)
    } catch (e) {
      after({ ok: false, error: errorText(e) })
    } finally {
      setBusy(null)
    }
  }

  const state = stateKey(detail.state)
  const failing = detail.checks.filter((c) => c.status === 'failed').length
  const pending = detail.checks.filter((c) => c.status === 'pending').length
  const passed = detail.checks.filter((c) => c.status === 'passed').length
  const skipped = detail.checks.filter((c) => c.status === 'skipped').length
  const conflicts = detail.mergeable === 'CONFLICTING' || detail.mergeState === 'DIRTY'
  // Waiting on something GitHub can wait for itself: merging turns into auto-merge.
  const blocked = detail.mergeState === 'BLOCKED' || detail.mergeState === 'BEHIND' || detail.mergeState === 'UNKNOWN' || pending > 0
  const canMerge = methods.length > 0 && !conflicts

  if (state === 'merged') {
    return (
      <div className="gh-merge" data-tone="done">
        <span className="gh-merge__icon" data-tone="done">
          <Octicon name="git-merge" size={24} />
        </span>
        <div className="gh-merge__box" data-tone="done">
          <Section tone="done" title="Pull request successfully merged and closed">
            You’re all set — the <BranchRef name={detail.head} /> branch can be safely deleted.
          </Section>
        </div>
      </div>
    )
  }
  if (state === 'closed') {
    return (
      <div className="gh-merge" data-tone="danger">
        <span className="gh-merge__icon" data-tone="danger">
          <Octicon name="git-pull-request-closed" size={24} />
        </span>
        <div className="gh-merge__box" data-tone="bad">
          <Section tone="danger" title="Closed with unmerged commits">
            This pull request is closed, but the <BranchRef name={detail.head} /> branch has unmerged commits.
          </Section>
        </div>
      </div>
    )
  }

  const decision = detail.reviewDecision
  const approvals = detail.reviews.filter((r) => r.state === 'APPROVED').length
  const changes = detail.reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length
  const approveButton = (
    <button type="button" className="gh-btn gh-btn--sm" disabled={busy !== null} onClick={() => void act('approve', () => window.api.github.act(detail.url, 'approve'))}>
      {busy === 'approve' ? 'Approving…' : 'Approve'}
    </button>
  )
  const checksSummary = [failing && `${failing} failing`, pending && `${pending} in progress`, passed && `${passed} successful`, skipped && `${skipped} skipped`].filter(Boolean).join(', ')
  const icon: Tone = state === 'draft' ? 'neutral' : conflicts ? 'danger' : blocked || failing ? 'neutral' : 'success'

  return (
    <div className="gh-merge">
      <span className="gh-merge__icon" data-tone={icon}>
        <Octicon name={state === 'draft' ? 'git-pull-request-draft' : 'git-merge'} size={24} />
      </span>
      <div className="gh-merge__box">
        {/* Reviews */}
        {decision === 'APPROVED' ? (
          <Section icon="check" tone="success" title="Changes approved">
            {approvals || 1} approving {approvals === 1 || !approvals ? 'review' : 'reviews'} by reviewers with write access.
          </Section>
        ) : decision === 'CHANGES_REQUESTED' ? (
          <Section icon="file-diff" tone="danger" title="Changes requested" action={approveButton}>
            {changes || 1} {changes > 1 ? 'reviews' : 'review'} requesting changes by reviewers with write access.
          </Section>
        ) : decision === 'REVIEW_REQUIRED' ? (
          <Section icon="dot-fill" tone="attention" title="Review required" action={approveButton}>
            At least 1 approving review is required by reviewers with write access.
          </Section>
        ) : null}

        {/* Checks */}
        {detail.checks.length > 0 && (
          <>
            <Section
              icon={failing ? 'x' : pending ? 'dot-fill' : 'check'}
              tone={failing ? 'danger' : pending ? 'attention' : 'success'}
              title={failing ? 'Some checks were not successful' : pending ? 'Some checks haven’t completed yet' : 'All checks have passed'}
              action={
                <button type="button" className="gh-link gh-merge__toggle" aria-expanded={showChecks} onClick={() => setShowChecks((v) => !v)}>
                  {showChecks ? 'Hide all checks' : 'Show all checks'}
                </button>
              }
            >
              {checksSummary} {detail.checks.length === 1 ? 'check' : 'checks'}
            </Section>
            {showChecks && <ChecksList checks={detail.checks} flush />}
          </>
        )}

        {/* Whether it merges */}
        {state === 'draft' ? (
          <Section
            icon="alert"
            tone="neutral"
            title="This pull request is still a work in progress"
            action={
              <button type="button" className="gh-btn gh-btn--sm" disabled={busy !== null} onClick={() => void act('ready', () => window.api.github.act(detail.url, 'ready'))}>
                {busy === 'ready' ? 'Marking…' : 'Ready for review'}
              </button>
            }
          >
            Draft pull requests cannot be merged.
          </Section>
        ) : conflicts ? (
          <Section icon="alert" tone="danger" title="This branch has conflicts that must be resolved">
            Resolve the conflicts with <BranchRef name={detail.base} /> in the ADE or on GitHub.
          </Section>
        ) : detail.mergeState === 'BEHIND' ? (
          <Section
            icon="alert"
            tone="attention"
            title="This branch is out-of-date with the base branch"
            action={
              <button type="button" className="gh-btn gh-btn--sm" disabled={busy !== null} onClick={() => void act('update-branch', () => window.api.github.act(detail.url, 'update-branch'))}>
                {busy === 'update-branch' ? 'Updating…' : 'Update branch'}
              </button>
            }
          >
            Merge the latest changes from <BranchRef name={detail.base} /> into this branch.
          </Section>
        ) : detail.mergeable === 'UNKNOWN' ? (
          <Section icon="dot-fill" tone="attention" title="Checking for the ability to merge automatically…">
            Refresh in a moment.
          </Section>
        ) : detail.mergeState === 'BLOCKED' ? (
          <Section icon="x" tone="neutral" title="Merging is blocked">
            The base branch requires all of the above before it can merge. You can have it merge on its own once they pass.
          </Section>
        ) : (
          <Section icon="check" tone="success" title="No conflicts with base branch">
            Merging can be performed automatically.
          </Section>
        )}

        {/* Merge */}
        {state === 'open' && (
          <div className="gh-merge__action">
            {!confirming ? (
              <>
                <div className="gh-split">
                  <button type="button" className="gh-btn gh-btn--primary gh-split__main" disabled={!canMerge || busy !== null} onClick={() => setConfirming(true)}>
                    {blocked ? 'Enable auto-merge' : METHOD[method].button}
                  </button>
                  <button
                    ref={caret}
                    type="button"
                    className="gh-btn gh-btn--primary gh-split__caret"
                    aria-label="Choose a merge method"
                    disabled={methods.length < 2 || busy !== null}
                    onClick={methodMenu.toggle}
                  >
                    <Octicon name="triangle-down" />
                  </button>
                </div>
                <span className="gh-muted gh-merge__hint">{methods.length === 0 ? 'This repository doesn’t allow any merge method.' : blocked ? `It will ${METHOD[method].button.toLowerCase()} once the requirements are met.` : METHOD[method].about}</span>
                <Popover anchor={caret} open={methodMenu.open} onClose={methodMenu.close} placement="bottom-start" width={340}>
                  {methods.map((m) => (
                    <MenuItem
                      key={m}
                      title={METHOD[m].button}
                      description={METHOD[m].about}
                      checked={m === method}
                      onClick={() => {
                        setMethod(m)
                        methodMenu.close()
                      }}
                    />
                  ))}
                </Popover>
              </>
            ) : (
              <form
                className="gh-merge__form"
                onSubmit={(e) => {
                  e.preventDefault()
                  void act('merge', () => window.api.github.merge(detail.url, { method, deleteBranch: deleteBranch && !detail.deletesBranch, auto: blocked, subject, body }))
                }}
              >
                {method !== 'rebase' && (
                  <>
                    <label className="gh-field">
                      <span className="gh-field__label">Commit message</span>
                      <input className="gh-input" value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus />
                    </label>
                    <label className="gh-field">
                      <span className="gh-field__label">Extended description</span>
                      <textarea className="gh-input gh-merge__body" rows={4} placeholder="Add an optional extended description…" value={body} onChange={(e) => setBody(e.target.value)} />
                    </label>
                  </>
                )}
                <label className="gh-checkbox">
                  <input type="checkbox" checked={deleteBranch || detail.deletesBranch} disabled={detail.deletesBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
                  Delete <BranchRef name={detail.head} /> after merging{detail.deletesBranch ? ' (the repository always does)' : ''}
                </label>
                <div className="gh-merge__confirm">
                  <button type="submit" className="gh-btn gh-btn--primary" disabled={busy !== null}>
                    {busy === 'merge' ? 'Merging…' : blocked ? 'Confirm auto-merge' : METHOD[method].confirm}
                  </button>
                  <button type="button" className="gh-btn" disabled={busy !== null} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
