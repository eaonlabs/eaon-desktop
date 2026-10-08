import { useCallback, useEffect, useMemo, useState } from 'react'
import {
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
import type { PullRequestsResult, PullRequestSummary } from '@shared/types'

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
          {selected ? <PrDetail pr={selected} /> : <div className="pr-detail__empty">Select a pull request to see it here</div>}
        </section>
      </div>
    </div>
  )
}

function PrDetail({ pr }: { pr: PullRequestSummary }): JSX.Element {
  const { icon: Icon, label } = STATE[pr.state]
  return (
    <div className="pr-detail__inner">
      <div className="pr-detail__repo">{pr.repo}</div>
      <h1 className="pr-detail__title">{pr.title}</h1>
      <div className="pr-detail__meta">
        <span className="pr-state" data-state={pr.state}>
          <Icon size={13} strokeWidth={2.2} />
          {label}
        </span>
        <span className="pr-detail__branch">
          <GitBranch size={13} strokeWidth={2} />
          {pr.branch}
        </span>
        <span className="pr-stats">
          <span className="pr-stats__add">+{pr.additions.toLocaleString()}</span>
          <span className="pr-stats__del">−{pr.deletions.toLocaleString()}</span>
        </span>
        <span className="pr-detail__time">Updated {timeAgo(pr.updatedAt)} ago</span>
      </div>
      <button className="btn" onClick={() => void window.api.app.openExternal(pr.url)}>
        <ExternalLink size={14} strokeWidth={1.9} />
        Open in GitHub
      </button>
      <PrReviewPanel pr={pr} />
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
