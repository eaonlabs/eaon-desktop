import { useEffect, useState } from 'react'
import type { AgentAppImportResult, AgentAppScan, ForeignScripts, ForeignSession } from '@shared/agentApps'
import { useAdeSessions } from './code/sessionsStore'
import { useTerminals } from './code/terminal/terminalStore'

/**
 * Import from other agent apps (shared/agentApps.ts): what the sessions and
 * project scripts Conductor, Orca, Paradev (Superset), Claude Squad, T3
 * Code, Synara and Crystal have on this computer are, picked, and how they
 * come in. ImportSources.tsx shows them.
 *
 * A session's and a project's keys can be the same folder, so the boxes
 * are kept as `s|key` and `p|key`.
 */

export interface AgentAppsState {
  /** Null until the first scan has come back. */
  apps: AgentAppScan[] | null
  picked: Set<string>
  toggle: (box: string) => void
  /** Ticks or unticks several at once (an app's whole row). */
  pick: (boxes: string[], on: boolean) => void
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

export const sessionBox = (s: ForeignSession): string => `s|${s.key}`
export const scriptsBox = (s: ForeignScripts): string => `p|${s.key}`

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

  const pick = (boxes: string[], on: boolean): void =>
    setPicked((current) => {
      const next = new Set(current)
      for (const box of boxes) {
        if (on) next.add(box)
        else next.delete(box)
      }
      return next
    })

  return {
    apps,
    picked,
    toggle,
    pick,
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

/** "Imported 3 sessions and the commands for 1 project." */
export function importedLine(result: AgentAppImportResult): string {
  const parts = [
    result.sessions ? `${result.sessions} ${result.sessions === 1 ? 'session' : 'sessions'}` : '',
    result.scripts ? `the commands for ${result.scripts} ${result.scripts === 1 ? 'project' : 'projects'}` : ''
  ].filter(Boolean)
  return parts.length ? `Imported ${parts.join(' and ')}.` : 'Nothing new to import.'
}
