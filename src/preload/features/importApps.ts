import { ipcRenderer } from 'electron'
import type { ImportableApp, ImportResult } from '@shared/importApps'
import type { McpServer } from '@shared/types'

/** Renderer bridge for Import from another app. Exposed as `window.api.importApps`. */
export const importAppsApi = {
  /** The MCP servers other apps on this computer have, by name, command and variable names; never values. */
  scan: (): Promise<ImportableApp[]> => ipcRenderer.invoke('import-apps:scan'),
  /** Adds the servers with these keys (from `scan`), and returns Eaon's list as it is now. */
  apply: (keys: string[]): Promise<ImportResult & { servers: McpServer[] }> => ipcRenderer.invoke('import-apps:apply', keys)
}
