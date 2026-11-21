import type { JSX } from 'react'
import type { PullRequestDetail } from '@shared/types'
import { Octicon, type OcticonName } from './octicons'

type Check = PullRequestDetail['checks'][number]

const MARK: Record<Check['status'], { icon: OcticonName; words: string }> = {
  failed: { icon: 'x-circle-fill', words: 'Failing' },
  pending: { icon: 'dot-fill', words: 'In progress' },
  passed: { icon: 'check-circle-fill', words: 'Successful' },
  skipped: { icon: 'skip', words: 'Skipped' }
}

const ORDER = { failed: 0, pending: 1, passed: 2, skipped: 3 }

/** The checks, the failing ones first, each with a link to its run: the merge box's list and the Checks tab's. */
export function ChecksList({ checks, flush }: { checks: Check[]; flush?: boolean }): JSX.Element {
  return (
    <ul className="gh-checks" data-flush={flush || undefined}>
      {[...checks]
        .sort((a, b) => ORDER[a.status] - ORDER[b.status])
        .map((check, i) => (
          <li key={`${check.name}-${i}`} className="gh-check" data-status={check.status}>
            <span className="gh-check__mark" data-status={check.status}>
              <Octicon name={MARK[check.status].icon} />
            </span>
            <span className="gh-check__name">{check.name}</span>
            <span className="gh-check__status">{MARK[check.status].words}</span>
            {check.url ? (
              <button type="button" className="gh-link gh-check__details" onClick={() => void window.api.app.openExternal(check.url!)}>
                Details
              </button>
            ) : (
              <span className="gh-check__details" />
            )}
          </li>
        ))}
    </ul>
  )
}

/** The Checks tab: a box headed by how they went, as on GitHub. */
export function Checks({ detail }: { detail: PullRequestDetail }): JSX.Element {
  if (detail.checks.length === 0) {
    return (
      <div className="gh-blank">
        <Octicon name="checklist" size={24} />
        <h3>No checks</h3>
        <p>This pull request has no status checks.</p>
      </div>
    )
  }
  const count = (status: Check['status']): number => detail.checks.filter((c) => c.status === status).length
  const failing = count('failed')
  const pending = count('pending')
  const parts = [failing && `${failing} failing`, pending && `${pending} in progress`, count('passed') && `${count('passed')} successful`, count('skipped') && `${count('skipped')} skipped`].filter(Boolean)
  return (
    <div className="gh-box">
      <div className="gh-box__header gh-checks__head">
        <span className="gh-check__mark" data-status={failing ? 'failed' : pending ? 'pending' : 'passed'}>
          <Octicon name={failing ? 'x-circle-fill' : pending ? 'dot-fill' : 'check-circle-fill'} />
        </span>
        <strong>{failing ? 'Some checks were not successful' : pending ? 'Some checks haven’t completed yet' : 'All checks have passed'}</strong>
        <span className="gh-muted">{parts.join(', ')}</span>
      </div>
      <ChecksList checks={detail.checks} flush />
    </div>
  )
}
