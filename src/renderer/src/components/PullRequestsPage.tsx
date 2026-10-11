import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  RefreshCw,
  type LucideIcon
} from 'lucide-react'
import { TopBar } from './TopBar'
import { SearchField, Segmented } from './ui'
import { PrReviewPanel } from './PrReviewPanel'
import { Code } from './agent/FileDiff'
import { notify } from './Notice'
import { parseUnifiedDiff, type ReviewFile } from '@shared/adeReview'
import type { PullRequestAction, PullRequestDetail, PullRequestsResult, PullRequestSummary } from '@shared/types'

type Tab = 'all' | 'reviewing' | 'authored'

const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'authored', label: 'Authored' }
]

/** GitHub's own mark for each state: the icon carries the state, in its colour. */
const STATE: Record<PullRequestSummary['state'], { icon: LucideIcon; label: string }> = {
  open: { icon: GitPullRequest, label: 'Open' },
  merged: { icon: GitMerge, label: 'Merged' },
  closed: { icon: GitPullRequestClosed, label: 'Closed' },
  draft: { icon: GitPullRequestDraft, label: 'Draft' }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (days < 30) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

/** Real pull requests via the `gh` CLI — see .eaonbrain/eaon-work-mode.md. */
export function PullRequestsPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [newestFirst, setNewestFirst] = useState(true)
  const [data, setData] = useState<PullRequestsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    void window.api.github
      .pullRequests()
      .catch((error: unknown): PullRequestsResult => ({
        authored: [],
        reviewing: [],
        error: error instanceof Error ? error.message : String(error)
      }))
      .then((result) => {
        setData(result)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const q = query.trim().toLowerCase()
  const matches = (pr: PullRequestSummary): boolean =>
    !q || pr.title.toLowerCase().includes(q) || pr.repo.toLowerCase().includes(q)
  const sortByDate = (list: PullRequestSummary[]): PullRequestSummary[] =>
    [...list].sort((a, b) => {
      const delta = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      return newestFirst ? delta : -delta
    })

  const groups = useMemo(() => {
    const authored = (data?.authored ?? []).filter(matches)
    const reviewing = (data?.reviewing ?? []).filter(matches)
    const shape =
      tab === 'authored'
        ? [{ label: 'Authored', items: authored }]
        : tab === 'reviewing'
          ? [{ label: 'Reviewing', items: reviewing }]
          : [
              { label: 'Reviewing', items: reviewing },
              { label: 'Authored', items: authored }
            ]
    return shape.map((g) => ({ ...g, items: sortByDate(g.items) })).filter((g) => g.items.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, tab, q, newestFirst])

  const all = [...(data?.authored ?? []), ...(data?.reviewing ?? [])]
  const selected = all.find((pr) => pr.id === selectedId) ?? null

  return (
    <div className="pr-page">
      <TopBar
        left={<span className="chat-header__title">Pull requests</span>}
        right={
          <button className="icon-btn" aria-label="Refresh" title="Refresh" onClick={load} disabled={loading}>
            <RefreshCw size={15} strokeWidth={1.9} className={loading ? 'spinner' : undefined} />
          </button>
        }
      />

      <div className="pr-shell">
        {/* The list's controls live in its own column, on the same edges as its rows. */}
        <aside className="pr-pane">
          <div className="pr-pane__head">
            <Segmented value={tab} onChange={setTab} options={TABS} />
            <div className="pr-search">
              <SearchField value={query} onChange={setQuery} placeholder="Search pull requests" variant="sm" />
              <button
                className="icon-btn"
                aria-label={newestFirst ? 'Newest first' : 'Oldest first'}
                title={newestFirst ? 'Newest first' : 'Oldest first'}
                onClick={() => setNewestFirst((v) => !v)}
              >
                {newestFirst ? <ArrowDownWideNarrow size={15} strokeWidth={1.9} /> : <ArrowUpNarrowWide size={15} strokeWidth={1.9} />}
              </button>
            </div>
          </div>

          <div className="pr-list scroll">
            {loading && (
              <div className="pr-empty">
                <Loader2 size={16} strokeWidth={2} className="spinner" />
                Loading pull requests…
              </div>
            )}
            {!loading && data?.error && (
              <div className="pr-empty pr-empty--error">
                {data.error}
                <button className="btn btn--sm" onClick={load}>
                  Retry
                </button>
              </div>
            )}
            {!loading && !data?.error && groups.length === 0 && <div className="pr-empty">No pull requests</div>}
            {!loading &&
              groups.map((group) => (
                <div key={group.label}>
                  <div className="pr-list__group">{group.label}</div>
                  {group.items.map((pr) => (
                    <PrRow key={pr.id} pr={pr} active={pr.id === selectedId} onSelect={() => setSelectedId(pr.id)} />
                  ))}
                </div>
              ))}
          </div>
        </aside>

        <section className="pr-detail scroll">
          {selected ? <PrDetail key={selected.id} pr={selected} onChanged={load} /> : <div className="pr-detail__empty">Select a pull request to see it here</div>}
        </section>
      </div>
    </div>
  )
}

type DetailTab = 'overview' | 'files' | 'checks' | 'merge'

const DETAIL_TABS: { value: DetailTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'files', label: 'Files' },
  { value: 'checks', label: 'Checks' },
  { value: 'merge', label: 'Merge' }
]

const errorText = (error: unknown): string => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error))

