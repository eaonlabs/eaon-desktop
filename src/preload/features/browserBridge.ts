import { ipcRenderer } from 'electron'
import type { BrowserBridgeStatus, PairingCode } from '@shared/browserBridge'

/**
 * Renderer bridge for the browserBridge feature. Exposed as `window.api.browserBridge`.
 * Keep every channel this feature uses in this one file.
 */
export const browserBridgeApi = {
  status: (): Promise<BrowserBridgeStatus> => ipcRenderer.invoke('browser-bridge:status'),
  /** Re-reads `settings.browserExtension` and starts, stops or moves the server to match. */
  apply: (): Promise<BrowserBridgeStatus> => ipcRenderer.invoke('browser-bridge:apply'),
  /** The live pairing code (a new one when `fresh`), or null while the server is off. */
  pairingCode: (fresh = false): Promise<PairingCode | null> => ipcRenderer.invoke('browser-bridge:pairing-code', fresh),
  unpair: (): Promise<BrowserBridgeStatus> => ipcRenderer.invoke('browser-bridge:unpair'),
  /** The folder to choose in Chrome's "Load unpacked". */
  extensionPath: (): Promise<string> => ipcRenderer.invoke('browser-bridge:extension-path'),
  revealExtension: (): Promise<string> => ipcRenderer.invoke('browser-bridge:reveal-extension'),
  onStatus: (handler: (status: BrowserBridgeStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: BrowserBridgeStatus): void => handler(status)
    ipcRenderer.on('browser-bridge:status', listener)
    return () => ipcRenderer.removeListener('browser-bridge:status', listener)
  }
}
