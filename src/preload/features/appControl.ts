import { ipcRenderer } from 'electron'
import type { AppControlCommandInfo, AppControlEnvelope, AppControlStatus, AppControlTraceEntry } from '@shared/appControl'

/**
 * Renderer bridge for app control. Exposed as `window.api.appControl`.
 * Keep every channel this feature uses in this one file.
 */
export const appControlApi = {
  /** Switches, engine, permission; cheap enough to poll while Settings is open. */
  status: (): Promise<AppControlStatus> => ipcRenderer.invoke('app-control:status'),
  commands: (): Promise<AppControlCommandInfo[]> => ipcRenderer.invoke('app-control:commands'),
  /** Runs a command that only reads (the try-it panel); anything that acts is refused. */
  try: (command: string, args: Record<string, unknown>): Promise<AppControlEnvelope> => ipcRenderer.invoke('app-control:try', command, args),
  /** Recent activity, newest first. */
  activity: (limit?: number): Promise<AppControlTraceEntry[]> => ipcRenderer.invoke('app-control:activity', limit),
  clearActivity: (): Promise<void> => ipcRenderer.invoke('app-control:clear-activity'),
  /** macOS: asks for Accessibility (adding Eaon to the list) and opens that pane. */
  openPermission: (): Promise<void> => ipcRenderer.invoke('app-control:open-permission'),
  onActivity: (handler: (entry: AppControlTraceEntry) => void): (() => void) => {
    const listener = (_e: unknown, entry: AppControlTraceEntry): void => handler(entry)
    ipcRenderer.on('app-control:activity-added', listener)
    return () => ipcRenderer.removeListener('app-control:activity-added', listener)
  }
}
