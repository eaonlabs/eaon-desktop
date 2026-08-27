import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, Filter, GitPullRequest, Loader2, RefreshCw } from 'lucide-react'
import { useApp } from '../state/store'
import { CollapsedNav } from './CollapsedNav'
import { SearchField } from './ui'
import type { PullRequestsResult, PullRequestSummary } from '@shared/types'

type Tab = 'all' | 'reviewing' | 'authored'

const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'authored', label: 'Authored' }
]

const STATE_COLOR: Record<PullRequestSummary['state'], string> = {
  open: '#3fb950',
  merged: '#a371f7',
  closed: '#f85149',
  draft: 'var(--text-3)'
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
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [newestFirst, setNewestFirst] = useState(true)
  const [data, setData] = useState<PullRequestsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    void window.api.github.pullRequests().then((result) => {
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
      <div className="chat-header" data-collapsed={!sidebarOpen || undefined}>
        {!sidebarOpen && <CollapsedNav />}
        <div className="manager__tabs">
          {TABS.map((t) => (
            <button key={t.value} className="manager__tab" data-active={tab === t.value} onClick={() => setTab(t.value)}>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="chat-header__spacer" />
        <button className="icon-btn" aria-label="Refresh" onClick={load} disabled={loading}>
          <RefreshCw size={15} strokeWidth={1.9} className={loading ? 'spinner' : undefined} />
        </button>
      </div>

      <div className="pr-search">
        <SearchField value={query} onChange={setQuery} placeholder="Search pull requests" variant="pill" />
        <button
          className="icon-btn"
          aria-label={newestFirst ? 'Sort: newest first' : 'Sort: oldest first'}
          title={newestFirst ? 'Newest first' : 'Oldest first'}
          onClick={() => setNewestFirst((v) => !v)}
        >
          <Filter size={16} strokeWidth={1.9} />
        </button>
      </div>

      <div className="pr-shell">
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

        <div className="pr-detail">
          {selected ? (
            <div className="pr-detail__card">
              <span className="pr-detail__repo">{selected.repo}</span>
              <h2 className="pr-detail__title">{selected.title}</h2>
              <div className="pr-detail__meta">
                <span style={{ color: STATE_COLOR[selected.state] }}>{selected.state}</span>
                <span>{selected.branch}</span>
                <span>
                  <span style={{ color: '#3fb950' }}>+{selected.additions.toLocaleString()}</span>{' '}
                  <span style={{ color: '#f85149' }}>-{selected.deletions.toLocaleString()}</span>
                </span>
              </div>
              <button className="btn" onClick={() => void window.api.app.openExternal(selected.url)}>
                <ExternalLink size={14} strokeWidth={1.9} />
                Open in GitHub
              </button>
            </div>
          ) : (
            <div className="pr-detail__empty">Select pull request to view</div>
          )}
        </div>
      </div>
    </div>
  )
}

function PrRow({ pr, active, onSelect }: { pr: PullRequestSummary; active: boolean; onSelect: () => void }): JSX.Element {
  return (
    <div
      className="pr-row"
      data-active={active || undefined}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
    >
      <span className="pr-row__icon">
        <GitPullRequest size={16} strokeWidth={1.8} />
        <span className="pr-row__dot" style={{ background: STATE_COLOR[pr.state] }} />
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
          <span className="pr-row__stats">
            <span style={{ color: '#3fb950' }}>+{pr.additions.toLocaleString()}</span>{' '}
            <span style={{ color: '#f85149' }}>-{pr.deletions.toLocaleString()}</span>
          </span>
        </div>
      </div>
      <button
        className="icon-btn pr-row__open"
        aria-label="Open in GitHub"
        onClick={(e) => {
          e.stopPropagation()
          void window.api.app.openExternal(pr.url)
        }}
      >
        <ExternalLink size={14} strokeWidth={1.9} />
      </button>
    </div>
  )
}
