import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import {
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ExternalLink,
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
import { Markdown } from './agent/Markdown'
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

/** A state as `gh` spelt it, whatever its case; one it has never sent reads as open rather than breaking the page. */
function stateKey(state: string): PullRequestSummary['state'] {
  const key = String(state).toLowerCase()
  return key in STATE ? (key as PullRequestSummary['state']) : 'open'
}

/** The number on the end of a pull request's address. */
const numberOf = (url: string): string => url.match(/\/pull\/(\d+)/)?.[1] ?? ''

/** "REVIEW_REQUIRED" → "Review required". */
const sentence = (word: string): string => {
  const plain = word.replace(/_/g, ' ').toLowerCase()
  return plain ? plain[0].toUpperCase() + plain.slice(1) : ''
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
            {!loading && data?.error && <PrListError error={data.error} retry={load} />}
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
          {selected ? (
            <PrDetail key={selected.id} pr={selected} onChanged={load} />
          ) : (
            <div className="pr-detail__empty">{groups.length > 0 ? 'Select a pull request to see it here' : ''}</div>
          )}
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

/**
 * Why the list couldn't load. GitHub CLI missing or signed out is the usual
 * first-run state, not a failure, so it reads as a setup step with the
 * command to run rather than as a red error.
 */
function PrListError({ error, retry }: { error: string; retry: () => void }): JSX.Element {
  const missing = /not installed/i.test(error) && /\bgh\b/.test(error)
  const signedOut = /Not signed in to GitHub CLI/i.test(error)
  if (missing || signedOut) {
    return (
      <div className="pr-empty">
        <span className="pr-empty__title">{missing ? 'Install GitHub CLI to see your pull requests' : 'Sign in to GitHub CLI to see your pull requests'}</span>
        <span>
          {missing ? 'Get it from cli.github.com, then run ' : 'In a terminal, run '}
          <code className="pr-empty__cmd">gh auth login</code>
        </span>
        <span className="pr-empty__actions">
          {missing && (
            <button className="btn btn--sm" onClick={() => void window.api.app.openExternal('https://cli.github.com')}>
              Get GitHub CLI
            </button>
          )}
          <button className="btn btn--sm" onClick={retry}>
            Check again
          </button>
        </span>
      </div>
    )
  }
  return (
    <div className="pr-empty pr-empty--error">
      {error}
      <button className="btn btn--sm" onClick={retry}>
        Retry
      </button>
    </div>
  )
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error))

/**
 * One pull request: what it is (Overview), its changes (Files), its CI
 * (Checks), and everything to land it (Merge): the repository's merge
 * methods, the commit message, deleting the branch, merging once checks pass,
 * approving, marking ready, updating the branch, closing. All through `gh`
 * (main/github.ts), as the signed-in GitHub user.
 */
function PrDetail({ pr, onChanged }: { pr: PullRequestSummary; onChanged: () => void }): JSX.Element {
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
  const state = stateKey(detail?.state ?? pr.state)
  const shown = STATE[state]
  const ShownIcon = shown.icon
  const head = detail?.head ?? pr.branch
  // What the pull request is doing, in GitHub's own words.
  const doing = state === 'merged' ? 'merged' : state === 'closed' ? 'wanted to merge' : 'wants to merge'
  const count = (t: DetailTab): { text: string; tone?: 'bad' } | null => {
    if (!detail) return null
    if (t === 'files') return { text: String(detail.changedFiles) }
    if (t === 'checks' && detail.checks.length) return failing ? { text: String(failing), tone: 'bad' } : { text: String(detail.checks.length) }
    return null
  }

  return (
    <div className="pr-detail__inner">
      <header className="pr-head">
        <div className="pr-head__eyebrow">
          <span>{pr.repo}</span>
          <span className="pr-head__dot" aria-hidden>
            ·
          </span>
          <span>#{detail?.number ?? numberOf(pr.url)}</span>
        </div>
        <h1 className="pr-head__title">{detail?.title ?? pr.title}</h1>
        <div className="pr-head__line">
          <span className="pr-state" data-state={state}>
            <ShownIcon size={13} strokeWidth={2} />
            {shown.label}
          </span>
          <span className="pr-head__sentence">
            {detail?.author && <strong>{detail.author}</strong>} {detail?.author ? doing : 'Merging'} <code className="pr-ref">{head}</code>
            {detail && (
              <>
                {' '}
                into <code className="pr-ref">{detail.base}</code>
              </>
            )}
          </span>
          <button className="icon-btn pr-head__open" aria-label="Open on GitHub" title="Open on GitHub" onClick={() => void window.api.app.openExternal(pr.url)}>
            <ExternalLink size={15} strokeWidth={1.9} />
          </button>
        </div>
      </header>

      <div className="pr-tabbar" role="tablist" aria-label="Pull request">
        {DETAIL_TABS.map((t) => {
          const badge = count(t.value)
          return (
            <button key={t.value} type="button" role="tab" className="pr-tab" aria-selected={tab === t.value} data-active={tab === t.value || undefined} onClick={() => setTab(t.value)}>
              {t.label}
              {badge && (
                <span className="pr-tab__count" data-tone={badge.tone}>
                  {badge.text}
                </span>
              )}
            </button>
          )
        })}
        <span className="pr-tabbar__stats">
          <span className="pr-stats__add">+{(detail?.additions ?? pr.additions).toLocaleString()}</span>
          <span className="pr-stats__del">−{(detail?.deletions ?? pr.deletions).toLocaleString()}</span>
        </span>
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
  const tally = (status: PullRequestDetail['checks'][number]['status']): number => detail.checks.filter((c) => c.status === status).length
  const checks = [
    { n: tally('failed'), word: 'failing', tone: 'bad' },
    { n: tally('pending'), word: 'running', tone: 'wait' },
    { n: tally('passed'), word: 'passed', tone: 'ok' },
    { n: tally('skipped'), word: 'skipped', tone: 'quiet' }
  ].filter((c) => c.n > 0)
  const decision = sentence(detail.reviewDecision)
  return (
    <div className="pr-overview">
      <dl className="pr-props">
        <div className="pr-props__row">
          <dt>Review</dt>
          <dd data-tone={detail.reviewDecision === 'APPROVED' ? 'ok' : detail.reviewDecision === 'CHANGES_REQUESTED' ? 'bad' : undefined}>{decision || 'Not required'}</dd>
        </div>
        <div className="pr-props__row">
          <dt>Checks</dt>
          <dd>
            {checks.length === 0
              ? 'None'
              : checks.map((c) => (
                  <span key={c.word} className="pr-tally" data-tone={c.tone}>
                    {c.n} {c.word}
                  </span>
                ))}
          </dd>
        </div>
        <div className="pr-props__row">
          <dt>Reviewers</dt>
          <dd>
            {detail.reviews.length === 0
              ? 'None yet'
              : detail.reviews.map((r) => (
                  <span key={r.author} className="pr-reviewer" data-state={r.state}>
                    {r.author}
                    <span className="pr-reviewer__state">{sentence(r.state)}</span>
                  </span>
                ))}
          </dd>
        </div>
        <div className="pr-props__row">
          <dt>Opened</dt>
          <dd>
            {timeAgo(detail.createdAt)} ago by {detail.author}
          </dd>
        </div>
      </dl>
      <div className="pr-desc">{detail.body.trim() ? <Markdown text={detail.body} /> : <p className="pr-muted">No description.</p>}</div>
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
              <textarea aria-label="Extended description" className="input pr-merge__body" rows={3} placeholder="Extended description (optional)" value={body} onChange={(e) => setBody(e.target.value)} />
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
  const state = stateKey(pr.state)
  const { icon: Icon, label } = STATE[state]
  return (
    <div
      className="pr-row"
      data-active={active || undefined}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
    >
      <span className="pr-row__icon" data-state={state} title={label}>
        <Icon size={15} strokeWidth={1.9} />
      </span>
      <div className="pr-row__body">
        <div className="pr-row__top">
          <span className="pr-row__title">{pr.title}</span>
          <span className="pr-row__time">{timeAgo(pr.updatedAt)}</span>
        </div>
        <div className="pr-row__bottom">
          <span className="pr-row__repo">
            {pr.repo} <span className="pr-row__num">#{numberOf(pr.url)}</span>
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
