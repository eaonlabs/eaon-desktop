import { useState, type JSX, type ReactNode } from 'react'
import type { PullRequestAction, PullRequestComment, PullRequestCommit, PullRequestDetail, PullRequestSummary } from '@shared/types'
import { Markdown } from '../agent/Markdown'
import { PrReviewPanel } from '../PrReviewPanel'
import { Octicon, type OcticonName } from './octicons'
import { Avatar, BranchRef, GhLabel, RelativeTime, associationLabel, errorText, stateKey } from './parts'
import { MergeBox } from './MergeBox'

/**
 * The Conversation tab, laid out as GitHub's: the description and every
 * comment as speech bubbles from their authors' pictures, reviews, pushes and
 * the merge as small marks on the line between them, then the merge box and
 * a comment box; reviewers, assignees, labels and the milestone down the side.
 */
export function Conversation({
  pr,
  detail,
  after,
  onTab
}: {
  pr: PullRequestSummary
  detail: PullRequestDetail
  after: (result: PullRequestAction) => void
  onTab: (tab: 'commits') => void
}): JSX.Element {
  return (
    <div className="gh-conversation">
      <div className="gh-discussion">
        <CommentBox author={detail.author} association="" body={detail.body} at={detail.createdAt} byAuthor opening />
        {timeline(detail).map((event, i) =>
          event.kind === 'comment' ? (
            <Comment key={i} comment={event.comment} prAuthor={detail.author} />
          ) : event.kind === 'commits' ? (
            <Pushed key={i} commits={event.commits} url={detail.url} onMore={() => onTab('commits')} />
          ) : (
            <Badge key={i} icon="git-merge" tone="done">
              <Who login={detail.mergedBy ?? detail.author} /> merged commit{' '}
              {detail.mergeCommit && <code className="gh-sha">{detail.mergeCommit.slice(0, 7)}</code>} into <BranchRef name={detail.base} />{' '}
              {detail.mergedAt && <RelativeTime iso={detail.mergedAt} />}
            </Badge>
          )
        )}
        {detail.state === 'closed' && detail.closedAt && (
          <Badge icon="git-pull-request-closed" tone="danger">
            This was closed <RelativeTime iso={detail.closedAt} />
          </Badge>
        )}

        {/* Eaon's own: an agent's review of it, written in the ADE and posted from here. */}
        <div className="gh-tl-extra">
          <PrReviewPanel pr={pr} />
        </div>

        <div className="gh-discussion__end">
          <MergeBox detail={detail} after={after} />
          <NewComment detail={detail} after={after} />
        </div>
      </div>
      <Sidebar detail={detail} after={after} />
    </div>
  )
}

type TimelineEvent = { kind: 'comment'; at: string; comment: PullRequestComment } | { kind: 'commits'; at: string; commits: PullRequestCommit[] } | { kind: 'merged'; at: string }

/** Comments, reviews and pushes in the order they happened; commits in a row between them make one push. */
function timeline(d: PullRequestDetail): TimelineEvent[] {
  const events: TimelineEvent[] = [
    ...d.comments.map((comment): TimelineEvent => ({ kind: 'comment', at: comment.at, comment })),
    ...d.commits.map((commit): TimelineEvent => ({ kind: 'commits', at: commit.at, commits: [commit] }))
  ].sort((a, b) => a.at.localeCompare(b.at))
  const merged: TimelineEvent[] = []
  for (const event of events) {
    const last = merged[merged.length - 1]
    if (event.kind === 'commits' && last?.kind === 'commits') last.commits.push(...event.commits)
    else merged.push(event)
  }
  if (stateKey(d.state) === 'merged') merged.push({ kind: 'merged', at: d.mergedAt ?? d.updatedAt })
  return merged
}

function Who({ login }: { login: string }): JSX.Element {
  return <strong className="gh-who">{login || 'Someone'}</strong>
}

/** A mark on the line: an icon in a circle and what happened beside it. */
function Badge({ icon, tone, children }: { icon: OcticonName; tone?: 'done' | 'success' | 'danger' | 'attention'; children: ReactNode }): JSX.Element {
  return (
    <div className="gh-tl-item">
      <span className="gh-tl-badge" data-tone={tone}>
        <Octicon name={icon} />
      </span>
      <div className="gh-tl-body">{children}</div>
    </div>
  )
}

/** How many commits a push lists before it points to the Commits tab. */
const PUSH_ROWS = 12

