import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import { TopBar } from './TopBar'
import { MenuItem, Popover, useDisclosure } from './ui'
import { notify } from './Notice'
import type { PullRequestAction, PullRequestDetail, PullRequestsResult, PullRequestSummary } from '@shared/types'
import { Octicon, type OcticonName } from './pullRequests/octicons'
import { BranchRef, Counter, Diffstat, GhLabel, RelativeTime, STATE, StateLabel, errorText, numberOf, stateKey } from './pullRequests/parts'
import { Conversation } from './pullRequests/Conversation'
import { Commits } from './pullRequests/Commits'
import { Checks } from './pullRequests/Checks'
import { ChangedFiles, Loading } from './pullRequests/ChangedFiles'
import './pullRequests/pull-requests.css'

type Tab = 'all' | 'authored' | 'reviewing'

/** GitHub's own names for these lists (github.com/pulls). */
const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'authored', label: 'Created' },
  { value: 'reviewing', label: 'Review requests' }
]

type Shown = 'all' | 'open' | 'closed'
type Sort = 'updated' | 'least-updated' | 'newest' | 'oldest'

const SORTS: { value: Sort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'least-updated', label: 'Least recently updated' }
]

const isOpen = (pr: PullRequestSummary): boolean => {
  const state = stateKey(pr.state)
  return state === 'open' || state === 'draft'
}

/**
 * Real pull requests via the `gh` CLI (main/github.ts), drawn as GitHub
 * draws them: the list as github.com/pulls has it, and one pull request as
 * its own page there, with Conversation, Commits, Checks and Files changed.
 * Styles: pullRequests/pull-requests.css.
 */
export function PullRequestsPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState<Shown>('all')
  const [sort, setSort] = useState<Sort>('updated')
  const [data, setData] = useState<PullRequestsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const sortMenu = useDisclosure()
  const sortAnchor = useRef<HTMLButtonElement>(null)

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
  const inTab = useMemo(() => {
    const matches = (pr: PullRequestSummary): boolean =>
      !q || pr.title.toLowerCase().includes(q) || pr.repo.toLowerCase().includes(q) || `#${pr.number}` === q || pr.author.toLowerCase().includes(q)
    const authored = (data?.authored ?? []).filter(matches)
    const reviewing = (data?.reviewing ?? []).filter(matches)
    if (tab === 'authored') return authored
    if (tab === 'reviewing') return reviewing
    // Asked of you and yours: one list, each once.
    const seen = new Set<string>()
    return [...reviewing, ...authored].filter((pr) => !seen.has(pr.id) && seen.add(pr.id))
  }, [data, tab, q])

  const openCount = inTab.filter(isOpen).length
  const closedCount = inTab.length - openCount
  const list = useMemo(() => {
    const time = (pr: PullRequestSummary): number => new Date(sort === 'newest' || sort === 'oldest' ? pr.createdAt : pr.updatedAt).getTime()
    return inTab
      .filter((pr) => shown === 'all' || (shown === 'open') === isOpen(pr))
      .sort((a, b) => (sort === 'oldest' || sort === 'least-updated' ? time(a) - time(b) : time(b) - time(a)))
  }, [inTab, shown, sort])

  const all = [...(data?.authored ?? []), ...(data?.reviewing ?? [])]
  const selected = all.find((pr) => pr.id === selectedId) ?? null

  return (
    <div className="pr-page gh">
      <TopBar
        left={<span className="chat-header__title">Pull requests</span>}
        right={
          <button className="icon-btn" aria-label="Refresh" title="Refresh" onClick={load} disabled={loading}>
            <RefreshCw size={15} strokeWidth={1.9} className={loading ? 'spinner' : undefined} />
          </button>
        }
      />

      <div className="pr-shell">
        <aside className="pr-pane">
          <div className="pr-pane__head">
            <nav className="gh-subnav" aria-label="Which pull requests">
              {TABS.map((t) => (
                <button key={t.value} type="button" className="gh-subnav__item" aria-current={tab === t.value ? 'page' : undefined} onClick={() => setTab(t.value)}>
                  {t.label}
                </button>
              ))}
            </nav>
            <label className="gh-search">
              <Octicon name="search" />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all pull requests" aria-label="Search pull requests" />
            </label>
          </div>

          <div className="pr-list scroll">
            <div className="gh-box gh-list">
              <div className="gh-box__header gh-list__header">
                <button type="button" className="gh-list__state" aria-pressed={shown === 'open'} onClick={() => setShown(shown === 'open' ? 'all' : 'open')}>
                  <Octicon name="git-pull-request" />
                  {openCount} Open
                </button>
                <button type="button" className="gh-list__state" aria-pressed={shown === 'closed'} onClick={() => setShown(shown === 'closed' ? 'all' : 'closed')}>
                  <Octicon name="check" />
                  {closedCount} Closed
                </button>
                <span className="gh-list__spacer" />
                <button ref={sortAnchor} type="button" className="gh-list__menu" aria-haspopup="menu" aria-expanded={sortMenu.open} onClick={sortMenu.toggle}>
                  Sort <Octicon name="triangle-down" />
                </button>
                <Popover anchor={sortAnchor} open={sortMenu.open} onClose={sortMenu.close} placement="bottom-end" width={220}>
                  <div className="menu__label">Sort by</div>
                  {SORTS.map((s) => (
                    <MenuItem
                      key={s.value}
                      title={s.label}
                      checked={sort === s.value}
                      onClick={() => {
                        setSort(s.value)
                        sortMenu.close()
                      }}
                    />
                  ))}
                </Popover>
              </div>

              {loading && <Loading>Loading pull requests…</Loading>}
              {!loading && data?.error && <PrListError error={data.error} retry={load} />}
              {!loading && !data?.error && list.length === 0 && (
                <div className="gh-blank">
                  <Octicon name="git-pull-request" size={24} />
                  <h3>{q || shown !== 'all' ? 'No results matched your search.' : 'No pull requests'}</h3>
                  {q && <p>Try a different word, or clear the search.</p>}
                </div>
              )}
              {!loading && list.map((pr) => <PrRow key={pr.id} pr={pr} active={pr.id === selectedId} onSelect={() => setSelectedId(pr.id)} />)}
            </div>
          </div>
        </aside>

        <section className="pr-detail scroll">
          {selected ? (
            <PrDetail key={selected.id} pr={selected} onChanged={load} />
          ) : (
            !loading &&
            list.length > 0 && (
              <div className="gh-blank gh-blank--page">
                <Octicon name="git-pull-request" size={24} />
                <h3>Select a pull request</h3>
                <p>Its conversation, commits, checks and changes show here.</p>
              </div>
            )
          )}
        </section>
      </div>
    </div>
  )
}

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
      <div className="gh-blank">
        <Octicon name="git-pull-request" size={24} />
        <h3>{missing ? 'Install GitHub CLI to see your pull requests' : 'Sign in to GitHub CLI to see your pull requests'}</h3>
        <p>
          {missing ? 'Get it from cli.github.com, then run ' : 'In a terminal, run '}
          <code className="gh-code">gh auth login</code>
        </p>
        <span className="gh-blank__actions">
          {missing && (
            <button type="button" className="gh-btn gh-btn--sm" onClick={() => void window.api.app.openExternal('https://cli.github.com')}>
              Get GitHub CLI
            </button>
          )}
          <button type="button" className="gh-btn gh-btn--sm" onClick={retry}>
            Check again
          </button>
        </span>
      </div>
    )
  }
  return (
    <div className="gh-flash" data-tone="danger">
      {error}
      <button type="button" className="gh-btn gh-btn--sm" onClick={retry}>
        Retry
      </button>
    </div>
  )
}

