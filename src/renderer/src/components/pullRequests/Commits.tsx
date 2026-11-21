import { useState, type JSX } from 'react'
import type { PullRequestCommit, PullRequestDetail } from '@shared/types'
import { notify } from '../Notice'
import { Octicon } from './octicons'
import { Avatar, RelativeTime } from './parts'

/** "Commits on Nov 17, 2026", the day in this computer's time zone. */
const dayOf = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/** The Commits tab, as GitHub's: the commits by day, each a row with who and when, and its short sha to open or copy. */
export function Commits({ detail }: { detail: PullRequestDetail }): JSX.Element {
  const [copied, setCopied] = useState<string | null>(null)
  if (detail.commits.length === 0) {
    return (
      <div className="gh-blank">
        <Octicon name="git-commit" size={24} />
        <h3>No commits</h3>
      </div>
    )
  }
  const days: { day: string; commits: PullRequestCommit[] }[] = []
  for (const commit of detail.commits) {
    const day = dayOf(commit.at)
    const last = days[days.length - 1]
    if (last?.day === day) last.commits.push(commit)
    else days.push({ day, commits: [commit] })
  }
  const open = (oid: string): void => void window.api.app.openExternal(`${detail.url}/commits/${oid}`)
  return (
    <div className="gh-commits">
      {days.map(({ day, commits }) => (
        <section key={day} className="gh-commits__day">
          <h3 className="gh-commits__heading">
            <span className="gh-commits__dot">
              <Octicon name="git-commit" />
            </span>
            Commits on {day}
          </h3>
          <ul className="gh-box gh-commits__list">
            {commits.map((commit) => (
              <li key={commit.oid} className="gh-commit">
                <div className="gh-commit__main">
                  <button type="button" className="gh-commit__title" title={commit.headline} onClick={() => open(commit.oid)}>
                    {commit.headline}
                  </button>
                  <div className="gh-commit__meta">
                    <Avatar login={commit.author} size={16} />
                    <strong className="gh-who">{commit.author}</strong> committed <RelativeTime iso={commit.at} />
                  </div>
                </div>
                <div className="gh-commit__tools">
                  <button type="button" className="gh-btn gh-btn--sm gh-btn--mono" title="View commit details" onClick={() => open(commit.oid)}>
                    {commit.oid.slice(0, 7)}
                  </button>
                  <button
                    type="button"
                    className="gh-btn gh-btn--sm gh-btn--icon"
                    aria-label="Copy full SHA"
                    title={copied === commit.oid ? 'Copied!' : 'Copy full SHA'}
                    onClick={() => {
                      void navigator.clipboard.writeText(commit.oid).then(
                        () => setCopied(commit.oid),
                        () => notify('Couldn’t copy the SHA.', 'error')
                      )
                    }}
                  >
                    <Octicon name={copied === commit.oid ? 'check' : 'copy'} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
