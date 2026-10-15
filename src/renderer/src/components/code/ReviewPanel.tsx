import { Fragment, useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronRight, ExternalLink, GitPullRequest, Loader2, MessageSquarePlus, Pencil, RefreshCw, Send, X } from 'lucide-react'
import { Code } from '../agent/FileDiff'
import { Markdown } from '../agent/Markdown'
import { Segmented, Select } from '../ui'
import { notify } from '../Notice'
import { useCode } from './codeStore'
import { useAdeSessions } from './sessionsStore'
import { terminals } from './terminal/registry'
import { useTerminals } from './terminal/terminalStore'
import { useReview } from './reviewStore'
import { ReviewChecks } from './ReviewChecks'
import { ReviewConflicts } from './ReviewConflicts'
import {
  formatReviewComments,
  isRange,
  type ReviewAction,
  type ReviewComment,
  type ReviewFile,
  type ReviewLine,
  type ReviewResult
} from '@shared/adeReview'
import { sessionTitle } from '@shared/adeSessions'

/**
 * The ADE's review panel, beside the terminals: what the session's agents
 * changed since its branch left the default branch, Markdown comments on a
 * line or a run of lines sent back to an agent as one message, CI checks and
 * their logs, conflicts resolved, and commit → push → pull request → merge,
 * without leaving the app (main/features/ade/review.ts does the git and gh).
 */

export { useReview }

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

/**
 * Where a comment being written goes: by file, side and line numbers, never
 * by the line objects, which a fresh look at the diff (every time the window
 * comes to the front) replaces. `editing` is the comment it rewrites.
 */
interface Draft {
  path: string
  side: 'new' | 'old'
  line: number
  endLine?: number
  editing?: string
}

/** A row's number on one side: the new file's for added and unchanged lines, the old file's for removed and unchanged ones. */
const numOn = (line: ReviewLine, side: 'new' | 'old'): number | null => (side === 'new' ? line.cur : line.old)
/** The side a row is commented on when clicked: the old file only for a removed line. */
const sideOf = (line: ReviewLine): 'new' | 'old' => (line.cur === null ? 'old' : 'new')
/** The last line of a comment or draft: where it shows, under that row, as on GitHub. */
const lastLine = (c: { line: number; endLine?: number }): number => (isRange(c) ? Math.max(c.line, c.endLine!) : c.line)
const span = (c: { line: number; endLine?: number }): [number, number] => (isRange(c) ? [Math.min(c.line, c.endLine!), Math.max(c.line, c.endLine!)] : [c.line, c.line])

/** The text of a file's lines from `from` to `to` on one side, in order: what a range comment quotes. */
function linesBetween(file: ReviewFile, side: 'new' | 'old', from: number, to: number): string {
  const out: string[] = []
  for (const hunk of file.hunks) for (const l of hunk.lines) {
    const n = numOn(l, side)
    if (n !== null && n >= from && n <= to) out.push(l.text)
  }
  return out.join('\n')
}

