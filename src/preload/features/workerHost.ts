import { ipcRenderer } from 'electron'
import type { HostInstallProgress, HostPairing, SshInstallRequest, WorkerHostState } from '@shared/workerHost'

/**
 * Renderer bridge for the worker computer (Settings → Worker computer, and
 * the Workers tab's banner). Exposed as `window.api.workerHost`. Keep every
 * channel this feature uses in this file.
 */
export const workerHostApi = {
  state: (): Promise<WorkerHostState> => ipcRenderer.invoke('worker-host:state'),
  /** Installs the host app over SSH and links to it. Rejects with a user-facing message. */
  installSsh: (request: SshInstallRequest): Promise<WorkerHostState> => ipcRenderer.invoke('worker-host:install-ssh', request),
  /** Installs the host app again over SSH with the same link (a computer linked over SSH). */
  reinstall: (password?: string): Promise<WorkerHostState> => ipcRenderer.invoke('worker-host:reinstall', password),
  /** Serves a one-line install for the other computer; it links when that finishes. `reinstall`: for the linked one, keeping its link and workers. */
  pairStart: (options?: { reinstall?: boolean }): Promise<HostPairing> => ipcRenderer.invoke('worker-host:pair-start', options),
  pairCancel: (): Promise<void> => ipcRenderer.invoke('worker-host:pair-cancel'),
  /** Moves the workers to the linked computer (true) or back here (false). `fromBackup` restores the copy kept here, for a computer that's gone. */
  setEnabled: (enabled: boolean, options?: { fromBackup?: boolean }): Promise<WorkerHostState> => ipcRenderer.invoke('worker-host:set-enabled', enabled, options),
  reconnect: (): Promise<WorkerHostState> => ipcRenderer.invoke('worker-host:reconnect'),
  /** Sends keys, settings, MCP servers and skills again now. */
  sync: (): Promise<WorkerHostState> => ipcRenderer.invoke('worker-host:sync'),
  setAddress: (address: string, port?: number): Promise<WorkerHostState> => ipcRenderer.invoke('worker-host:set-address', address, port),
  /** Forgets the computer (bringing workers back first); `removeApp` also uninstalls the host app there. */
  unlink: (options?: { removeApp?: boolean; fromBackup?: boolean }): Promise<WorkerHostState> => ipcRenderer.invoke('worker-host:unlink', options),
  onState: (handler: (state: WorkerHostState) => void): (() => void) => {
    const listener = (_e: unknown, state: WorkerHostState): void => handler(state)
    ipcRenderer.on('worker-host:state', listener)
    return () => ipcRenderer.removeListener('worker-host:state', listener)
  },
  /** Install and move progress, a line at a time. */
  onProgress: (handler: (progress: HostInstallProgress) => void): (() => void) => {
    const listener = (_e: unknown, progress: HostInstallProgress): void => handler(progress)
    ipcRenderer.on('worker-host:progress', listener)
    return () => ipcRenderer.removeListener('worker-host:progress', listener)
  }
}
