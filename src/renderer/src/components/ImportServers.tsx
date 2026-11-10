import { useEffect, useState, type JSX } from 'react'
import type { ImportableApp, ImportResult } from '@shared/importApps'
import { useApp } from '../state/store'

/**
 * Import from another app (shared/importApps.ts): the MCP servers other apps
 * on this computer have, each with a box. Used by the setup's import step and
 * by Settings → MCP Servers. The list shows each server's name, exactly what
 * it runs, and the names of the variables it carries; the values stay in the
 * main process until the import.
 */

export interface ImportState {
  /** Null until the first scan has come back. */
  apps: ImportableApp[] | null
  picked: Set<string>
  toggle: (key: string) => void
  /** How many boxes are ticked. */
  count: number
  /** Servers found in any app, ones Eaon has already included. */
  total: number
  working: boolean
  error: string | null
  run: () => Promise<ImportResult | null>
}

export function useImportServers(): ImportState {
  const [apps, setApps] = useState<ImportableApp[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.api.importApps
      .scan()
      .then((found) => {
        if (!live) return
        setApps(found)
        // Ticked to begin with: the list above the button is the consent, and what is already in Eaon isn't offered twice.
        setPicked(new Set(found.flatMap((app) => app.servers.filter((s) => !s.duplicate).map((s) => s.key))))
      })
      .catch(() => live && setApps([]))
    return () => {
      live = false
    }
  }, [])

  const toggle = (key: string): void =>
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const run = async (): Promise<ImportResult | null> => {
    setWorking(true)
    setError(null)
    try {
      const result = await window.api.importApps.apply([...picked])
      useApp.setState({ mcpServers: result.servers })
      return result
    } catch {
      setError('Couldn’t import those servers. Try again, or add them in Settings → MCP Servers.')
      return null
    } finally {
      setWorking(false)
    }
  }

  return { apps, picked, toggle, count: picked.size, total: (apps ?? []).reduce((n, app) => n + app.servers.length, 0), working, error, run }
}

/** The servers, grouped by the app they came from. */
export function ImportList({ state }: { state: ImportState }): JSX.Element {
  const { apps, picked, toggle } = state
  if (apps === null) return <p className="import__empty">Looking for MCP servers in your other apps…</p>
  const withServers = apps.filter((app) => app.servers.length > 0)
  if (withServers.length === 0) return <p className="import__empty">No MCP servers found in Claude, Cursor, Windsurf, VS Code or Gemini CLI on this computer.</p>
  return (
    <div className="import">
      {withServers.map((app) => (
        <section key={app.id} className="import__app">
          <h2 className="import__app-name">{app.name}</h2>
          {app.servers.map((server) => (
            <label key={server.key} className="import__row" data-disabled={server.duplicate || undefined}>
              <input type="checkbox" className="import__check" checked={picked.has(server.key)} disabled={server.duplicate} onChange={() => toggle(server.key)} />
              <span className="import__body">
                <span className="import__name">
                  {server.name}
                  {server.duplicate && <span className="import__badge">Already in Eaon</span>}
                </span>
                <span className="import__what" title={server.summary}>
                  {server.summary}
                </span>
                {server.envNames.length > 0 && <span className="import__env">Uses {server.envNames.join(', ')}</span>}
              </span>
            </label>
          ))}
        </section>
      ))}
    </div>
  )
}
