import { ipcRenderer } from 'electron'
import type { BrowserAsk, BrowserBridgeStatus, PairingCode } from '@shared/browserBridge'

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
  /** Asks the connected extension to update itself to the version Eaon ships. */
  updateExtension: (): Promise<BrowserBridgeStatus> => ipcRenderer.invoke('browser-bridge:update-extension'),
  /** Chromium browsers installed here, for "Open extensions page". */
  browsers: (): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke('browser-bridge:browsers'),
  openExtensionsPage: (id: string): Promise<boolean> => ipcRenderer.invoke('browser-bridge:open-extensions-page', id),
  /** What the user sent from the browser's right-click menu, if anything is waiting. */
  takeAsk: (): Promise<BrowserAsk | null> => ipcRenderer.invoke('browser-bridge:take-ask'),
  /** Something was sent from the right-click menu; call takeAsk() for it. */
  onAsk: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on('browser-bridge:ask', listener)
    return () => ipcRenderer.removeListener('browser-bridge:ask', listener)
  },
  onStatus: (handler: (status: BrowserBridgeStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: BrowserBridgeStatus): void => handler(status)
    ipcRenderer.on('browser-bridge:status', listener)
    return () => ipcRenderer.removeListener('browser-bridge:status', listener)
  }
}
