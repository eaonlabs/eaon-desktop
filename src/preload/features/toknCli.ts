import { ipcRenderer } from 'electron'
import type { ToknCliStatus } from '@shared/toknCli'

/** Renderer bridge for the tokn command that ships with Eaon. Exposed as `window.api.toknCli`. */
export const toknCliApi = {
  status: (): Promise<ToknCliStatus> => ipcRenderer.invoke('tokn-cli:status'),
  /** Links it to the Tokn account Eaon is signed in with (no second sign-in). */
  link: (): Promise<ToknCliStatus> => ipcRenderer.invoke('tokn-cli:link'),
  /** `tokn sync` now. */
  sync: (): Promise<ToknCliStatus> => ipcRenderer.invoke('tokn-cli:sync'),
  /**
   * After `settings.toknCli` changed: install or remove the command, link,
   * start or stop the hourly sync and the background job. `resume` when the
   * background switch was just turned on.
   */
  apply: (options?: { resume?: boolean }): Promise<ToknCliStatus> => ipcRenderer.invoke('tokn-cli:apply', options),
  /** Opens System Settings → General → Login Items (macOS), where Eaon's background items are allowed. */
  openLoginItems: (): Promise<void> => ipcRenderer.invoke('tokn-cli:login-items'),
  onChanged: (callback: (status: ToknCliStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: ToknCliStatus): void => callback(status)
    ipcRenderer.on('tokn-cli:changed', listener)
    return () => {
      ipcRenderer.removeListener('tokn-cli:changed', listener)
    }
  }
}
