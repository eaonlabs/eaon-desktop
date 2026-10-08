import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, Loader2, Play, RefreshCw, SquareTerminal } from 'lucide-react'
import { TopBar } from './TopBar'
import { SearchField, Select } from './ui'
import { notify } from './Notice'
import { useAdeSessions } from './code/sessionsStore'
import { folderName } from '@shared/adeSessions'
import type { LinearIssue, LinearIssuesResult, LinearStatus } from '@shared/linear'

const PROJECT_KEY = 'eaon.linear.project'
const KEY_PAGE = 'https://linear.app/settings/account/security'

/** Which project each Linear team's issues were last started in. */
function rememberedProject(team: string): string | null {
  try {
    return (JSON.parse(localStorage.getItem(PROJECT_KEY) ?? '{}') as Record<string, string>)[team] ?? null
  } catch {
    return null
  }
}
function rememberProject(team: string, project: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(PROJECT_KEY) ?? '{}') as Record<string, string>
    localStorage.setItem(PROJECT_KEY, JSON.stringify({ ...all, [team]: project }))
  } catch {
    /* remembered where it can be */
  }
}

/** Linear's issues, assigned to you and not done, each one Start away from an ADE session. */
export function LinearPage(): JSX.Element {
  const [status, setStatus] = useState<LinearStatus | null>(null)
  const [data, setData] = useState<LinearIssuesResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const s = await window.api.linear.status()
    setStatus(s)
    if (s.connected) {
      setData(await window.api.linear.issues())
      // Started issues whose pull request has opened since: linked on the issue, moved to review.
      void window.api.linear.sync()
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const issues = data?.ok ? data.issues : []
  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => issues.filter((i) => !q || i.title.toLowerCase().includes(q) || i.identifier.toLowerCase().includes(q) || i.team.name.toLowerCase().includes(q)),
    [issues, q]
  )
  const selected = shown.find((i) => i.id === selectedId) ?? null

  if (status && !status.connected) return <ConnectLinear onConnected={(s) => (setStatus(s), void load())} error={status.error} />

  return (
    <div className="pr-page">
      <TopBar
        left={<span className="chat-header__title">Linear</span>}
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
            {data?.ok && shown.length === 0 && <div className="pr-empty">No open issues assigned to you</div>}
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
                <span className="linear-state" style={{ background: issue.state.color }} title={issue.state.name} />
                <div className="pr-row__body">
                  <div className="pr-row__top">
                    <span className="pr-row__title">{issue.title}</span>
                  </div>
                  <div className="pr-row__bottom">
                    <span className="pr-row__repo">
                      {issue.identifier} · {issue.state.name}
                    </span>
                    {data?.ok && data.sessions[issue.id] && <span className="linear-started">In the ADE</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {status?.user && (
            <div className="linear-who">
              {status.user.name}
              <button
                type="button"
                className="link-btn"
                onClick={() => void window.api.linear.disconnect().then((s) => (setStatus(s), setData(null)))}
              >
                Disconnect
              </button>
            </div>
          )}
        </aside>
        <section className="pr-detail scroll">
          {selected ? (
            <IssueDetail issue={selected} sessionCwd={data?.ok ? (data.sessions[selected.id] ?? null) : null} onStarted={() => void load()} />
          ) : (
            <div className="pr-detail__empty">Select an issue to see it here</div>
          )}
        </section>
      </div>
    </div>
  )
}

function IssueDetail({ issue, sessionCwd, onStarted }: { issue: LinearIssue; sessionCwd: string | null; onStarted: () => void }): JSX.Element {
  const sessions = useAdeSessions((s) => s.sessions)
  // Projects an issue can be started in: the ADE's git projects.
  const projects = useMemo(() => [...new Set(sessions.filter((s) => s.repo).map((s) => s.project))], [sessions])
  const [project, setProject] = useState<string>(() => rememberedProject(issue.team.id) ?? '')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void useAdeSessions.getState().load()
  }, [])
  useEffect(() => {
    setError(null)
    setProject(rememberedProject(issue.team.id) ?? '')
  }, [issue.id, issue.team.id])
  const chosen = projects.includes(project) ? project : (projects[0] ?? '')

  const start = async (): Promise<void> => {
    if (!chosen) return
    setStarting(true)
    setError(null)
    const result = await window.api.linear.start(issue.id, chosen)
    setStarting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    rememberProject(issue.team.id, chosen)
    if (result.moved) notify(`${issue.identifier} moved to ${result.moved}.`, 'done')
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
        {issue.identifier} · {issue.team.name}
      </div>
      <h1 className="pr-detail__title">{issue.title}</h1>
      <div className="pr-detail__meta">
        <span className="linear-pill">
          <span className="linear-state" style={{ background: issue.state.color }} />
          {issue.state.name}
        </span>
        {issue.priority > 0 && <span className="linear-pill">{issue.priorityLabel}</span>}
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
          Open in Linear
        </button>
      </div>
      {!sessionCwd && projects.length > 0 && (
        <p className="pr-review__fine">
          Start makes a session on <code>{issue.branchName}</code> in its own folder, gives Claude Code (or Codex) the issue, and moves it to In Progress. When its pull request opens, it’s
          linked on the issue and the issue moves to In Review.
        </p>
      )}
      {error && (
        <p className="pr-review__error" role="alert">
          {error}
        </p>
      )}
      <div className="linear-description">{issue.description.trim() || 'No description.'}</div>
    </div>
  )
}

function ConnectLinear({ onConnected, error }: { onConnected: (s: LinearStatus) => void; error: string | null }): JSX.Element {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(error)
  const connect = async (): Promise<void> => {
    setBusy(true)
    const s = await window.api.linear.connect(key)
    setBusy(false)
    if (s.connected) onConnected(s)
    else setProblem(s.error)
  }
  return (
    <div className="pr-page">
      <TopBar left={<span className="chat-header__title">Linear</span>} />
      <div className="linear-connect">
        <h1 className="home__title">Connect Linear</h1>
        <p className="term-empty__text">
          Your Linear issues, each one click from an ADE session on its own branch with an agent working on it. Eaon needs a personal API key: make one in Linear under Settings →
          Security &amp; access, and paste it here. It’s kept in Eaon’s encrypted vault.
        </p>
        <div className="linear-connect__row">
          <input
            className="input"
            type="password"
            placeholder="lin_api_…"
            value={key}
            autoFocus
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && key.trim() && void connect()}
          />
          <button className="btn btn--accent" disabled={!key.trim() || busy} onClick={() => void connect()}>
            {busy ? <Loader2 size={14} strokeWidth={2} className="spinner" /> : null}
            Connect
          </button>
        </div>
        <button type="button" className="link-btn" onClick={() => void window.api.app.openExternal(KEY_PAGE)}>
          Make an API key in Linear <ExternalLink size={12} strokeWidth={1.9} />
        </button>
        {problem && (
          <p className="pr-review__error" role="alert">
            {problem}
          </p>
        )}
      </div>
    </div>
  )
}