function Pushed({ commits, url, onMore }: { commits: PullRequestCommit[]; url: string; onMore: () => void }): JSX.Element {
  const authors = [...new Set(commits.map((c) => c.author))]
  const shown = commits.slice(0, PUSH_ROWS)
  return (
    <>
      <Badge icon="repo-push">
        <Who login={authors.length === 1 ? authors[0] : authors.join(', ')} /> added {commits.length} {commits.length === 1 ? 'commit' : 'commits'} <RelativeTime iso={commits[commits.length - 1].at} />
      </Badge>
      <div className="gh-tl-commits">
        {shown.map((commit) => (
          <div key={commit.oid} className="gh-tl-commit">
            <Octicon name="git-commit" className="octicon gh-tl-commit__icon" />
            <Avatar login={commit.author} size={16} />
            <button type="button" className="gh-tl-commit__msg" title={commit.headline} onClick={() => void window.api.app.openExternal(`${url}/commits/${commit.oid}`)}>
              {commit.headline}
            </button>
            <code className="gh-sha">{commit.oid.slice(0, 7)}</code>
          </div>
        ))}
        {commits.length > shown.length && (
          <button type="button" className="gh-link gh-tl-commits__more" onClick={onMore}>
            {commits.length - shown.length} more {commits.length - shown.length === 1 ? 'commit' : 'commits'}
          </button>
        )}
      </div>
    </>
  )
}

const REVIEW_SAID: Record<string, { icon: OcticonName; tone?: 'success' | 'danger'; words: string }> = {
  APPROVED: { icon: 'check', tone: 'success', words: 'approved these changes' },
  CHANGES_REQUESTED: { icon: 'file-diff', tone: 'danger', words: 'requested changes' },
  DISMISSED: { icon: 'x', words: 'had a review dismissed' },
  COMMENTED: { icon: 'eye', words: 'reviewed' }
}

/** A comment, or a review: its mark on the line, then what it said, if anything. */
function Comment({ comment, prAuthor }: { comment: PullRequestComment; prAuthor: string }): JSX.Element {
  if (comment.review) {
    const said = REVIEW_SAID[comment.review] ?? REVIEW_SAID.COMMENTED
    return (
      <>
        <Badge icon={said.icon} tone={said.tone}>
          <Avatar login={comment.author} size={20} /> <Who login={comment.author} /> {said.words} <RelativeTime iso={comment.at} />
        </Badge>
        {comment.body.trim() && <CommentBox author={comment.author} association={comment.association} body={comment.body} at={comment.at} byAuthor={comment.author === prAuthor} nested />}
      </>
    )
  }
  return <CommentBox author={comment.author} association={comment.association} body={comment.body} at={comment.at} byAuthor={comment.author === prAuthor} />
}

/** A speech bubble: the picture outside it, a header with who and when, the Markdown under that. */
function CommentBox({ author, association, body, at, byAuthor, opening, nested }: { author: string; association: string; body: string; at: string; byAuthor?: boolean; opening?: boolean; nested?: boolean }): JSX.Element {
  const role = associationLabel(association)
  return (
    <div className="gh-tl-comment" data-nested={nested || undefined}>
      {!nested && (
        <span className="gh-tl-comment__avatar">
          <Avatar login={author} size={40} />
        </span>
      )}
      <div className="gh-comment" data-author={byAuthor || undefined}>
        <div className="gh-comment__head">
          <span className="gh-comment__inline-avatar">
            <Avatar login={author} size={20} />
          </span>
          <span className="gh-comment__who">
            <Who login={author} /> {opening ? 'opened this' : 'commented'} <RelativeTime iso={at} />
          </span>
          {byAuthor && !opening && <span className="gh-role">Author</span>}
          {role && <span className="gh-role">{role}</span>}
        </div>
        <div className="gh-comment__body gh-markdown">{body.trim() ? <Markdown text={body} /> : <p className="gh-muted gh-italic">No description provided.</p>}</div>
      </div>
    </div>
  )
}

