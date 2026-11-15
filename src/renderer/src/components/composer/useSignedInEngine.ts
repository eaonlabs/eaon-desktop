import { useEffect, useState } from 'react'
import { CLI_ENGINES, type CliEngineId, type EngineStatus } from '@shared/engines'

/**
 * An agent CLI signed in on this computer (Codex first, from the engine
 * check), or null: with nothing else connected, Chat can run on it straight
 * away with its sign-in and plan, and the model button offers it. Read only
 * while `active`, and again whenever an engine's state changes.
 */
export function useSignedInEngine(active: boolean): CliEngineId | null {
  const [engine, setEngine] = useState<CliEngineId | null>(null)
  useEffect(() => {
    if (!active) return
    let alive = true
    const read = (statuses: EngineStatus[]): CliEngineId | null =>
      CLI_ENGINES.find((id) => statuses.some((s) => s.id === id && s.installed && !s.outdated && s.auth.state === 'signed-in')) ?? null
    void (window.api.engines?.status().catch(() => [] as EngineStatus[]) ?? Promise.resolve([] as EngineStatus[])).then((statuses) => {
      if (alive) setEngine(read(statuses))
    })
    const off = window.api.engines?.onChanged(() => void window.api.engines.status().then((statuses) => alive && setEngine(read(statuses))))
    return () => {
      alive = false
      off?.()
    }
  }, [active])
  return active ? engine : null
}