/** "#5 opened 2 days ago by sanscreates", "#5 by sanscreates was merged 2 days ago": GitHub's line under a title. */
function RowMeta({ pr }: { pr: PullRequestSummary }): JSX.Element {
  const state = stateKey(pr.state)
  const by = pr.author ? <span className="gh-row__author">{pr.author}</span> : null
  return (
    <span className="gh-row__meta">
      <span className="gh-row__repo">
        {pr.repo}#{pr.number || numberOf(pr.url)}
      </span>{' '}
      {state === 'merged' || state === 'closed' ? (
        <>
          {by && <>by {by} </>}was {state} <RelativeTime iso={pr.closedAt ?? pr.updatedAt} />
        </>
      ) : (
        <>
          opened <RelativeTime iso={pr.createdAt} />
          {by && <> by {by}</>}
          {state === 'draft' && <> · Draft</>}
        </>
      )}
    </span>
  )
}

function PrRow({ pr, active, onSelect }: { pr: PullRequestSummary; active: boolean; onSelect: () => void }): JSX.Element {
  const state = stateKey(pr.state)
  return (
    <div className="gh-row" data-active={active || undefined} role="button" tabIndex={0} aria-current={active || undefined} onClick={onSelect} onKeyDown={(e) => e.key === 'Enter' && onSelect()}>
      <span className="gh-row__icon" data-state={state} title={STATE[state].label}>
        <Octicon name={STATE[state].icon} />
      </span>
      <div className="gh-row__main">
        <span className="gh-row__title">{pr.title}</span>
        {pr.labels.length > 0 && (
          <span className="gh-row__labels">
            {pr.labels.map((label) => (
              <GhLabel key={label.name} label={label} />
            ))}
          </span>
        )}
        <RowMeta pr={pr} />
      </div>
      {pr.comments > 0 && (
        <span className="gh-row__comments" title={`${pr.comments} ${pr.comments === 1 ? 'comment' : 'comments'}`}>
          <Octicon name="comment" />
          {pr.comments}
        </span>
      )}
    </div>
  )
}