const newId = (): string => `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export function ReviewPanel({ cwd }: { cwd: string }): JSX.Element {
  const close = useReview((s) => s.close)
  const comments = useReview((s) => s.comments[cwd] ?? NO_COMMENTS)
  const { addComment, updateComment, removeComment, clearComments } = useReview(
    useShallow((s) => ({ addComment: s.addComment, updateComment: s.updateComment, removeComment: s.removeComment, clearComments: s.clearComments }))
  )
  const session = useAdeSessions((s) => s.sessions.find((x) => x.cwd === cwd))
  const panes = useTerminals((s) => s.layout[cwd])
  const agentPanes = useMemo(() => (panes ?? []).filter((p) => p.agent !== 'shell'), [panes])

  const [result, setResult] = useState<ReviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [commenting, setCommenting] = useState<Draft | null>(null)
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState<'write' | 'preview'>('write')
  const [message, setMessage] = useState('')
  const [pr, setPr] = useState({ title: '', body: '', draft: false, base: '' })
  const [bases, setBases] = useState<{ default: string | null; branches: string[] } | null>(null)
  const [method, setMethod] = useState<'squash' | 'merge' | 'rebase'>('squash')
  const [target, setTarget] = useState<string>('')
  /** Merge, and clearing every comment, ask once more before they go: the first click arms them for a few seconds. */
  const [armed, setArmed] = useState<'merge' | 'clear' | null>(null)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(null), 4000)
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
  // A comment being written is kept through those: it is placed by line number, not by the old diff's rows.
  useEffect(() => {
    setResult(null)
    setFolded({})
    setCommenting(null)
    setDraft('')
    setBases(null)
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

  /** Types a message into the chosen agent and submits it; only ever into an agent, never a shell. */
  const sendToAgent = (text: string, what: string): boolean => {
    const pane = agentPanes.find((p) => p.id === target)
    if (!pane) {
      notify('Start an agent in this session to send it to.', 'error')
      return false
    }
    terminals.insertText(pane.id, text)
    // Submitted as one message once the paste has landed.
    window.setTimeout(() => terminals.send(pane.id, '\r'), 150)
    terminals.focus(pane.id)
    notify(`Sent ${what} to ${pane.name}.`)
    return true
  }

  const state = result?.ok ? result.state : null
  const totals = state ? state.files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 }) : null
  const baseName = state ? state.base.replace(/^origin\//, '') : ''
  /** Comments on files that are no longer in the diff: kept and shown until the user sends or clears. */
  const stale = useMemo(() => (state ? comments.filter((c) => !state.files.some((f) => f.path === c.path)) : NO_COMMENTS), [state, comments])

  const send = (): void => {
    const live = comments.filter((c) => !stale.includes(c))
    if (live.length === 0) {
      clearComments(cwd, stale.map((c) => c.id))
      notify('Those comments are on files no longer changed, so they were cleared.')
      return
    }
    const what = live.length === 1 ? 'the comment' : `${live.length} comments`
    if (!sendToAgent(formatReviewComments(live), what)) return
    // Sent, and the ones on files gone from the diff go with them, unsent: their lines aren't there to fix.
    clearComments(cwd)
    if (stale.length) notify(`Sent ${what}. ${stale.length === 1 ? 'One on a file' : `${stale.length} on files`} no longer changed ${stale.length === 1 ? 'was' : 'were'} left out and cleared.`)
  }

  /** Opens a comment on a row; shift-click on another row of the same file makes it a range. */
  const pick = (file: ReviewFile, line: ReviewLine, shift: boolean): void => {
    if (shift && commenting && commenting.path === file.path) {
      const n = numOn(line, commenting.side)
      if (n === null) return notify(commenting.side === 'new' ? 'A range runs over the new file’s lines; pick one that isn’t removed.' : 'A range of removed lines ends on another removed line.', 'error')
      setCommenting({ ...commenting, endLine: n === commenting.line ? undefined : n })
      return
    }
    // Moving a new comment keeps what was written; leaving an edit drops it (the comment is still there).
    if (commenting?.editing) setDraft('')
    setCommenting({ path: file.path, side: sideOf(line), line: numOn(line, sideOf(line))! })
    setPreview('write')
  }

  const edit = (c: ReviewComment): void => {
    setCommenting({ path: c.path, side: c.side, line: c.line, endLine: c.endLine, editing: c.id })
    setDraft(c.body)
    setPreview('write')
  }

  const cancel = (): void => {
    setCommenting(null)
    setDraft('')
  }

  const save = (file: ReviewFile): void => {
    if (!commenting || !draft.trim()) return
    const [from, to] = span(commenting)
    const quote = linesBetween(file, commenting.side, from, to)
    const range = isRange(commenting) ? { line: from, endLine: to } : { line: commenting.line, endLine: undefined }
    if (commenting.editing) updateComment(cwd, commenting.editing, { ...range, quote, body: draft.trim() })
    else addComment(cwd, { id: newId(), path: file.path, side: commenting.side, ...range, quote, body: draft.trim() })
    cancel()
  }

  // Branches the pull request could go into, once the form to open one shows.
  const canOpenPr = Boolean(state && state.github && !state.github.pr && state.base !== 'HEAD' && (state.ahead > 0 || state.uncommitted > 0))
  useEffect(() => {
    if (!canOpenPr || bases) return
    let live = true
    window.api.ade.baseBranches(cwd).then(
      (b) => {
        if (!live) return
        setBases(b)
        setPr((p) => (p.base ? p : { ...p, base: b.default ?? b.branches[0] ?? '' }))
      },
      () => live && setBases({ default: null, branches: [] })
    )
    return () => {
      live = false
    }
  }, [canOpenPr, bases, cwd])

  const fillFromCommits = async (): Promise<void> => {
    const base = pr.base || baseName
    setBusy('fill')
    try {
      const res = await window.api.ade.prFromCommits(cwd, base)
      if ('error' in res) notify(res.error, 'error')
      else setPr((p) => ({ ...p, title: res.title || p.title, body: res.body }))
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const prInfo = state?.github?.pr ?? null
  const conflictsWithBase = Boolean(prInfo && prInfo.state === 'OPEN' && (prInfo.mergeState === 'DIRTY' || prInfo.mergeable === 'CONFLICTING'))
  const behindBase = Boolean(state && (state.behindBase > 0 || (prInfo?.state === 'OPEN' && prInfo.mergeState === 'BEHIND')))
  const showUpdate = Boolean(state && state.base !== 'HEAD' && !state.merging && state.conflicted.length === 0 && (conflictsWithBase || behindBase))

  /** The comment editor: Markdown, with a preview; ⌘/Ctrl+Enter saves, Escape cancels. */
  const draftForm = (file: ReviewFile): JSX.Element => {
    const [from, to] = commenting ? span(commenting) : [0, 0]
    const where = from === to ? `line ${from}` : `lines ${from}–${to}`
    return (
      <form
        className="review-comment review-comment--draft"
        onSubmit={(e) => {
          e.preventDefault()
          save(file)
        }}
      >
        <div className="review-comment__bar">
          <Segmented
            value={preview}
            options={[
              { value: 'write', label: 'Write' },
              { value: 'preview', label: 'Preview' }
            ]}
            onChange={setPreview}
          />
          <span className="review-comment__where">{commenting?.side === 'old' ? `Removed ${where}` : where[0].toUpperCase() + where.slice(1)}</span>
        </div>
        {preview === 'write' ? (
          <textarea
            autoFocus
            className="input"
            rows={3}
            placeholder={from === to ? `What should change on line ${from}? Markdown works. Shift-click another line for a range.` : `What should change on lines ${from}–${to}? Markdown works.`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel()
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
            }}
          />
        ) : (
          <div
            className="review-comment__preview md"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel()
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(file)
            }}
          >
            {draft.trim() ? <Markdown text={draft} /> : <p className="review__muted">Nothing to preview.</p>}
          </div>
        )}
        <div className="review__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={!draft.trim()}>
            {commenting?.editing ? 'Save comment' : 'Add comment'}
          </button>
        </div>
      </form>
    )
  }

  const commentView = (c: ReviewComment, file: ReviewFile | null): JSX.Element =>
    commenting?.editing === c.id && file ? (
      <Fragment key={c.id}>{draftForm(file)}</Fragment>
    ) : (
      <div key={c.id} className="review-comment">
        <div className="review-comment__main">
          {(isRange(c) || !file) && (
            <span className="review-comment__where">
              {!file && `${c.path}:`}
              {isRange(c) ? `Lines ${span(c)[0]}–${span(c)[1]}` : `Line ${c.line}`}
            </span>
          )}
          <div className="review-comment__body md">
            <Markdown text={c.body} />
          </div>
        </div>
        {file && (
          <button type="button" className="icon-btn" aria-label="Edit comment" title="Edit" onClick={() => edit(c)}>
            <Pencil size={12} strokeWidth={2} />
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Delete comment" title="Delete" onClick={() => removeComment(cwd, c.id)}>
          <X size={13} strokeWidth={2} />
        </button>
      </div>
    )

  return (
    <aside className="review" aria-label="Review">
      <header className="review__head">
        <div className="review__title">
          <span>Review</span>
          {state && (
            <span className="review__branch" title={`Changes on ${state.branch ?? 'this commit'} since ${state.base}`}>
              {state.branch ?? 'detached HEAD'}
              {state.base !== 'HEAD' ? ` → ${baseName}` : ' · uncommitted'}
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
            {/* Conflicts first: nothing else moves until they're dealt with. */}
            {(state.merging || state.conflicted.length > 0) && <ReviewConflicts cwd={cwd} state={state} busy={busy} act={act} send={sendToAgent} />}

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
                    {conflictsWithBase && <span className="review-pr__fail">has conflicts</span>}
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
                          if (armed !== 'merge') return setArmed('merge')
                          setArmed(null)
                          void act('merge', () => window.api.ade.merge(cwd, method))
                        }}
                      >
                        {busy === 'merge' ? 'Merging…' : armed === 'merge' ? `Merge into ${state.github.pr.baseRef || baseName}?` : 'Merge'}
                      </button>
                    </div>
                  )}
                  <ReviewChecks key={cwd} cwd={cwd} checks={state.github.pr.checkRuns} title="Checks" send={sendToAgent} />
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
                    void act('pr', () => window.api.ade.createPr(cwd, { title: pr.title, body: pr.body, draft: pr.draft, ...(pr.base ? { base: pr.base } : {}) }))
                  }}
                >
                  <div className="review-form__head">
                    <span className="review__label">Pull request</span>
                    {bases && bases.branches.length > 0 && (
                      <span className="review-form__base">
                        into
                        <Select value={pr.base} width={130} options={bases.branches.map((b) => ({ value: b, label: b }))} onChange={(base) => setPr({ ...pr, base })} />
                      </span>
                    )}
                  </div>
                  <input className="input" placeholder="Title" value={pr.title} onChange={(e) => setPr({ ...pr, title: e.target.value })} />
                  <textarea className="input review-form__body" placeholder="What it changes and why (optional)" rows={3} value={pr.body} onChange={(e) => setPr({ ...pr, body: e.target.value })} />
                  <div className="review__actions">
                    <label className="review__check">
                      <input type="checkbox" checked={pr.draft} onChange={(e) => setPr({ ...pr, draft: e.target.checked })} /> Draft
                    </label>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={busy !== null || state.ahead === 0} onClick={() => void fillFromCommits()} title="Title and description from this branch’s commits">
                      {busy === 'fill' ? 'Filling…' : 'Fill from commits'}
                    </button>
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
              {state.github && !state.github.pr && state.github.runs && state.github.runs.length > 0 && (
                <ReviewChecks key={cwd} cwd={cwd} checks={state.github.runs} title="Workflow runs on this branch" send={sendToAgent} />
              )}
            </section>

            {/* Behind the base, or in conflict with it: merge it in. */}
            {showUpdate && (
              <section className="review__section review-update">
                <p className="review__muted">
                  {conflictsWithBase
                    ? `This pull request has conflicts with ${prInfo?.baseRef || baseName}. Merge it in here to resolve them.`
                    : state.behindBase > 0
                      ? `${baseName} has ${state.behindBase} ${state.behindBase === 1 ? 'commit' : 'commits'} this branch doesn’t.`
                      : `This branch is behind ${prInfo?.baseRef || baseName}.`}
                </p>
                <div className="review__actions">
                  <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => void act('update', () => window.api.ade.updateFromBase(cwd))}>
                    {busy === 'update' ? 'Updating…' : `Update from ${baseName}`}
                  </button>
                </div>
              </section>
            )}

            {/* Commit */}
            {state.uncommitted > 0 && !state.merging && (
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

            {/* Comments whose file has left the diff: still the user's until sent or cleared. */}
            {stale.length > 0 && (
              <section className="review__section review-stale">
                <div className="review__label">On files no longer changed</div>
                <p className="review__muted">These stay until you send or clear them. Sending leaves them out.</p>
                {stale.map((c) => commentView(c, null))}
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
              const draftHere = commenting?.path === file.path ? commenting : null
              const picked = draftHere ? span(draftHere) : null
              // Comments whose line isn't in the diff any more (the file changed since): shown above it, not lost.
              const rows = new Set<string>()
              for (const hunk of file.hunks)
                for (const l of hunk.lines) {
                  if (l.cur !== null) rows.add(`new:${l.cur}`)
                  if (l.old !== null) rows.add(`old:${l.old}`)
                }
              const adrift = here.filter((c) => !rows.has(`${c.side}:${lastLine(c)}`))
              const draftAdrift = draftHere && !rows.has(`${draftHere.side}:${lastLine(draftHere)}`)
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
                  {!isFolded && (adrift.length > 0 || draftAdrift) && (
                    <div className="review-file__adrift">
                      {adrift.length > 0 && <p className="review__muted">Not on a changed line any more:</p>}
                      {adrift.map((c) => commentView(c, file))}
                      {draftAdrift && !draftHere.editing && draftForm(file)}
                    </div>
                  )}
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
                                  const onLine = here.filter((c) => numOn(line, c.side) === lastLine(c))
                                  const n = draftHere ? numOn(line, draftHere.side) : null
                                  const inRange = picked !== null && n !== null && n >= picked[0] && n <= picked[1]
                                  const draftBelow = draftHere !== null && n === lastLine(draftHere) && !draftHere.editing
                                  return (
                                    <Fragment key={i}>
                                      <div
                                        className="diff__row review-diff__row"
                                        data-kind={line.kind}
                                        data-picked={inRange || undefined}
                                        role="button"
                                        tabIndex={-1}
                                        title="Comment on this line (shift-click another for a range)"
                                        onClick={(e) => pick(file, line, e.shiftKey)}
                                      >
                                        <span className="diff__ln diff__ln--old">{line.old ?? ''}</span>
                                        <span className="diff__ln diff__ln--new">{line.cur ?? ''}</span>
                                        <span className="diff__sign" aria-hidden>
                                          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
                                        </span>
                                        <Code text={line.text || ' '} />
                                        <MessageSquarePlus size={13} strokeWidth={2} className="review-diff__plus" aria-hidden />
                                      </div>
                                      {onLine.map((c) => commentView(c, file))}
                                      {draftBelow && draftForm(file)}
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

      {(comments.length > 0 || agentPanes.length > 1) && (
        <footer className="review__foot">
          <span className="review__foot-count">
            {comments.length === 0 ? 'Sends to' : `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`}
          </span>
          {comments.length > 0 && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                if (armed !== 'clear') return setArmed('clear')
                setArmed(null)
                clearComments(cwd)
                cancel()
              }}
            >
              {armed === 'clear' ? 'Clear all?' : 'Clear'}
            </button>
          )}
          {agentPanes.length > 0 ? (
            <>
              <Select value={target} width={150} options={agentPanes.map((p) => ({ value: p.id, label: p.name }))} onChange={setTarget} />
              {comments.length > 0 && (
                <button type="button" className="btn btn--primary btn--sm" onClick={send}>
                  <Send size={13} strokeWidth={2} />
                  Send to agent
                </button>
              )}
            </>
          ) : (
            <span className="review__muted">Start an agent in this session to send them to it.</span>
          )}
        </footer>
      )}
    </aside>
  )
}
