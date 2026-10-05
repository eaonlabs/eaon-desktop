import { ipcRenderer } from 'electron'
import type { EngineId, EngineModels, EngineStatus } from '@shared/engines'

/** Renderer bridge for agent engines (Eaon's own loop, Codex…). Exposed as `window.api.engines`. */
export const enginesApi = {
  /** What Eaon last learned about each engine; empty until the first check after launch. */
  status: (): Promise<EngineStatus[]> => ipcRenderer.invoke('engines:status'),
  /** Checks again: one engine or all, `force` skipping any cache. Resolves with every status. */
  refresh: (id?: EngineId, force = false): Promise<EngineStatus[]> => ipcRenderer.invoke('engines:refresh', id, force),
  /** The engine's models with their source and freshness, or null before the first check. */
  models: (id: EngineId): Promise<EngineModels | null> => ipcRenderer.invoke('engines:models', id),
  /** Starts the engine's own sign-in; resolves with every status once it finished. */
  login: (id: EngineId): Promise<EngineStatus[]> => ipcRenderer.invoke('engines:login', id),
  onChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('engines:changed', listener)
    return () => {
      ipcRenderer.removeListener('engines:changed', listener)
    }
  }
}
