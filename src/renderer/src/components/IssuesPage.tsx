import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, Loader2, Play, RefreshCw, SquareTerminal } from 'lucide-react'
import { TopBar } from './TopBar'
import { SearchField, Select } from './ui'
import { notify } from './Notice'
import { useAdeSessions } from './code/sessionsStore'
import { folderName, type AdeSession } from '@shared/adeSessions'
import type { TrackerIssue } from '@shared/trackers'

type Source = 'linear' | 'jira' | 'github'

/** One issue as the page shows it, whichever tracker it came from. */
interface Row {
  source: Source
  id: string
  key: string
  title: string
  description: string
  url: string
  branchName: string
  priorityLabel: string
  status: { name: string; color: string }
  group: { id: string; name: string }
  labels: string[]
}

interface Who {
  connected: boolean
  user: string | null
  site?: string
  error: string | null
}
type Listing = { ok: true; rows: Row[]; sessions: Record<string, string> } | { ok: false; error: string }
type Started = { ok: true; session: AdeSession; prompt: string; moved: string | null } | { ok: false; error: string }

interface SourceDef {
  id: Source
  label: string
  /** What "Open in …" says. */
  openIn: string
  /** What Start does to the issue, said under the button. */
  startNote: (branch: string) => string
  status: () => Promise<Who>
  issues: () => Promise<Listing>
  start: (id: string, project: string) => Promise<Started>
  sync: () => Promise<void>
  disconnect: () => Promise<Who>
}

const fromTracker = (issue: TrackerIssue): Row => ({ ...issue, source: issue.tracker, status: { name: issue.status.name, color: issue.status.color } })

const SOURCES: SourceDef[] = [
  {
    id: 'linear',
    label: 'Linear',
    openIn: 'Linear',
    startNote: (branch) =>
      `Start makes a session on ${branch} in its own folder, gives Claude Code (or Codex) the issue, and moves it to In Progress. When its pull request opens, it’s linked on the issue and the issue moves to In Review.`,
    status: async () => {
      const s = await window.api.linear.status()
      return { connected: s.connected, user: s.user?.name ?? null, error: s.error }
    },
    issues: async () => {
      const r = await window.api.linear.issues()
      if (!r.ok) return r
      return {
        ok: true,
        sessions: r.sessions,
        rows: r.issues.map((i) => ({
          source: 'linear' as const,
          id: i.id,
          key: i.identifier,
          title: i.title,
          description: i.description,
          url: i.url,
          branchName: i.branchName,
          priorityLabel: i.priority > 0 ? i.priorityLabel : '',
          status: { name: i.state.name, color: i.state.color },
          group: { id: i.team.id, name: i.team.name },
          labels: []
        }))
      }
    },
    start: (id, project) => window.api.linear.start(id, project),
    sync: () => window.api.linear.sync(),
    disconnect: async () => {
      const s = await window.api.linear.disconnect()
      return { connected: s.connected, user: null, error: s.error }
    }
  },
  {
    id: 'jira',
    label: 'Jira',
    openIn: 'Jira',
    startNote: (branch) =>
      `Start makes a session on ${branch} in its own folder, gives Claude Code (or Codex) the issue, and moves it to In Progress. When its pull request opens, it’s linked on the issue and the issue moves to In Review, if your project has that status.`,
    status: async () => {
      const s = await window.api.trackers.status('jira')
      return { connected: s.connected, user: s.user?.name ?? null, site: s.site, error: s.error }
    },
    issues: async () => {
      const r = await window.api.trackers.issues('jira')
      return r.ok ? { ok: true, sessions: r.sessions, rows: r.issues.map(fromTracker) } : r
    },
    start: (id, project) => window.api.trackers.start('jira', id, project),
    sync: () => window.api.trackers.sync(),
    disconnect: async () => {
      const s = await window.api.trackers.disconnect('jira')
      return { connected: s.connected, user: null, error: s.error }
    }
  },
  {
    id: 'github',
    label: 'GitHub',
    openIn: 'GitHub',
    startNote: (branch) =>
      `Start makes a session on ${branch} in its own folder and gives Claude Code (or Codex) the issue. The agent is told to put “Closes” and the issue in the pull request, so GitHub links it and closes the issue when it merges.`,
    status: async () => {
      const s = await window.api.trackers.status('github')
      return { connected: s.connected, user: s.user?.name ?? null, error: s.error }
    },
    issues: async () => {
      const r = await window.api.trackers.issues('github')
      return r.ok ? { ok: true, sessions: r.sessions, rows: r.issues.map(fromTracker) } : r
    },
    start: (id, project) => window.api.trackers.start('github', id, project),
    sync: async () => undefined,
    disconnect: async () => ({ connected: true, user: null, error: null })
  }
]