/**
 * One pull request: what it is (Overview), its changes (Files), its CI
 * (Checks), and everything to land it (Merge): the repository's merge
 * methods, the commit message, deleting the branch, merging once checks pass,
 * approving, marking ready, updating the branch, closing. All through `gh`
 * (main/github.ts), as the signed-in GitHub user.
 */
function PrDetail({ pr, onChanged }: { pr: PullRequestSummary; onChanged: () => void }): JSX.Element {
  const { icon: Icon, label } = STATE[pr.state]
  const [tab, setTab] = useState<DetailTab>('overview')
  const [detail, setDetail] = useState<PullRequestDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    window.api.github.detail(pr.url).then(setDetail, (e) => setError(errorText(e)))
  }, [pr.url])

  useEffect(() => {
    setDetail(null)
    load()
  }, [load])

  /** An action's result, then everything read again: the list's state changes too. */
  const after = (result: PullRequestAction): void => {
    notify(result.ok ? result.message : result.error, result.ok ? 'done' : 'error')
    if (result.ok) {
      load()
      onChanged()
    }
  }

  const failing = detail?.checks.filter((c) => c.status === 'failed').length ?? 0
  const state = detail?.state ?? pr.state
  const shown = STATE[state] ?? { icon: Icon, label }
  const ShownIcon = shown.icon

  return (
    <div className="pr-detail__inner">
      <div className="pr-detail__repo">{pr.repo}</div>
      <h1 className="pr-detail__title">
        {detail ? `${detail.title} ` : pr.title}
        {detail && <span className="pr-detail__num">#{detail.number}</span>}
      </h1>
      <div className="pr-detail__meta">
        <span className="pr-state" data-state={state}>
          <ShownIcon size={13} strokeWidth={2.2} />
          {shown.label}
        </span>
        <span className="pr-detail__branch">
          <GitBranch size={13} strokeWidth={2} />
          {detail ? `${detail.head} → ${detail.base}` : pr.branch}
        </span>
        <span className="pr-stats">
          <span className="pr-stats__add">+{pr.additions.toLocaleString()}</span>
          <span className="pr-stats__del">−{pr.deletions.toLocaleString()}</span>
        </span>
        <span className="pr-detail__time">Updated {timeAgo(pr.updatedAt)} ago</span>
        <button className="btn btn--sm btn--ghost" onClick={() => void window.api.app.openExternal(pr.url)}>
          <ExternalLink size={13} strokeWidth={1.9} />
          GitHub
        </button>
      </div>

      <div className="pr-tabs">
        <Segmented
          value={tab}
          onChange={setTab}
          options={DETAIL_TABS.map((t) => ({
            ...t,
            label: t.value === 'checks' && detail?.checks.length ? `Checks${failing ? ` · ${failing} failing` : ''}` : t.value === 'files' && detail ? `Files · ${detail.changedFiles}` : t.label
          }))}
        />
      </div>

      {error && <div className="pr-empty pr-empty--error">{error}</div>}
      {!detail && !error && (
        <div className="pr-empty">
          <Loader2 size={16} strokeWidth={2} className="spinner" />
          Loading…
        </div>
      )}
      {detail && tab === 'overview' && <PrOverview detail={detail} />}
      {tab === 'overview' && <PrReviewPanel pr={pr} />}
      {detail && tab === 'files' && <PrFiles url={detail.url} />}
      {detail && tab === 'checks' && <PrChecks detail={detail} />}
      {detail && tab === 'merge' && <PrMerge detail={detail} after={after} />}
    </div>
  )
}

