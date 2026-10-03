import { ipcRenderer } from 'electron'
import type {
  EaonCodeStatus,
  EaonCommand,
  EaonEvent,
  EaonProcessInfo,
  EaonResult,
  EaonSessionInfo,
  EaonSnapshot,
  EaonStartOptions,
  EaonUiResponse
} from '@shared/eaonCode'

function listen<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * Renderer bridge for the eaonCode feature. Exposed as `window.api.eaonCode`.
 * Keep every channel this feature uses in this one file.
 */
export const eaonCodeApi = {
  /** Where Eaon Code is and whether it runs; `refresh` re-probes instead of using the cache. */
  status: (refresh = false): Promise<EaonCodeStatus> => ipcRenderer.invoke('eaon-code:status', refresh),
  /** Runs Eaon Code's installer, which installs or updates it; output streams to `onInstallLog`. */
  install: (): Promise<EaonResult<EaonCodeStatus>> => ipcRenderer.invoke('eaon-code:install'),
  onInstallLog: (handler: (line: string) => void): (() => void) => listen('eaon-code:install-log', handler),

  start: (cwd: string, options?: EaonStartOptions): Promise<EaonResult<EaonSnapshot>> =>
    ipcRenderer.invoke('eaon-code:start', cwd, options),
  stop: (): Promise<EaonResult<void>> => ipcRenderer.invoke('eaon-code:stop'),
  process: (): Promise<EaonProcessInfo> => ipcRenderer.invoke('eaon-code:process'),
  /** Any command from the allowlist in `EaonCommand`; resolves with the response's `data`. */
  command: <T = unknown>(command: EaonCommand): Promise<EaonResult<T>> => ipcRenderer.invoke('eaon-code:command', command),
  respondUi: (id: string, response: EaonUiResponse): Promise<void> => ipcRenderer.invoke('eaon-code:ui-respond', id, response),
  onEvents: (handler: (events: EaonEvent[]) => void): (() => void) => listen('eaon-code:events', handler),
  onProcess: (handler: (info: EaonProcessInfo) => void): (() => void) => listen('eaon-code:process', handler),

  sessions: (cwd: string): Promise<EaonResult<EaonSessionInfo[]>> => ipcRenderer.invoke('eaon-code:sessions', cwd),
  recents: (): Promise<string[]> => ipcRenderer.invoke('eaon-code:recents'),
  forgetRecent: (cwd: string): Promise<string[]> => ipcRenderer.invoke('eaon-code:forget-recent', cwd),
  /** Makes `cwd` the ADE's folder (recent + reopened at launch); returns the updated recents. */
  useFolder: (cwd: string): Promise<string[]> => ipcRenderer.invoke('eaon-code:use-folder', cwd),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('eaon-code:pick-folder'),
  pickBinary: (): Promise<string | null> => ipcRenderer.invoke('eaon-code:pick-binary'),
  /** Opens a terminal running eaon-code in `cwd`; `continueSession` hands it the current session. */
  openTerminal: (cwd: string, continueSession = false): Promise<EaonResult<{ continued: boolean }>> =>
    ipcRenderer.invoke('eaon-code:open-terminal', cwd, continueSession),
  /** Environment variable names a session would receive from Eaon's saved keys (never the values). */
  sharedKeys: (): Promise<string[]> => ipcRenderer.invoke('eaon-code:shared-keys')
}