const SOURCE_KEY = 'eaon.issues.source'
const PROJECT_KEY = 'eaon.issues.project'

function rememberedSource(): Source {
  try {
    const saved = localStorage.getItem(SOURCE_KEY)
    return SOURCES.some((s) => s.id === saved) ? (saved as Source) : 'linear'
  } catch {
    return 'linear'
  }
}

/** Which project each tracker group's issues (a Linear team, a Jira project, a repository) were last started in. */
function rememberedProject(group: string): string | null {
  try {
    return (JSON.parse(localStorage.getItem(PROJECT_KEY) ?? '{}') as Record<string, string>)[group] ?? null
  } catch {
    return null
  }
}
function rememberProject(group: string, project: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(PROJECT_KEY) ?? '{}') as Record<string, string>
    localStorage.setItem(PROJECT_KEY, JSON.stringify({ ...all, [group]: project }))
  } catch {
    /* remembered where it can be */
  }
}

/** Issues assigned to you and not done, from Linear, Jira or GitHub, each one Start away from an ADE session. */
export function IssuesPage(): JSX.Element {
  const [sourceId, setSourceId] = useState<Source>(rememberedSource)
  const source = SOURCES.find((s) => s.id === sourceId) ?? SOURCES[0]
  const [status, setStatus] = useState<Who | null>(null)
  const [data, setData] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const s = await source.status()
    setStatus(s)
    if (s.connected && !s.error) {
      setData(await source.issues())
      // Started issues whose pull request has opened since: linked on the issue, moved to review.
      void source.sync()
    } else setData(null)
    setLoading(false)
  }, [source])

  // Another source: nothing of the last one stays on the page while this one loads.
  useEffect(() => {
    setStatus(null)
    setData(null)
    setSelectedId(null)
    setQuery('')
    void load()
  }, [load])

  const pick = (id: Source): void => {
    setSourceId(id)
    try {
      localStorage.setItem(SOURCE_KEY, id)
    } catch {
      /* remembered where it can be */
    }
  }

  const issues = data?.ok ? data.rows : []
  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => issues.filter((i) => !q || i.title.toLowerCase().includes(q) || i.key.toLowerCase().includes(q) || i.group.name.toLowerCase().includes(q) || i.labels.some((l) => l.toLowerCase().includes(q))),
    [issues, q]
  )
  const selected = shown.find((i) => i.id === selectedId) ?? null

  const tabs = (
    <div className="issues-tabs" role="tablist" aria-label="Issue tracker">
      {SOURCES.map((s) => (
        <button key={s.id} type="button" role="tab" aria-selected={s.id === sourceId} className="issues-tab" data-on={s.id === sourceId || undefined} onClick={() => pick(s.id)}>
          {s.label}
        </button>
      ))}
    </div>
  )

  if (status && (!status.connected || (status.error && !data))) {
    return <Connect source={source} tabs={tabs} error={status.error} onConnected={() => void load()} connected={status.connected} />
  }

  return (
    <div className="pr-page">
      <TopBar
        left={tabs}
        right={
          <button className="icon-btn" aria-label="Refresh" title="Refresh" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} strokeWidth={1.9} className={loading ? 'spinner' : undefined} />
          </button>
        }
      />
      <div className="pr-shell">
        <aside className="pr-pane">
          <div className="pr-pane__head">
            <div className="pr-search">
              <SearchField value={query} onChange={setQuery} placeholder="Search your issues" variant="sm" />
            </div>
          </div>
          <div className="pr-list scroll">
            {(loading || !status) && !data && (
              <div className="pr-empty">
                <Loader2 size={16} strokeWidth={2} className="spinner" />
                Loading issues…
              </div>
            )}
            {data && !data.ok && (
              <div className="pr-empty pr-empty--error">
                {data.error}
                <button className="btn btn--sm" onClick={() => void load()}>
                  Retry
                </button>
              </div>
            )}
            {data?.ok && shown.length === 0 && <div className="pr-empty">{q ? 'No issue matches that' : 'No open issues assigned to you'}</div>}
            {shown.map((issue) => (
              <div
                key={issue.id}
                className="pr-row"
                data-active={issue.id === selectedId || undefined}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(issue.id)}
                onKeyDown={(e) => e.key === 'Enter' && setSelectedId(issue.id)}
              >
                <span className="linear-state" style={{ background: issue.status.color }} title={issue.status.name} />
                <div className="pr-row__body">
                  <div className="pr-row__top">
                    <span className="pr-row__title">{issue.title}</span>
                  </div>
                  <div className="pr-row__bottom">
                    <span className="pr-row__repo">
                      {source.id === 'github' ? `${issue.group.name}${issue.key}` : `${issue.key} · ${issue.status.name}`}
                    </span>
                    {data?.ok && data.sessions[issue.id] && <span className="linear-started">In the ADE</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {status?.user && (
            <div className="linear-who">
              <span title={status.site}>{status.site ? `${status.user} · ${status.site.replace(/^https?:\/\//, '')}` : status.user}</span>
              {source.id !== 'github' && (
                <button type="button" className="link-btn" onClick={() => void source.disconnect().then((s) => (setStatus(s), setData(null)))}>
                  Disconnect
                </button>
              )}
            </div>
          )}
        </aside>
        <section className="pr-detail scroll">
          {selected ? (
            <IssueDetail source={source} issue={selected} sessionCwd={data?.ok ? (data.sessions[selected.id] ?? null) : null} onStarted={() => void load()} />
          ) : (
            <div className="pr-detail__empty">Select an issue to see it here</div>
          )}
        </section>
      </div>
    </div>
  )
}

function IssueDetail({ source, issue, sessionCwd, onStarted }: { source: SourceDef; issue: Row; sessionCwd: string | null; onStarted: () => void }): JSX.Element {
  const sessions = useAdeSessions((s) => s.sessions)
  // Projects an issue can be started in: the ADE's git projects.
  const projects = useMemo(() => [...new Set(sessions.filter((s) => s.repo).map((s) => s.project))], [sessions])
  const memory = `${source.id}:${issue.group.id}`
  const [project, setProject] = useState<string>(() => rememberedProject(memory) ?? '')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void useAdeSessions.getState().load()
  }, [])
  useEffect(() => {
    setError(null)
    setProject(rememberedProject(memory) ?? '')
  }, [issue.id, memory])
  const chosen = projects.includes(project) ? project : (projects[0] ?? '')

  const start = async (): Promise<void> => {
    if (!chosen) return
    setStarting(true)
    setError(null)
    const result = await source.start(issue.id, chosen)
    setStarting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    rememberProject(memory, chosen)
    if (result.moved) notify(`${issue.key} moved to ${result.moved}.`, 'done')
    const failed = await useAdeSessions.getState().startTask(result.session, result.prompt)
    if (failed) notify(failed, 'error')
    onStarted()
  }

  const openSession = async (): Promise<void> => {
    if (!sessionCwd) return
    await useAdeSessions.getState().load()
    const session = useAdeSessions.getState().sessions.find((s) => s.cwd === sessionCwd)
    if (session) await useAdeSessions.getState().show(session)
  }

  return (
    <div className="pr-detail__inner">
      <div className="pr-detail__repo">
        {source.id === 'github' ? `${issue.group.name}${issue.key}` : `${issue.key} · ${issue.group.name}`}
      </div>
      <h1 className="pr-detail__title">{issue.title}</h1>
      <div className="pr-detail__meta">
        <span className="linear-pill">
          <span className="linear-state" style={{ background: issue.status.color }} />
          {issue.status.name}
        </span>
        {issue.priorityLabel && <span className="linear-pill">{issue.priorityLabel}</span>}
        {issue.labels.slice(0, 6).map((l) => (
          <span key={l} className="linear-pill">
            {l}
          </span>
        ))}
        <span className="pr-detail__branch">{issue.branchName}</span>
      </div>
      <div className="linear-actions">
        {sessionCwd ? (
          <button className="btn btn--accent" onClick={() => void openSession()}>
            <SquareTerminal size={14} strokeWidth={1.9} />
            Open session
          </button>
        ) : projects.length === 0 ? (
          <p className="pr-review__text">Open a project folder in the ADE first; the issue gets a branch of its own there.</p>
        ) : (
          <>
            <Select value={chosen} options={projects.map((p) => ({ value: p, label: folderName(p) }))} onChange={setProject} width={220} />
            <button className="btn btn--accent" disabled={starting} onClick={() => void start()}>
              {starting ? <Loader2 size={14} strokeWidth={2} className="spinner" /> : <Play size={14} strokeWidth={1.9} />}
              {starting ? 'Starting…' : 'Start in the ADE'}
            </button>
          </>
        )}
        <button className="btn" onClick={() => void window.api.app.openExternal(issue.url)}>
          <ExternalLink size={14} strokeWidth={1.9} />
          Open in {source.openIn}
        </button>
      </div>
      {!sessionCwd && projects.length > 0 && <p className="pr-review__fine">{source.startNote(issue.branchName)}</p>}
      {error && (
        <p className="pr-review__error" role="alert">
          {error}
        </p>
      )}
      <div className="linear-description">{issue.description.trim() || 'No description.'}</div>
    </div>
  )
}