type DetailTab = 'conversation' | 'commits' | 'checks' | 'files'

const DETAIL_TABS: { value: DetailTab; label: string; icon: OcticonName }[] = [
  { value: 'conversation', label: 'Conversation', icon: 'comment-discussion' },
  { value: 'commits', label: 'Commits', icon: 'git-commit' },
  { value: 'checks', label: 'Checks', icon: 'checklist' },
  { value: 'files', label: 'Files changed', icon: 'file-diff' }
]

/**
 * One pull request, as its page on GitHub: the title and number, its state
 * and branches, the four tabs, and what each holds. Every action goes through
 * `gh` as the signed-in GitHub user (main/github.ts).
 */
function PrDetail({ pr, onChanged }: { pr: PullRequestSummary; onChanged: () => void }): JSX.Element {
  const [tab, setTab] = useState<DetailTab>('conversation')
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

  const state = stateKey(detail?.state ?? pr.state)
  const [owner, name] = pr.repo.split('/')
  const failing = detail?.checks.filter((c) => c.status === 'failed').length ?? 0
  const count = (t: DetailTab): { text: string; tone?: 'danger' } | null => {
    if (!detail) return null
    if (t === 'conversation') return { text: String(detail.comments.length) }
    if (t === 'commits') return { text: String(detail.commits.length) }
    if (t === 'files') return { text: String(detail.changedFiles) }
    if (t === 'checks') return failing ? { text: String(failing), tone: 'danger' } : { text: String(detail.checks.length) }
    return null
  }
  const commits = detail?.commits.length ?? 0
  const commitWords = detail ? `${commits} ${commits === 1 ? 'commit' : 'commits'} ` : ''

  return (
    <div className="pr-detail__inner">
      <header className="gh-header">
        <div className="gh-header__repo">
          <Octicon name="repo" />
          <span>{owner}</span>
          <span className="gh-muted">/</span>
          <strong>{name}</strong>
        </div>
        <div className="gh-header__top">
          <h1 className="gh-title">
            <bdi>{detail?.title ?? pr.title}</bdi> <span className="gh-title__num">#{detail?.number ?? pr.number ?? numberOf(pr.url)}</span>
          </h1>
          <button type="button" className="gh-btn gh-btn--sm gh-header__open" onClick={() => void window.api.app.openExternal(pr.url)}>
            Open on GitHub
            <Octicon name="link-external" />
          </button>
        </div>
        <div className="gh-header__meta">
          <StateLabel state={state} />
          <span className="gh-header__sentence">
            {state === 'merged' ? (
              <>
                <strong className="gh-who">{detail?.mergedBy ?? detail?.author ?? pr.author}</strong> merged {commitWords}into {detail && <BranchRef name={detail.base} />} from <BranchRef name={detail?.head ?? pr.branch} />{' '}
                {detail?.mergedAt && <RelativeTime iso={detail.mergedAt} />}
              </>
            ) : (
              <>
                <strong className="gh-who">{detail?.author ?? pr.author}</strong> wants to merge {commitWords}into {detail && <BranchRef name={detail.base} />} from <BranchRef name={detail?.head ?? pr.branch} />
              </>
            )}
          </span>
        </div>
      </header>

      <nav className="gh-tabnav" role="tablist" aria-label="Pull request">
        {DETAIL_TABS.map((t) => {
          const badge = count(t.value)
          return (
            <button key={t.value} type="button" role="tab" className="gh-tabnav__tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)}>
              <Octicon name={t.icon} />
              {t.label}
              {badge && <Counter tone={badge.tone}>{badge.text}</Counter>}
            </button>
          )
        })}
        <span className="gh-tabnav__stats">
          <Diffstat additions={detail?.additions ?? pr.additions} deletions={detail?.deletions ?? pr.deletions} />
        </span>
      </nav>

      {error && <div className="gh-flash" data-tone="danger">{error}</div>}
      {!detail && !error && <Loading>Loading…</Loading>}
      {detail && tab === 'conversation' && <Conversation pr={pr} detail={detail} after={after} onTab={setTab} />}
      {detail && tab === 'commits' && <Commits detail={detail} />}
      {detail && tab === 'checks' && <Checks detail={detail} />}
      {detail && tab === 'files' && <ChangedFiles detail={detail} />}
    </div>
  )
}
