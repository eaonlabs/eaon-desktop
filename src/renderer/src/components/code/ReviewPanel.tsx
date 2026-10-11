import { Fragment, useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { ChevronRight, ExternalLink, GitPullRequest, Loader2, MessageSquarePlus, RefreshCw, Send, X } from 'lucide-react'
import { Code } from '../agent/FileDiff'
import { Select } from '../ui'
import { notify } from '../Notice'
import { useCode } from './codeStore'
import { useAdeSessions } from './sessionsStore'
import { terminals } from './terminal/registry'
import { useTerminals } from './terminal/terminalStore'
import { formatReviewComments, type ReviewAction, type ReviewComment, type ReviewFile, type ReviewLine, type ReviewResult } from '@shared/adeReview'
import { sessionTitle } from '@shared/adeSessions'

/**
 * The ADE's review panel, beside the terminals: what the session's agents
 * changed since its branch left the default branch, line comments sent back to
 * an agent as one message, and commit → push → pull request → merge, without
 * leaving the app (main/features/ade/review.ts does the git and gh).
 */

interface ReviewStore {
  open: boolean
  toggle: () => void
  close: () => void
  /** Comments not yet sent, per session folder. */
  comments: Record<string, ReviewComment[]>
  addComment: (cwd: string, comment: ReviewComment) => void
  removeComment: (cwd: string, id: string) => void
  clearComments: (cwd: string) => void
}

export const useReview = create<ReviewStore>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
  comments: {},
  addComment: (cwd, comment) => set((s) => ({ comments: { ...s.comments, [cwd]: [...(s.comments[cwd] ?? []), comment] } })),
  removeComment: (cwd, id) => set((s) => ({ comments: { ...s.comments, [cwd]: (s.comments[cwd] ?? []).filter((c) => c.id !== id) } })),
  clearComments: (cwd) => set((s) => ({ comments: { ...s.comments, [cwd]: [] } }))
}))

const NO_COMMENTS: ReviewComment[] = []
/** A file this big starts folded: opening it is a choice. */
const FOLD_OVER = 400

/** The top bar's Review button. */
export function ReviewButton(): JSX.Element | null {
  const cwd = useCode((s) => s.cwd)
  const { open, toggle } = useReview(useShallow((s) => ({ open: s.open, toggle: s.toggle })))
  const pending = useReview((s) => (cwd ? (s.comments[cwd]?.length ?? 0) : 0))
  if (!cwd) return null
  return (
    <button type="button" className="header-btn review-btn" data-open={open || undefined} aria-pressed={open} onClick={toggle} title="Review this session’s changes">
      <GitPullRequest size={14} strokeWidth={2} />
      <span>Review</span>
      {pending > 0 && <span className="review-btn__count">{pending}</span>}
    </button>
  )
}

const STATUS_MARK: Record<ReviewFile['status'], string> = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R' }