const LINEAR_KEY_PAGE = 'https://linear.app/settings/account/security'
const JIRA_TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens'
const GITHUB_CLI_PAGE = 'https://cli.github.com'

function Connect({ source, tabs, error, connected, onConnected }: { source: SourceDef; tabs: JSX.Element; error: string | null; connected: boolean; onConnected: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(error)
  const [key, setKey] = useState('')
  const [site, setSite] = useState('')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  useEffect(() => setProblem(error), [error, source.id])

  const submit = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    const s =
      source.id === 'linear'
        ? await window.api.linear.connect(key)
        : source.id === 'jira'
          ? await window.api.trackers.connect('jira', { site, email, token })
          : await window.api.trackers.connect('github')
    setBusy(false)
    if (s.connected && !s.error) onConnected()
    else setProblem(s.error)
  }

  const ready = source.id === 'linear' ? key.trim() : source.id === 'jira' ? site.trim() && email.trim() && token.trim() : true
  const enter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && ready && !busy) void submit()
  }

  return (
    <div className="pr-page">
      <TopBar left={tabs} />
      <div className="linear-connect">
        <h1 className="home__title">Connect {source.label}</h1>
        {source.id === 'linear' && (
          <>
            <p className="term-empty__text">
              Your Linear issues, each one click from an ADE session on its own branch with an agent working on it. Eaon needs a personal API key: make one in Linear under Settings →
              Security &amp; access, and paste it here. It’s kept in Eaon’s encrypted vault.
            </p>
            <div className="linear-connect__row">
              <input aria-label="Linear API key" className="input" type="password" placeholder="lin_api_…" value={key} autoFocus onChange={(e) => setKey(e.target.value)} onKeyDown={enter} />
              <button className="btn btn--accent" disabled={!ready || busy} onClick={() => void submit()}>
                {busy ? <Loader2 size={14} strokeWidth={2} className="spinner" /> : null}
                Connect
              </button>
            </div>
            <button type="button" className="link-btn" onClick={() => void window.api.app.openExternal(LINEAR_KEY_PAGE)}>
              Make an API key in Linear <ExternalLink size={12} strokeWidth={1.9} />
            </button>
          </>
        )}
        {source.id === 'jira' && (
          <>
            <p className="term-empty__text">
              Your Jira Cloud issues, each one click from an ADE session on its own branch with an agent working on it. Eaon needs your site, your Atlassian email and an API token: make
              the token in your Atlassian account and paste it here. It’s kept in Eaon’s encrypted vault and sent only to your Jira site.
            </p>
            <div className="issues-connect__fields">
              <input aria-label="Jira site" className="input" placeholder="acme.atlassian.net" value={site} autoFocus spellCheck={false} onChange={(e) => setSite(e.target.value)} onKeyDown={enter} />
              <input aria-label="Atlassian email" className="input" type="email" placeholder="you@company.com" value={email} spellCheck={false} onChange={(e) => setEmail(e.target.value)} onKeyDown={enter} />
              <input aria-label="Jira API token" className="input" type="password" placeholder="API token" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={enter} />
              <button className="btn btn--accent" disabled={!ready || busy} onClick={() => void submit()}>
                {busy ? <Loader2 size={14} strokeWidth={2} className="spinner" /> : null}
                Connect
              </button>
            </div>
            <button type="button" className="link-btn" onClick={() => void window.api.app.openExternal(JIRA_TOKEN_PAGE)}>
              Make an API token in Atlassian <ExternalLink size={12} strokeWidth={1.9} />
            </button>
          </>
        )}
        {source.id === 'github' && (
          <>
            <p className="term-empty__text">
              The issues assigned to you on GitHub, each one click from an ADE session on its own branch with an agent working on it. Eaon uses the GitHub CLI you’re already signed in
              with, so there’s no token to paste and Eaon keeps none.
            </p>
            <div className="linear-connect__row">
              <button className="btn btn--accent" disabled={busy} onClick={() => void submit()}>
                {busy ? <Loader2 size={14} strokeWidth={2} className="spinner" /> : null}
                {connected ? 'Check again' : 'Use my GitHub sign-in'}
              </button>
            </div>
            <button type="button" className="link-btn" onClick={() => void window.api.app.openExternal(GITHUB_CLI_PAGE)}>
              Get the GitHub CLI <ExternalLink size={12} strokeWidth={1.9} />
            </button>
          </>
        )}
        {problem && (
          <p className="pr-review__error" role="alert">
            {problem}
          </p>
        )}
      </div>
    </div>
  )
}

