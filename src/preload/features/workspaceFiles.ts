import { ipcRenderer } from 'electron'
import type { WorkspaceEntry, WorkspaceFile } from '@shared/workspaceFiles'

/** Renderer bridge for Chat's code panel. Exposed as `window.api.workspaceFiles`. */
export const workspaceFilesApi = {
  /** The folder Chat's agent works in, created if it is not there yet. */
  root: (): Promise<string> => ipcRenderer.invoke('workspace-files:root'),
  /** The folders in the home folder, for the composer's project picker. */
  places: (): Promise<WorkspaceEntry[]> => ipcRenderer.invoke('workspace-files:places'),
  /** A folder's entries, folders first. */
  list: (path: string): Promise<WorkspaceEntry[]> => ipcRenderer.invoke('workspace-files:list', path),
  read: (path: string): Promise<WorkspaceFile> => ipcRenderer.invoke('workspace-files:read', path),
  /** Saves over an existing file; resolves to its new modified time. */
  write: (path: string, text: string): Promise<number> => ipcRenderer.invoke('workspace-files:write', path, text)
}