export function ReviewPanel({ cwd }: { cwd: string }): JSX.Element {
  const close = useReview((s) => s.close)
  const comments = useReview((s) => s.comments[cwd] ?? NO_COMMENTS)
  const { addComment, removeComment, clearComments } = useReview(
    useShallow((s) => ({ addComment: s.addComment, removeComment: s.removeComment, clearComments: s.clearComments }))
  )
  const session = useAdeSessions((s) => s.sessions.find((x) => x.cwd === cwd))
  const panes = useTerminals((s) => s.layout[cwd])
  const agentPanes = useMemo(() => (panes ?? []).filter((p) => p.agent !== 'shell'), [panes])

  const [result, setResult] = useState<ReviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [commenting, setCommenting] = useState<{ path: string; line: ReviewLine } | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState('')
  const [pr, setPr] = useState({ title: '', body: '', draft: false })
  const [method, setMethod] = useState<'squash' | 'merge' | 'rebase'>('squash')
  const [target, setTarget] = useState<string>('')
  /** Merge asks once more before it goes: the first click arms it for a few seconds. */
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(timer)
  }, [armed])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setResult(await window.api.ade.review(cwd))
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }, [cwd])

  // Again when the session changes, and when Eaon comes back to the front (files may have changed elsewhere).
  useEffect(() => {
    setResult(null)
    setFolded({})
    setCommenting(null)
    void load()
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  useEffect(() => {
    if (session) setPr((p) => (p.title ? p : { ...p, title: sessionTitle(session) }))
  }, [session])

  useEffect(() => {
    if (!agentPanes.some((p) => p.id === target)) setTarget(agentPanes[0]?.id ?? '')
  }, [agentPanes, target])

  const act = async (label: string, run: () => Promise<ReviewAction>, after?: () => void): Promise<void> => {
    setBusy(label)
    try {
      const res = await run()
      if (res.ok) {
        notify(res.message ?? 'Done.')
        if (res.url) void window.api.app.openExternal(res.url)
        after?.()
      } else notify(res.error, 'error')
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(null)
      void load()
    }
  }

  const send = (): void => {
    const pane = agentPanes.find((p) => p.id === target)
    if (!pane || comments.length === 0) return
    terminals.insertText(pane.id, formatReviewComments(comments))
    // Submitted as one message once the paste has landed; only ever into an agent, never a shell.
    window.setTimeout(() => terminals.send(pane.id, '\r'), 150)
    terminals.focus(pane.id)
    clearComments(cwd)
    notify(`Sent ${comments.length === 1 ? 'the comment' : `${comments.length} comments`} to ${pane.name}.`)
  }

  const state = result?.ok ? result.state : null
  const totals = state ? state.files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 }) : null

  return (
    <aside className="review" aria-label="Review">
      <header className="review__head">
        <div className="review__title">
          <span>Review</span>
          {state && (
            <span className="review__branch" title={`Changes on ${state.branch ?? 'this commit'} since ${state.base}`}>
              {state.branch ?? 'detached HEAD'}
              {state.base !== 'HEAD' ? ` → ${state.base.replace(/^origin\//, '')}` : ' · uncommitted'}
            </span>
          )}
        </div>
        <button type="button" className="icon-btn" aria-label="Look again" title="Look again" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={14} strokeWidth={2} className={loading ? 'spinner' : undefined} />
        </button>
        <button type="button" className="icon-btn" aria-label="Close review" onClick={close}>
          <X size={15} strokeWidth={2} />
        </button>
      </header>

      <div className="review__scroll">
        {!result && (
          <div className="review__empty">
            <Loader2 size={16} className="spinner" /> Looking at the changes…
          </div>
        )}
        {result && !result.ok && <div className="review__empty review__empty--error">{result.error}</div>}

        {state && (
          <>
            {/* Pull request */}
            <section className="review__section">
              {state.github === null ? (
                <p className="review__muted">{state.githubProblem}</p>
              ) : state.github.pr ? (
                <div className="review-pr" data-state={state.github.pr.state}>
                  <button type="button" className="review-pr__title" onClick={() => void window.api.app.openExternal(state.github!.pr!.url)}>
                    <span className="review-pr__num">#{state.github.pr.number}</span>
                    <span className="review-pr__name">{state.github.pr.title}</span>
                    <ExternalLink size={13} strokeWidth={2} />
                  </button>
                  <div className="review-pr__meta">
                    <span className="review-pr__badge">{state.github.pr.draft && state.github.pr.state === 'OPEN' ? 'Draft' : state.github.pr.state.toLowerCase()}</span>
                    {state.github.pr.checks.passed + state.github.pr.checks.failed + state.github.pr.checks.pending > 0 && (
                      <span className="review-pr__checks">
                        {state.github.pr.checks.failed > 0 && <span className="review-pr__fail">{state.github.pr.checks.failed} failing</span>}
                        {state.github.pr.checks.pending > 0 && <span>{state.github.pr.checks.pending} running</span>}
                        {state.github.pr.checks.passed > 0 && <span className="review-pr__pass">{state.github.pr.checks.passed} passed</span>}
                      </span>
                    )}
                    {state.github.pr.reviewDecision && <span>{state.github.pr.reviewDecision.replace(/_/g, ' ').toLowerCase()}</span>}
                    {state.github.pr.mergeState === 'DIRTY' && <span className="review-pr__fail">has conflicts</span>}
                  </div>
                  {state.github.pr.state === 'OPEN' && (
                    <div className="review__actions">
                      {(state.upstream === null || state.upstream.ahead > 0) && (
                        <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => void act('push', () => window.api.ade.push(cwd))}>
                          {busy === 'push' ? 'Pushing…' : 'Push commits'}
                        </button>
                      )}
                      <Select value={method} width={120} options={[{ value: 'squash', label: 'Squash' }, { value: 'merge', label: 'Merge commit' }, { value: 'rebase', label: 'Rebase' }]} onChange={setMethod} />
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={busy !== null || state.github.pr.draft}
                        title={state.github.pr.draft ? 'A draft can’t be merged; mark it ready on GitHub first' : undefined}
                        onClick={() => {
                          if (!armed) return setArmed(true)
                          setArmed(false)
                          void act('merge', () => window.api.ade.merge(cwd, method))
                        }}
                      >
                        {busy === 'merge' ? 'Merging…' : armed ? `Merge into ${state.base.replace(/^origin\//, '')}?` : 'Merge'}
                      </button>
                    </div>
                  )}
                </div>
              ) : state.ahead === 0 && state.uncommitted === 0 ? (
                <p className="review__muted">Nothing on this branch yet to open a pull request for.</p>
              ) : state.base === 'HEAD' ? (
                <p className="review__muted">This is the default branch. Start a session on a branch of its own to open a pull request.</p>
              ) : (
                <form
                  className="review-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void act('pr', () => window.api.ade.createPr(cwd, pr))
                  }}
                >
                  <div className="review__label">Pull request</div>
                  <input className="input" placeholder="Title" value={pr.title} onChange={(e) => setPr({ ...pr, title: e.target.value })} />
                  <textarea className="input review-form__body" placeholder="What it changes and why (optional)" rows={3} value={pr.body} onChange={(e) => setPr({ ...pr, body: e.target.value })} />
                  <div className="review__actions">
                    <label className="review__check">
                      <input type="checkbox" checked={pr.draft} onChange={(e) => setPr({ ...pr, draft: e.target.checked })} /> Draft
                    </label>
                    <button
                      type="submit"
                      className="btn btn--primary btn--sm"
                      disabled={busy !== null || !pr.title.trim() || state.ahead === 0}
                      title={state.ahead === 0 ? 'Commit the changes first' : undefined}
                    >
                      {busy === 'pr' ? 'Opening…' : 'Push and open pull request'}
                    </button>
                  </div>
                  {state.ahead === 0 && <p className="review__muted">Commit the changes below first.</p>}
                </form>
              )}
            </section>

            {/* Commit */}
            {state.uncommitted > 0 && (
              <form
                className="review__section review-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  void act('commit', () => window.api.ade.commit(cwd, message), () => setMessage(''))
                }}
              >
                <div className="review__label">
                  {state.uncommitted} {state.uncommitted === 1 ? 'file' : 'files'} not committed
                </div>
                <textarea
                  className="input review-form__body"
                  placeholder="Commit message"
                  rows={2}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
                  }}
                />
                <div className="review__actions">
                  <button type="submit" className="btn btn--sm" disabled={busy !== null || !message.trim()}>
                    {busy === 'commit' ? 'Committing…' : 'Commit all'}
                  </button>
                </div>
              </form>
            )}
            {state.uncommitted === 0 && state.github === null && state.ahead > 0 && (state.upstream === null || state.upstream.ahead > 0) && (
              <section className="review__section review__actions">
                <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => void act('push', () => window.api.ade.push(cwd))}>
                  {busy === 'push' ? 'Pushing…' : 'Push'}
                </button>
              </section>
            )}

            {/* Files */}
            <div className="review__files-head">
              {state.files.length === 0 ? (
                'No changes'
              ) : (
                <>
                  {state.files.length} {state.files.length === 1 ? 'file' : 'files'}
                  <span className="review__add">+{totals?.added}</span>
                  <span className="review__del">−{totals?.removed}</span>
                </>
              )}
            </div>
            {state.files.map((file) => {
              const isFolded = folded[file.path] ?? file.added + file.removed > FOLD_OVER
              const here = comments.filter((c) => c.path === file.path)
              return (
                <div key={file.path} className="review-file">
                  <button type="button" className="review-file__head" aria-expanded={!isFolded} onClick={() => setFolded({ ...folded, [file.path]: !isFolded })}>
                    <ChevronRight size={13} strokeWidth={2} className="review-file__chev" data-open={!isFolded || undefined} />
                    <span className="review-file__status" data-status={file.status}>
                      {STATUS_MARK[file.status]}
                    </span>
                    <span className="review-file__path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                      {file.path}
                    </span>
                    {here.length > 0 && <span className="review-file__comments">{here.length}</span>}
                    <span className="review__add">+{file.added}</span>
                    <span className="review__del">−{file.removed}</span>
                  </button>
                  {!isFolded &&
                    (file.binary ? (
                      <p className="review__muted review-file__note">A binary file: nothing to show line by line.</p>
                    ) : (
                      <div className="diff review-diff" data-numbered>
                        <div className="diff__body">
                          <div className="diff__lines">
                            {file.hunks.map((hunk, h) => (
                              <Fragment key={h}>
                                <div className="review-diff__hunk">{hunk.header}</div>
                                {hunk.lines.map((line, i) => {
                                  const at = line.cur ?? line.old ?? 0
                                  const side = line.cur === null ? 'old' : 'new'
                                  const onLine = here.filter((c) => c.line === at && c.side === side)
                                  const editing = commenting?.path === file.path && commenting.line === line
                                  return (
                                    <Fragment key={i}>
                                      <div
                                        className="diff__row review-diff__row"
                                        data-kind={line.kind}
                                        role="button"
                                        tabIndex={-1}
                                        title="Comment on this line"
                                        onClick={() => {
                                          setCommenting({ path: file.path, line })
                                          setDraft('')
                                        }}
                                      >
                                        <span className="diff__ln diff__ln--old">{line.old ?? ''}</span>
                                        <span className="diff__ln diff__ln--new">{line.cur ?? ''}</span>
                                        <span className="diff__sign" aria-hidden>
                                          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
                                        </span>
                                        <Code text={line.text || ' '} />
                                        <MessageSquarePlus size={13} strokeWidth={2} className="review-diff__plus" aria-hidden />
                                      </div>
                                      {onLine.map((c) => (
                                        <div key={c.id} className="review-comment">
                                          <span className="review-comment__body">{c.body}</span>
                                          <button type="button" className="icon-btn" aria-label="Delete comment" onClick={() => removeComment(cwd, c.id)}>
                                            <X size={13} strokeWidth={2} />
                                          </button>
                                        </div>
                                      ))}
                                      {editing && (
                                        <form
                                          className="review-comment review-comment--draft"
                                          onSubmit={(e) => {
                                            e.preventDefault()
                                            if (!draft.trim()) return
                                            addComment(cwd, {
                                              id: `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                                              path: file.path,
                                              line: at,
                                              side,
                                              quote: line.text,
                                              body: draft.trim()
                                            })
                                            setCommenting(null)
                                            setDraft('')
                                          }}
                                        >
                                          <textarea
                                            autoFocus
                                            className="input"
                                            rows={2}
                                            placeholder={`What should change on line ${at}?`}
                                            value={draft}
                                            onChange={(e) => setDraft(e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Escape') setCommenting(null)
                                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
                                            }}
                                          />
                                          <div className="review__actions">
                                            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCommenting(null)}>
                                              Cancel
                                            </button>
                                            <button type="submit" className="btn btn--primary btn--sm" disabled={!draft.trim()}>
                                              Add comment
                                            </button>
                                          </div>
                                        </form>
                                      )}
                                    </Fragment>
                                  )
                                })}
                              </Fragment>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              )
            })}
          </>
        )}
      </div>

      {comments.length > 0 && (
        <footer className="review__foot">
          <span className="review__foot-count">
            {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
          </span>
          {agentPanes.length > 0 ? (
            <>
              <Select value={target} width={150} options={agentPanes.map((p) => ({ value: p.id, label: p.name }))} onChange={setTarget} />
              <button type="button" className="btn btn--primary btn--sm" onClick={send}>
                <Send size={13} strokeWidth={2} />
                Send to agent
              </button>
            </>
          ) : (
            <span className="review__muted">Start an agent in this session to send them to it.</span>
          )}
        </footer>
      )}
    </aside>
  )
}
