import { ipcRenderer } from 'electron'
import type { AgentAppImport, AgentAppImportResult, AgentAppScan, ForeignAgent } from '@shared/agentApps'

/** Renderer bridge for importing sessions and scripts from other agent apps. Exposed as `window.api.agentApps`. */
export const agentAppsApi = {
  /** The sessions and project scripts Conductor, Orca, Paradev (Superset), Claude Squad, T3 Code, Synara and Crystal have on this computer. */
  scan: (): Promise<AgentAppScan[]> => ipcRenderer.invoke('agent-apps:scan'),
  /** Brings in the picked ones (keys from `scan`); returns the conversations to reopen, each in a pane of its session. */
  import: (pick: AgentAppImport): Promise<AgentAppImportResult & { panes: { cwd: string; agent: ForeignAgent; resume: string }[] }> =>
    ipcRenderer.invoke('agent-apps:import', pick)
}
