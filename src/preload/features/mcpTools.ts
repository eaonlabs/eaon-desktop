import { ipcRenderer } from 'electron'
import type { McpLogLine } from '@shared/mcpTools'
import type { ProjectMcpOffer } from '@shared/mcpProject'
import type { McpTool } from '@shared/types'

/** Renderer bridge for MCP tool rules, server logs and project server files (main/features/mcpTools). Exposed as `window.api.mcpTools`. */
export const mcpToolsApi = {
  /** Every tool the connected servers have, including ones turned off in settings. */
  all: (): Promise<McpTool[]> => ipcRenderer.invoke('mcp-tools:all'),
  logs: (serverId: string): Promise<McpLogLine[]> => ipcRenderer.invoke('mcp-tools:logs', serverId),
  clearLogs: (serverId: string): Promise<void> => ipcRenderer.invoke('mcp-tools:clear-logs', serverId),
  /** Chat projects whose folder has a `.mcp.json` or `.eaon/mcp.json`; nothing in them has been run. */
  scanProjects: (): Promise<ProjectMcpOffer[]> => ipcRenderer.invoke('mcp-project:scan'),
  /** Picks a folder and reads its server file; null when the picker was closed. */
  pickFolder: (): Promise<{ folder: string; offer: ProjectMcpOffer | null } | null> => ipcRenderer.invoke('mcp-project:pick'),
  /** Approves exactly the file text with this fingerprint, and starts its servers. */
  approveProject: (folder: string, fingerprint: string): Promise<ProjectMcpOffer | null> => ipcRenderer.invoke('mcp-project:approve', folder, fingerprint),
  declineProject: (folder: string, fingerprint: string): Promise<ProjectMcpOffer | null> => ipcRenderer.invoke('mcp-project:decline', folder, fingerprint),
  /** Removes the servers saved from a folder and forgets the decision. */
  forgetProject: (folder: string): Promise<void> => ipcRenderer.invoke('mcp-project:forget', folder),
  /** A run started in a folder whose project file hasn't been decided on. */
  onOffer: (handler: (offer: ProjectMcpOffer) => void): (() => void) => {
    const listener = (_e: unknown, payload: ProjectMcpOffer): void => handler(payload)
    ipcRenderer.on('mcp-project:offer', listener)
    return () => ipcRenderer.removeListener('mcp-project:offer', listener)
  }
}