function PrOverview({ detail }: { detail: PullRequestDetail }): JSX.Element {
  const decision = detail.reviewDecision.replace(/_/g, ' ').toLowerCase()
  return (
    <div className="pr-overview">
      <div className="pr-facts">
        <span>
          By <strong>{detail.author}</strong>, opened {timeAgo(detail.createdAt)} ago
        </span>
        {decision && <span>Review: {decision}</span>}
        {detail.reviews.map((r) => (
          <span key={r.author} className="pr-reviewer" data-state={r.state}>
            {r.author}: {r.state.replace(/_/g, ' ').toLowerCase()}
          </span>
        ))}
      </div>
      {detail.body.trim() ? <div className="pr-body">{detail.body}</div> : <p className="pr-muted">No description.</p>}
    </div>
  )
}

function PrFiles({ url }: { url: string }): JSX.Element {
  const [files, setFiles] = useState<ReviewFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  useEffect(() => {
    setFiles(null)
    window.api.github.diff(url).then(
      (text) => setFiles(parseUnifiedDiff(text)),
      (e) => setError(errorText(e))
    )
  }, [url])
  if (error) return <div className="pr-empty pr-empty--error">{error}</div>
  if (!files)
    return (
      <div className="pr-empty">
        <Loader2 size={16} strokeWidth={2} className="spinner" />
        Loading the changes…
      </div>
    )
  if (files.length === 0) return <p className="pr-muted">No changes.</p>
  return (
    <div className="pr-files">
      {files.map((file) => {
        // Small files start open; a big one is a click away.
        const isOpen = open[file.path] ?? file.added + file.removed <= 300
        return (
          <div key={file.path} className="review-file">
            <button type="button" className="review-file__head" aria-expanded={isOpen} onClick={() => setOpen({ ...open, [file.path]: !isOpen })}>
              <ChevronRight size={13} strokeWidth={2} className="review-file__chev" data-open={isOpen || undefined} />
              <span className="review-file__status" data-status={file.status}>
                {file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M'}
              </span>
              <span className="review-file__path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                {file.path}
              </span>
              <span className="review__add">+{file.added}</span>
              <span className="review__del">−{file.removed}</span>
            </button>
            {isOpen &&
              (file.binary ? (
                <p className="pr-muted review-file__note">A binary file.</p>
              ) : (
                <div className="diff review-diff" data-numbered>
                  <div className="diff__body">
                    <div className="diff__lines">
                      {file.hunks.map((hunk, h) => (
                        <div key={h}>
                          <div className="review-diff__hunk">{hunk.header}</div>
                          {hunk.lines.map((line, i) => (
                            <div key={i} className="diff__row" data-kind={line.kind}>
                              <span className="diff__ln diff__ln--old">{line.old ?? ''}</span>
                              <span className="diff__ln diff__ln--new">{line.cur ?? ''}</span>
                              <span className="diff__sign" aria-hidden>
                                {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
                              </span>
                              <Code text={line.text || ' '} />
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}

const CHECK_ICON = { passed: CircleCheck, failed: CircleX, pending: Loader2, skipped: CircleMinus } as const

function PrChecks({ detail }: { detail: PullRequestDetail }): JSX.Element {
  if (detail.checks.length === 0) return <p className="pr-muted">This pull request has no checks.</p>
  const order = { failed: 0, pending: 1, passed: 2, skipped: 3 }
  return (
    <div className="pr-checks">
      {[...detail.checks]
        .sort((a, b) => order[a.status] - order[b.status])
        .map((check, i) => {
          const CheckIcon = CHECK_ICON[check.status]
          return (
            <div key={`${check.name}-${i}`} className="pr-check" data-status={check.status}>
              <CheckIcon size={15} strokeWidth={2} className={check.status === 'pending' ? 'spinner' : undefined} />
              <span className="pr-check__name">{check.name}</span>
              <span className="pr-check__status">{check.status}</span>
              {check.url && (
                <button className="icon-btn" aria-label={`Open ${check.name}`} title="Open its run" onClick={() => void window.api.app.openExternal(check.url!)}>
                  <ExternalLink size={13} strokeWidth={1.9} />
                </button>
              )}
            </div>
          )
        })}
    </div>
  )
}

/** Where the pull request stands, in words, and the one thing that would move it. */
function mergeStatus(d: PullRequestDetail): { tone: 'ok' | 'warn' | 'bad' | 'done'; text: string; fix?: { label: string; action: 'ready' | 'update-branch' | 'reopen' } } {
  if (d.state === 'merged') return { tone: 'done', text: 'Merged.' }
  if (d.state === 'closed') return { tone: 'bad', text: 'Closed without merging.', fix: { label: 'Reopen', action: 'reopen' } }
  if (d.state === 'draft') return { tone: 'warn', text: 'It’s a draft. Mark it ready for review to merge it.', fix: { label: 'Ready for review', action: 'ready' } }
  if (d.mergeable === 'CONFLICTING' || d.mergeState === 'DIRTY') return { tone: 'bad', text: `It conflicts with ${d.base}. Resolve the conflicts (in the ADE or on GitHub) before it can merge.` }
  if (d.mergeState === 'BEHIND') return { tone: 'warn', text: `It’s behind ${d.base}, and the repository wants it up to date.`, fix: { label: 'Update branch', action: 'update-branch' } }
  const failing = d.checks.filter((c) => c.status === 'failed').length
  const pending = d.checks.filter((c) => c.status === 'pending').length
  if (d.mergeState === 'BLOCKED') {
    const why = [d.reviewDecision === 'REVIEW_REQUIRED' && 'an approving review', d.reviewDecision === 'CHANGES_REQUESTED' && 'the requested changes', failing && `${failing} failing ${failing === 1 ? 'check' : 'checks'}`, pending && `${pending} ${pending === 1 ? 'check' : 'checks'} still running`].filter(Boolean)
    return { tone: 'warn', text: `Blocked${why.length ? ` on ${why.join(', ')}` : ' by the repository’s rules'}. You can set it to merge on its own once that’s done.` }
  }
  if (failing) return { tone: 'warn', text: `${failing} ${failing === 1 ? 'check is' : 'checks are'} failing, but it can still be merged.` }
  if (pending) return { tone: 'warn', text: `${pending} ${pending === 1 ? 'check is' : 'checks are'} still running.` }
  if (d.mergeable === 'UNKNOWN') return { tone: 'warn', text: 'GitHub is still working out whether it can merge. Refresh in a moment.' }
  return { tone: 'ok', text: `Ready to merge into ${d.base}.` }
}

function PrMerge({ detail, after }: { detail: PullRequestDetail; after: (result: PullRequestAction) => void }): JSX.Element {
  const methods = (['squash', 'merge', 'rebase'] as const).filter((m) => detail.methods[m])
  const [method, setMethod] = useState<'squash' | 'merge' | 'rebase'>(methods[0] ?? 'squash')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [deleteBranch, setDeleteBranch] = useState(true)
  const [auto, setAuto] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)

  // The commit GitHub would write, as the starting point.
  useEffect(() => {
    setSubject(method === 'squash' ? `${detail.title} (#${detail.number})` : `Merge pull request #${detail.number} from ${detail.head}`)
    setBody(method === 'squash' ? '' : detail.title)
  }, [method, detail.number, detail.title, detail.head])

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(timer)
  }, [armed])

  const status = mergeStatus(detail)
  const open = detail.state === 'open'
  const blocked = detail.mergeState === 'BLOCKED' || detail.mergeState === 'BEHIND' || detail.mergeState === 'UNKNOWN' || detail.checks.some((c) => c.status === 'pending')
  useEffect(() => setAuto(blocked), [blocked])

  const act = async (label: string, job: () => Promise<PullRequestAction>): Promise<void> => {
    setBusy(label)
    try {
      after(await job())
    } catch (e) {
      after({ ok: false, error: errorText(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="pr-merge">
      <div className="pr-merge__status" data-tone={status.tone}>
        <span>{status.text}</span>
        {status.fix && (
          <button className="btn btn--sm" disabled={busy !== null} onClick={() => void act(status.fix!.action, () => window.api.github.act(detail.url, status.fix!.action))}>
            {busy === status.fix.action ? 'Working…' : status.fix.label}
          </button>
        )}
      </div>

      {open && (
        <>
          <div className="pr-merge__field">
            <span className="pr-merge__label">Merge method</span>
            <Segmented
              value={method}
              onChange={setMethod}
              options={methods.map((m) => ({ value: m, label: m === 'squash' ? 'Squash and merge' : m === 'merge' ? 'Merge commit' : 'Rebase and merge' }))}
            />
          </div>
          {method !== 'rebase' && (
            <>
              <label className="pr-merge__field">
                <span className="pr-merge__label">Commit message</span>
                <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </label>
              <textarea className="input pr-merge__body" rows={3} placeholder="Extended description (optional)" value={body} onChange={(e) => setBody(e.target.value)} />
            </>
          )}
          <label className="pr-merge__check">
            <input type="checkbox" checked={deleteBranch || detail.deletesBranch} disabled={detail.deletesBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
            Delete the branch {detail.head} on GitHub afterwards{detail.deletesBranch ? ' (the repository always does)' : ''}
          </label>
          <label className="pr-merge__check">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Merge automatically once required checks and reviews pass
          </label>
          <div className="pr-merge__actions">
            <button className="btn btn--sm btn--ghost" disabled={busy !== null} onClick={() => void act('approve', () => window.api.github.act(detail.url, 'approve'))}>
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
            <button className="btn btn--sm btn--ghost" disabled={busy !== null} onClick={() => void act('draft', () => window.api.github.act(detail.url, 'draft'))}>
              Back to draft
            </button>
            <button className="btn btn--sm btn--ghost pr-merge__close" disabled={busy !== null} onClick={() => void act('close', () => window.api.github.act(detail.url, 'close'))}>
              {busy === 'close' ? 'Closing…' : 'Close pull request'}
            </button>
            <span className="pr-merge__spacer" />
            <button
              className="btn btn--primary btn--sm"
              disabled={busy !== null || methods.length === 0 || (status.tone === 'bad' && !auto)}
              onClick={() => {
                if (!armed) return setArmed(true)
                setArmed(false)
                void act('merge', () => window.api.github.merge(detail.url, { method, deleteBranch: deleteBranch && !detail.deletesBranch, auto, subject, body }))
              }}
            >
              <GitMerge size={14} strokeWidth={2} />
              {busy === 'merge' ? 'Merging…' : armed ? `${auto ? 'Turn on auto-merge' : `Merge into ${detail.base}`}?` : auto ? 'Enable auto-merge' : 'Merge'}
            </button>
          </div>
          {methods.length === 0 && <p className="pr-muted">This repository doesn’t allow any merge method.</p>}
        </>
      )}
      {detail.state === 'merged' && (
        <p className="pr-muted">
          {detail.head} → {detail.base}. Pull {detail.base} in the ADE to get it locally.
        </p>
      )}
    </div>
  )
}

function PrRow({ pr, active, onSelect }: { pr: PullRequestSummary; active: boolean; onSelect: () => void }): JSX.Element {
  const { icon: Icon, label } = STATE[pr.state]
  return (
    <div
      className="pr-row"
      data-active={active || undefined}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
    >
      <span className="pr-row__icon" data-state={pr.state} title={label}>
        <Icon size={16} strokeWidth={1.9} />
      </span>
      <div className="pr-row__body">
        <div className="pr-row__top">
          <span className="pr-row__title">{pr.title}</span>
          <span className="pr-row__time">{timeAgo(pr.updatedAt)}</span>
        </div>
        <div className="pr-row__bottom">
          <span className="pr-row__repo">
            {pr.repo} <span className="pr-row__branch">{pr.branch}</span>
          </span>
          <span className="pr-stats">
            <span className="pr-stats__add">+{pr.additions.toLocaleString()}</span>
            <span className="pr-stats__del">−{pr.deletions.toLocaleString()}</span>
          </span>
        </div>
      </div>
      {/* Over the time on hover, rather than a column of its own that leaves every row short of the edge. */}
      <button
        className="icon-btn pr-row__open"
        aria-label="Open in GitHub"
        title="Open in GitHub"
        onClick={(e) => {
          e.stopPropagation()
          void window.api.app.openExternal(pr.url)
        }}
      >
        <ExternalLink size={13} strokeWidth={1.9} />
      </button>
    </div>
  )
}