/** "Add a comment": GitHub's box, with closing or reopening at the foot, as there. */
function NewComment({ detail, after }: { detail: PullRequestDetail; after: (result: PullRequestAction) => void }): JSX.Element {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const state = stateKey(detail.state)

  const act = async (label: string, job: () => Promise<PullRequestAction>, clear = false): Promise<void> => {
    setBusy(label)
    try {
      const result = await job()
      if (result.ok && clear) {
        setText('')
        setPreview(false)
      }
      after(result)
    } catch (e) {
      after({ ok: false, error: errorText(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="gh-new-comment">
      <h3 className="gh-new-comment__title">Add a comment</h3>
      <div className="gh-comment gh-editor">
        <div className="gh-editor__tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!preview} data-active={!preview || undefined} onClick={() => setPreview(false)}>
            Write
          </button>
          <button type="button" role="tab" aria-selected={preview} data-active={preview || undefined} onClick={() => setPreview(true)}>
            Preview
          </button>
        </div>
        <div className="gh-editor__body">
          {preview ? (
            <div className="gh-markdown gh-editor__preview">{text.trim() ? <Markdown text={text} /> : <p className="gh-muted">Nothing to preview</p>}</div>
          ) : (
            <textarea
              className="gh-input gh-editor__text"
              aria-label="Comment"
              placeholder="Use Markdown to format your comment"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !busy) void act('comment', () => window.api.github.comment(detail.url, text), true)
              }}
            />
          )}
          <div className="gh-editor__foot">
            <span className="gh-muted gh-editor__hint">
              <Octicon name="file-diff" size={14} /> Markdown is supported
            </span>
            <span className="gh-editor__actions">
              {state === 'closed' ? (
                <button type="button" className="gh-btn" disabled={busy !== null} onClick={() => void act('reopen', () => window.api.github.act(detail.url, 'reopen'))}>
                  <Octicon name="git-pull-request" className="octicon gh-success" />
                  {busy === 'reopen' ? 'Reopening…' : 'Reopen pull request'}
                </button>
              ) : (
                state !== 'merged' && (
                  <button type="button" className="gh-btn" disabled={busy !== null} onClick={() => void act('close', () => window.api.github.act(detail.url, 'close'))}>
                    <Octicon name="git-pull-request-closed" className="octicon gh-danger" />
                    {busy === 'close' ? 'Closing…' : 'Close pull request'}
                  </button>
                )
              )}
              <button type="button" className="gh-btn gh-btn--primary" disabled={!text.trim() || busy !== null} onClick={() => void act('comment', () => window.api.github.comment(detail.url, text), true)}>
                {busy === 'comment' ? 'Commenting…' : 'Comment'}
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

const REVIEWER_MARK: Record<string, { icon: OcticonName; tone: string; title: string }> = {
  APPROVED: { icon: 'check', tone: 'success', title: 'Approved these changes' },
  CHANGES_REQUESTED: { icon: 'file-diff', tone: 'danger', title: 'Requested changes' },
  COMMENTED: { icon: 'comment', tone: 'muted', title: 'Left review comments' },
  DISMISSED: { icon: 'x', tone: 'muted', title: 'Review dismissed' }
}

/** Down the right: who reviews it, who it's assigned to, its labels and milestone, as GitHub's sidebar. */
function Sidebar({ detail, after }: { detail: PullRequestDetail; after: (result: PullRequestAction) => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const reviewed = new Set(detail.reviews.map((r) => r.author))
  const waiting = detail.reviewRequests.filter((who) => !reviewed.has(who))
  return (
    <aside className="gh-sidebar" aria-label="About this pull request">
      <section className="gh-sidebar__item">
        <h3 className="gh-sidebar__heading">Reviewers</h3>
        {detail.reviews.length === 0 && waiting.length === 0 ? (
          <p className="gh-muted">No reviews</p>
        ) : (
          <ul className="gh-sidebar__people">
            {detail.reviews.map((r) => {
              const mark = REVIEWER_MARK[r.state] ?? REVIEWER_MARK.COMMENTED
              return (
                <li key={r.author} data-state={r.state}>
                  <Avatar login={r.author} size={20} />
                  <span className="gh-sidebar__name">{r.author}</span>
                  <span className="gh-sidebar__mark" data-tone={mark.tone} title={mark.title}>
                    <Octicon name={mark.icon} />
                    <span className="gh-sr-only">{mark.title}</span>
                  </span>
                </li>
              )
            })}
            {waiting.map((who) => (
              <li key={who} data-state="REQUESTED">
                <Avatar login={who} size={20} />
                <span className="gh-sidebar__name">{who}</span>
                <span className="gh-sidebar__mark" data-tone="attention" title="Awaiting requested review">
                  <Octicon name="dot-fill" />
                  <span className="gh-sr-only">Awaiting requested review</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {detail.state === 'open' && (
          <p className="gh-sidebar__aside">
            Still in progress?{' '}
            <button
              type="button"
              className="gh-link"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                window.api.github
                  .act(detail.url, 'draft')
                  .then(after, (e: unknown) => after({ ok: false, error: errorText(e) }))
                  .finally(() => setBusy(false))
              }}
            >
              {busy ? 'Converting…' : 'Convert to draft'}
            </button>
          </p>
        )}
      </section>
      <section className="gh-sidebar__item">
        <h3 className="gh-sidebar__heading">Assignees</h3>
        {detail.assignees.length === 0 ? (
          <p className="gh-muted">No one assigned</p>
        ) : (
          <ul className="gh-sidebar__people">
            {detail.assignees.map((who) => (
              <li key={who}>
                <Avatar login={who} size={20} />
                <span className="gh-sidebar__name">{who}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="gh-sidebar__item">
        <h3 className="gh-sidebar__heading">Labels</h3>
        {detail.labels.length === 0 ? (
          <p className="gh-muted">None yet</p>
        ) : (
          <div className="gh-sidebar__labels">
            {detail.labels.map((label) => (
              <GhLabel key={label.name} label={label} />
            ))}
          </div>
        )}
      </section>
      <section className="gh-sidebar__item">
        <h3 className="gh-sidebar__heading">Milestone</h3>
        <p className={detail.milestone ? 'gh-sidebar__text' : 'gh-muted'}>{detail.milestone ?? 'No milestone'}</p>
      </section>
    </aside>
  )
}
