import { useState, type JSX } from 'react'
import { Loader2, MessageSquareText, Send } from 'lucide-react'
import { feedbackMessage, openThreads, type PrFeedback } from '@shared/prFeedback'

/**
 * What reviewers said on the pull request, in the review panel: read from
 * GitHub when asked, the threads still open listed by file and line, and all
 * of it sent to an agent to work through (shared/prFeedback.ts).
 */
export function ReviewFeedback({
  cwd,
  pr,
  send
}: {
  cwd: string
  pr: { number: number; title: string; url: string }
  /** Sends a message to the chosen agent; false when there is none to send it to. */
  send: (text: string, what: string) => boolean
}): JSX.Element {
  const [state, setState] = useState<{ loading: true } | { loading: false; error: string } | { loading: false; feedback: PrFeedback } | null>(null)

  const load = async (): Promise<void> => {
    setState({ loading: true })
    try {
      const res = await window.api.ade.prFeedback(cwd, pr.url)
      setState(res.ok ? { loading: false, feedback: { threads: res.threads, notes: res.notes } } : { loading: false, error: res.error })
    } catch (e) {
      setState({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const feedback = state && !state.loading && 'feedback' in state ? state.feedback : null
  const open = feedback ? openThreads(feedback.threads) : []
  const nothing = feedback !== null && open.length === 0 && feedback.notes.length === 0

  return (
    <div className="review-feedback">
      <div className="review__label">Reviewer comments</div>
      {!state && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()}>
          <MessageSquareText size={13} strokeWidth={2} />
          Read the reviewers’ comments
        </button>
      )}
      {state?.loading && (
        <p className="review__muted">
          <Loader2 size={13} className="spinner" /> Reading the comments…
        </p>
      )}
      {state && !state.loading && 'error' in state && (
        <p className="review__muted" role="alert">
          {state.error}{' '}
          <button type="button" className="link-btn" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
      {nothing && <p className="review__muted">No open comments from reviewers.</p>}
      {feedback && !nothing && (
        <>
          <ul className="review-feedback__list">
            {open.map((t, i) => (
              <li key={i} className="review-feedback__thread">
                <div className="review-feedback__where">
                  {t.path}
                  {t.line ? `:${t.line}` : ''}
                  {t.outdated ? ' · outdated' : ''}
                </div>
                <div className="review-feedback__body">
                  <strong>{t.comments[0].author}</strong>: {t.comments[0].body.slice(0, 280)}
                  {t.comments[0].body.length > 280 ? '…' : ''}
                  {t.comments.length > 1 && <span className="review__muted"> · {t.comments.length - 1} {t.comments.length === 2 ? 'reply' : 'replies'}</span>}
                </div>
              </li>
            ))}
            {feedback.notes.map((n, i) => (
              <li key={`n${i}`} className="review-feedback__thread">
                <div className="review-feedback__where">{n.state === 'CHANGES_REQUESTED' ? 'Asked for changes' : 'Review'}</div>
                <div className="review-feedback__body">
                  <strong>{n.author}</strong>: {n.body.slice(0, 280)}
                  {n.body.length > 280 ? '…' : ''}
                </div>
              </li>
            ))}
          </ul>
          <div className="review__actions">
            <button type="button" className="btn btn--sm" onClick={() => send(feedbackMessage(feedback, pr), 'the reviewers’ comments')}>
              <Send size={13} strokeWidth={2} />
              Send to agent
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()}>
              Read again
            </button>
          </div>
        </>
      )}
    </div>
  )
}
