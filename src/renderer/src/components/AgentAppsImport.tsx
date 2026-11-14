import { useEffect, useState, type JSX } from 'react'
import type { AgentAppImportResult, AgentAppScan, ForeignScripts, ForeignSession } from '@shared/agentApps'
import { folderName, homeRelative } from '@shared/adeSessions'
import { useAdeSessions } from './code/sessionsStore'
import { useTerminals } from './code/terminal/terminalStore'

/**
 * Import from other agent apps (shared/agentApps.ts): the sessions and
 * project scripts Conductor, Orca, Paradev (Superset), Claude Squad, T3
 * Code, Synara and Crystal have on this computer, each with a box. Used by
 * the setup's import step and by Settings → ADE. Every script is shown in full before it is
 * kept, and a session says which conversation it reopens.
 *
 * A session's and a project's keys can be the same folder, so the boxes
 * are kept as `s|key` and `p|key`.
 */

export interface AgentAppsState {
  /** Null until the first scan has come back. */
  apps: AgentAppScan[] | null
  picked: Set<string>
  toggle: (box: string) => void
  /** How many boxes are ticked. */
  count: number
  /** Sessions and script sets found, the ones in Eaon already included. */
  total: number
  working: boolean
  error: string | null
  done: AgentAppImportResult | null
  /** Script sets brought in since the list was shown. */
  kept: Set<string>
  run: () => Promise<AgentAppImportResult | null>
  rescan: () => void
}

const sessionBox = (s: ForeignSession): string => `s|${s.key}`
const scriptsBox = (s: ForeignScripts): string => `p|${s.key}`

/** What starts ticked: everything the ADE doesn't have. The list above the button is the consent. */
const ticked = (apps: AgentAppScan[]): Set<string> =>
  new Set(apps.flatMap((app) => [...app.sessions.filter((s) => !s.already).map(sessionBox), ...app.scripts.map(scriptsBox)]))

export function useAgentAppsImport(): AgentAppsState {
  const [apps, setApps] = useState<AgentAppScan[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<AgentAppImportResult | null>(null)
  const [kept, setKept] = useState<Set<string>>(new Set())
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let live = true
    window.api.agentApps
      .scan()
      .then((found) => {
        if (!live) return
        setApps(found)
        setPicked(ticked(found))
      })
      .catch(() => live && setApps([]))
    return () => {
      live = false
    }
  }, [generation])

  const toggle = (box: string): void =>
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(box)) next.add(box)
      return next
    })

  const run = async (): Promise<AgentAppImportResult | null> => {
    setWorking(true)
    setError(null)
    try {
      const keys = [...picked]
      const result = await window.api.agentApps.import({
        sessions: keys.filter((k) => k.startsWith('s|')).map((k) => k.slice(2)),
        scripts: keys.filter((k) => k.startsWith('p|')).map((k) => k.slice(2))
      })
      await useAdeSessions.getState().load()
      // Each session's conversation, reopened in a pane of its own: once, in a folder with no panes yet.
      if (result.panes.length) {
        const terminals = useTerminals.getState()
        await terminals.load()
        for (const pane of result.panes) if (!(useTerminals.getState().layout[pane.cwd]?.length ?? 0)) useTerminals.getState().add(pane.cwd, pane.agent, pane.resume)
      }
      setDone(result)
      setKept((have) => new Set([...have, ...keys.filter((k) => k.startsWith('p|'))]))
      // What came in now shows as in the ADE, unticked.
      setApps((list) => list?.map((app) => ({ ...app, sessions: app.sessions.map((s) => (picked.has(sessionBox(s)) ? { ...s, already: true } : s)) })) ?? null)
      setPicked(new Set())
      return result
    } catch {
      setError('Couldn’t import those. Try again, or open them in the ADE yourself.')
      return null
    } finally {
      setWorking(false)
    }
  }

  return {
    apps,
    picked,
    toggle,
    count: picked.size,
    total: (apps ?? []).reduce((n, app) => n + app.sessions.length + app.scripts.length, 0),
    working,
    error,
    done,
    kept,
    run,
    rescan: () => {
      setDone(null)
      setKept(new Set())
      setGeneration((g) => g + 1)
    }
  }
}

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const

/** The sessions and scripts, grouped by the app they came from. */
export function AgentAppsList({ state, home }: { state: AgentAppsState; home: string | null }): JSX.Element {
  const { apps, picked, toggle, kept } = state
  const tidy = (path: string): string => homeRelative(path, home)
  if (apps === null) return <p className="import__empty">Looking for sessions in your other agent apps…</p>
  if (apps.length === 0) return <p className="import__empty">No sessions found in Conductor, Orca, Paradev (Superset), Claude Squad, T3 Code, Synara or Crystal on this computer.</p>
  return (
    <div className="import edge-fade">
      {apps.map((app) => (
        <section key={app.id} className="import__app">
          <h2 className="import__app-name">{app.name}</h2>
          {app.error && <p className="import__what">Couldn’t read {app.name}’s sessions: {app.error}</p>}
          {app.sessions.map((s) => (
            <label key={s.key} className="import__row" data-disabled={s.already || undefined}>
              <input type="checkbox" className="import__check" checked={s.already || picked.has(sessionBox(s))} disabled={s.already} onChange={() => toggle(sessionBox(s))} />
              <span className="import__body">
                <span className="import__name">
                  {s.title || folderName(s.cwd)}
                  {s.project && s.project !== s.cwd && <span className="import__in"> in {folderName(s.project)}</span>}
                  {s.already ? <span className="import__badge">In the ADE</span> : s.archived ? <span className="import__badge">Archived</span> : null}
                </span>
                <span className="import__what import__path" title={s.cwd}>
                  {tidy(s.cwd)}
                  {s.branch ? ` · ${s.branch}` : ''}
                </span>
                {s.agent && s.resume && <span className="import__env">Reopens its {AGENT_NAMES[s.agent]} conversation</span>}
              </span>
            </label>
          ))}
          {app.scripts.map((s) => (
            <label key={s.key} className="import__row" data-disabled={kept.has(scriptsBox(s)) || undefined}>
              <input
                type="checkbox"
                className="import__check"
                checked={kept.has(scriptsBox(s)) || picked.has(scriptsBox(s))}
                disabled={kept.has(scriptsBox(s))}
                onChange={() => toggle(scriptsBox(s))}
              />
              <span className="import__body">
                <span className="import__name">
                  Scripts for {folderName(s.project)}
                  <span className="import__in"> from {s.source}</span>
                  {kept.has(scriptsBox(s)) && <span className="import__badge">Kept</span>}
                </span>
                {s.commands.map((c) => (
                  <span key={`${c.name}:${c.command}`} className="import__what import__command" title={c.command}>
                    <span className="import__command-name">{c.name}</span>
                    <code>{c.command}</code>
                  </span>
                ))}
              </span>
            </label>
          ))}
        </section>
      ))}
    </div>
  )
}

/** "Imported 3 sessions and scripts for 1 project." */
export function importedLine(result: AgentAppImportResult): string {
  const parts = [
    result.sessions ? `${result.sessions} ${result.sessions === 1 ? 'session' : 'sessions'}` : '',
    result.scripts ? `scripts for ${result.scripts} ${result.scripts === 1 ? 'project' : 'projects'}` : ''
  ].filter(Boolean)
  return parts.length ? `Imported ${parts.join(' and ')}.` : 'Nothing new to import.'
}
