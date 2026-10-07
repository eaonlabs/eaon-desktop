import { ipcRenderer } from 'electron'
import type { RemoteInfo, RemoteStatus } from '@shared/remote'

/**
 * Renderer bridge for remote devices (Settings → Remote devices). Exposed as
 * `window.api.remote`. Keep every channel this feature uses in this file.
 */
export const remoteApi = {
  /** Status, addresses, key and pairing link. */
  info: (): Promise<RemoteInfo> => ipcRenderer.invoke('remote:info'),
  /** Turns the server on or off; the first time makes the key. */
  setEnabled: (enabled: boolean): Promise<RemoteInfo> => ipcRenderer.invoke('remote:set-enabled', enabled),
  /** Moves the server (1024–65535). Paired phones need the new link. Rejects with a user-facing message. */
  setPort: (port: number): Promise<RemoteInfo> => ipcRenderer.invoke('remote:set-port', port),
  /** A new key. Every connected phone is dropped and has to pair again. */
  resetToken: (): Promise<RemoteInfo> => ipcRenderer.invoke('remote:reset-token'),
  /** The server started, stopped or failed to. */
  onStatus: (handler: (status: RemoteStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: RemoteStatus): void => handler(status)
    ipcRenderer.on('remote:status', listener)
    return () => ipcRenderer.removeListener('remote:status', listener)
  }
}
