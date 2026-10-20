import { ipcRenderer } from 'electron'
import type { AgentToolsState } from '@shared/agentProviders'

/** Settings → Agent providers: installed coding CLIs, versions and updates. Exposed as `window.api.agentProviders`. */
export const agentProvidersApi = {
  state: (): Promise<AgentToolsState> => ipcRenderer.invoke('agent-providers:state'),
  /** Looks for every CLI and its newest version again now. */
  refresh: (): Promise<AgentToolsState> => ipcRenderer.invoke('agent-providers:refresh'),
  /** Updates an npm-installed CLI with npm. */
  update: (id: string): Promise<AgentToolsState> => ipcRenderer.invoke('agent-providers:update', id),
  onChanged: (listener: (state: AgentToolsState) => void): (() => void) => {
    const handler = (_e: unknown, state: AgentToolsState): void => listener(state)
    ipcRenderer.on('agent-providers:changed', handler)
    return () => ipcRenderer.removeListener('agent-providers:changed', handler)
  }
}
