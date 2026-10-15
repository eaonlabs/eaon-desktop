import { useState, type JSX } from 'react'
import { CircleCheck, CircleMinus, CircleX, ExternalLink, Loader2, Send } from 'lucide-react'
import { actionsRunOf, formatCheckFailure, type ReviewCheck, type ReviewLog } from '@shared/adeReview'

/**
 * CI in the review panel: a pull request's checks (or, before there is one,
 * the branch's latest workflow runs), failing ones first. A failed GitHub
 * Actions check's log can be read here, the end of it, and sent to an agent
 * to fix (main/features/ade/review.ts fetches it with `gh run view`).
 */

const ICON = { passed: CircleCheck, failed: CircleX, pending: Loader2, skipped: CircleMinus } as const
/** More checks than this show the failing ones and a "show all". */
const SHOW = 6

export function ReviewChecks({
  cwd,
  checks,
  title,
  send
}: {
  cwd: string
  checks: ReviewCheck[]
  title: string
  /** Sends a message to the chosen agent; false when there is none to send it to. */
  send: (text: string, what: string) => boolean
}): JSX.Element | null {
  const [logs, setLogs] = useState<Record<string, ReviewLog | 'loading'>>({})
  const [all, setAll] = useState(false)
  if (checks.length === 0) return null

  const failing = checks.filter((c) => c.status === 'failed').length
  const shown = all || checks.length <= SHOW ? checks : checks.slice(0, Math.max(SHOW, failing))
  const keyOf = (c: ReviewCheck, i: number): string => `${c.name}|${c.url ?? i}`

  const viewLog = async (check: ReviewCheck, key: string): Promise<void> => {
    if (logs[key] && logs[key] !== 'loading') {
      // A second click hides it.
      const { [key]: _gone, ...rest } = logs
      setLogs(rest)
      return
    }
    setLogs((l) => ({ ...l, [key]: 'loading' }))
    let res: ReviewLog
    try {
      res = await window.api.ade.checkLog(cwd, { url: check.url, name: check.name, workflow: check.workflow })
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    setLogs((l) => ({ ...l, [key]: res }))
  }

  return (
    <div className="review-checks">
      <div className="review__label">{title}</div>
      {shown.map((check, i) => {
        const key = keyOf(check, i)
        const Icon = ICON[check.status]
        const log = logs[key]
        // A log can be fetched for an Actions run, or by workflow name when the link doesn't say which run.
        const readable = check.status === 'failed' && (actionsRunOf(check.url) !== null || !check.url)
        return (
          <div key={key} className="review-check" data-status={check.status}>
            <div className="review-check__row">
              <Icon size={14} strokeWidth={2} className={check.status === 'pending' ? 'review-check__icon spinner' : 'review-check__icon'} />
              <span className="review-check__name" title={check.workflow && check.workflow !== check.name ? `${check.workflow} › ${check.name}` : check.name}>
                {check.name}
              </span>
              <span className="review-check__status">{check.status === 'pending' ? 'running' : check.status}</span>
              {readable && (
                <button type="button" className="btn btn--ghost btn--sm" disabled={log === 'loading'} onClick={() => void viewLog(check, key)}>
                  {log === 'loading' ? 'Fetching…' : log ? 'Hide log' : 'View log'}
                </button>
              )}
              {check.url && (
                <button type="button" className="icon-btn" aria-label={`Open ${check.name}`} title="Open its run" onClick={() => void window.api.app.openExternal(check.url!)}>
                  <ExternalLink size={13} strokeWidth={2} />
                </button>
              )}
            </div>
            {log && log !== 'loading' && !log.ok && <p className="review__muted review-check__error">{log.error}</p>}
            {log && log !== 'loading' && log.ok && (
              <>
                <pre className="review-log" tabIndex={0} aria-label={`The end of ${check.name}’s log`}>
                  {log.truncated && <span className="review-log__cut">Earlier lines cut. The last 200 are below.{'\n'}</span>}
                  {log.log}
                </pre>
                <div className="review__actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => send(formatCheckFailure(check, log.log, log.truncated), `the ${check.name} failure`)}
                  >
                    <Send size={13} strokeWidth={2} />
                    Send to agent
                  </button>
                </div>
              </>
            )}
          </div>
        )
      })}
      {shown.length < checks.length && (
        <button type="button" className="review-checks__more" onClick={() => setAll(true)}>
          Show all {checks.length}
        </button>
      )}
    </div>
  )
}
