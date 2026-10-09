import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, Sparkles, SquareTerminal, Trash2 } from 'lucide-react'
import type { PullRequestSummary } from '@shared/types'
import type { PrReview, ReviewEvent, ReviewState } from '@shared/prReview'
import { Segmented } from './ui'
import { notify } from './Notice'
import { useAdeSessions } from './code/sessionsStore'

const EVENTS: { value: ReviewEvent; label: string }[] = [
  { value: 'COMMENT', label: 'Comment' },
  { value: 'APPROVE', label: 'Approve' },
  { value: 'REQUEST_CHANGES', label: 'Request changes' }
]

/**
 * A pull request reviewed by an agent: Review checks it out as an ADE
 * session and starts Claude Code (or Codex) on it; what the agent writes
 * shows here, to read and edit, and goes to GitHub only from "Post review".
 */
export function PrReviewPanel({ pr }: { pr: PullRequestSummary }): JSX.Element | null {
  const [state, setState] = useState<ReviewState | null>(null)
  const [starting, setStarting] = useState(false)
  const [draft, setDraft] = useState<PrReview | null>(null)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const all = await window.api.prReview.list().catch(() => [] as ReviewState[])
    const mine = all.find((s) => s.target.url === pr.url) ?? null
    setState(mine)
    // The draft follows what the agent wrote until the person starts editing it.
    setDraft((d) => d ?? mine?.review ?? null)
  }, [pr.url])

  useEffect(() => {
    setState(null)
    setDraft(null)
    setError(null)
    void refresh()
  }, [pr.url, refresh])

  // While the agent works, look for its review every few seconds.
  const waiting = Boolean(state && !state.review && !state.postedUrl)
  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(timer)
  }, [waiting, refresh])

  if (pr.state !== 'open' && pr.state !== 'draft') return null

  const start = async (): Promise<void> => {
    setStarting(true)
    setError(null)
    const result = await window.api.prReview.start(pr.url)
    setStarting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setState(result.state)
    setDraft(null)
    const failed = await useAdeSessions.getState().startTask(await sessionOf(result.state), result.prompt)
    if (failed) notify(failed, 'error')
  }

  const post = async (): Promise<void> => {
    if (!draft) return
    setPosting(true)
    setError(null)
    const result = await window.api.prReview.post(pr.url, draft)
    setPosting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    notify('Review posted to GitHub.', 'done')
    void refresh()
  }

  const openSession = async (): Promise<void> => {
    if (!state) return
    await useAdeSessions.getState().show(await sessionOf(state))
  }

  return (
    <section className="pr-review">
      <div className="pr-review__head">
        <Sparkles size={15} strokeWidth={1.9} />
        <span className="pr-review__title">Agent review</span>
        {state && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void openSession()}>
            <SquareTerminal size={13} strokeWidth={1.9} />
            Open session
          </button>
        )}
      </div>

      {!state && (
        <>
          <p className="pr-review__text">
            Claude Code (or Codex) checks this pull request out in an ADE session of its own, reviews it, and writes a review you can edit here. Nothing is posted to GitHub until you
            choose to.
          </p>
          <button type="button" className="btn btn--accent" disabled={starting} onClick={() => void start()}>
            {starting ? <Loader2 size={14} strokeWidth={2} className="spinner" /> : <Sparkles size={14} strokeWidth={1.9} />}
            {starting ? 'Checking it out…' : 'Review'}
          </button>
        </>
      )}

      {state && !state.review && !state.postedUrl && (
        <p className="pr-review__text pr-review__waiting">
          <Loader2 size={14} strokeWidth={2} className="spinner" />
          The agent is reviewing it in the ADE. Its review shows here when it’s written.
        </p>
      )}

      {state?.postedUrl && (
        <p className="pr-review__text">
          Posted.{' '}
          <button type="button" className="link-btn" onClick={() => void window.api.app.openExternal(state.postedUrl!)}>
            See it on GitHub <ExternalLink size={12} strokeWidth={1.9} />
          </button>{' '}
          ·{' '}
          <button type="button" className="link-btn" onClick={() => void start()}>
            Review again
          </button>
        </p>
      )}

      {state && !state.postedUrl && draft && (
        <div className="pr-review__draft">
          <label className="pr-review__label" htmlFor="pr-review-summary">
            Summary
          </label>
          <textarea id="pr-review-summary" className="input pr-review__summary" value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
          {state.target.own ? (
            <p className="pr-review__fine">This is your own pull request, so it goes as a comment: GitHub doesn’t let you approve it or ask for changes.</p>
          ) : (
            <Segmented value={draft.event} options={EVENTS} onChange={(event) => setDraft({ ...draft, event })} />
          )}
          {draft.comments.length > 0 && <div className="pr-review__label">Line comments</div>}
          {draft.comments.map((c, i) => (
            <div key={`${c.path}:${c.line}:${i}`} className="pr-review__comment">
              <div className="pr-review__where">
                <code>
                  {c.path}:{c.line}
                </code>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Drop the comment on ${c.path} line ${c.line}`}
                  onClick={() => setDraft({ ...draft, comments: draft.comments.filter((_, j) => j !== i) })}
                >
                  <Trash2 size={13} strokeWidth={1.9} />
                </button>
              </div>
              <textarea
                className="input"
                value={c.body}
                onChange={(e) => setDraft({ ...draft, comments: draft.comments.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)) })}
              />
            </div>
          ))}
          <div className="pr-review__actions">
            <button type="button" className="btn btn--accent" disabled={posting} onClick={() => void post()}>
              {posting ? <Loader2 size={14} strokeWidth={2} className="spinner" /> : null}
              Post review to GitHub
            </button>
            <button type="button" className="btn btn--ghost" disabled={posting} onClick={() => void start()}>
              Review again
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="pr-review__error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/** The ADE session a review runs in, as the sidebar knows it. */
async function sessionOf(state: ReviewState): Promise<import('@shared/adeSessions').AdeSession> {
  const sessions = useAdeSessions.getState()
  if (!sessions.loaded) await sessions.load()
  const found = useAdeSessions.getState().sessions.find((s) => s.id === state.sessionId)
  if (found) return found
  await useAdeSessions.getState().load()
  return useAdeSessions.getState().sessions.find((s) => s.id === state.sessionId) ?? (await window.api.ade.sessions()).find((s) => s.id === state.sessionId)!
}
