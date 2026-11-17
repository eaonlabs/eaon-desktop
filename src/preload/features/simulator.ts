import { ipcRenderer } from 'electron'
import type { DeviceLook, HardwareButton, PaneFrame, PaneSession, PaneState, SimOrientation, TouchFrame } from '@shared/simulatorPane'

/**
 * Renderer bridge for Eaon's Device pane (main/features/simulatorPane.ts).
 * Exposed as `window.api.simulator`. Calls that fail reject with a sentence
 * for the user. Keep every channel this feature uses in this file.
 */

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const simulatorApi = {
  /** Whether simulators can run here, and which there are. */
  state: (): Promise<PaneState> => ipcRenderer.invoke('simulator:state'),
  /** The device's screen and frame as the Mac's Xcode draws them; null when it can't say. */
  look: (udid: string): Promise<DeviceLook | null> => ipcRenderer.invoke('simulator:look', udid),
  /** Starts showing a booted device in this window (onSession, onFrame), or stops. */
  watch: (udid: string): Promise<void> => ipcRenderer.invoke('simulator:watch', udid),
  unwatch: (udid: string): Promise<void> => ipcRenderer.invoke('simulator:unwatch', udid),
  /** Starts the live screen afresh, after it fell back to screenshots. */
  reconnect: (udid: string): Promise<void> => ipcRenderer.invoke('simulator:reconnect', udid),
  boot: (udid: string): Promise<void> => ipcRenderer.invoke('simulator:boot', udid),
  shutdown: (udid: string): Promise<void> => ipcRenderer.invoke('simulator:shutdown', udid),
  /** A touch as it happens, in fractions of the screen's native portrait frame. */
  touch: (udid: string, touch: TouchFrame): void => ipcRenderer.send('simulator:touch', udid, touch),
  /** A key press, by its KeyboardEvent key. */
  key: (udid: string, key: string, shift: boolean): void => ipcRenderer.send('simulator:key', udid, key, shift),
  button: (udid: string, name: HardwareButton): Promise<void> => ipcRenderer.invoke('simulator:button', udid, name),
  rotate: (udid: string, orientation: SimOrientation): Promise<void> => ipcRenderer.invoke('simulator:rotate', udid, orientation),
  /** Sets light or dark, or with none just reads it; null when the device can't say. */
  appearance: (udid: string, mode?: 'light' | 'dark'): Promise<'light' | 'dark' | null> => ipcRenderer.invoke('simulator:appearance', udid, mode),
  openUrl: (udid: string, url: string): Promise<void> => ipcRenderer.invoke('simulator:open-url', udid, url),
  /** Types the Mac's clipboard text into the device, or ("pasteboard") puts it on the device's clipboard. */
  paste: (udid: string, how: 'type' | 'pasteboard'): Promise<void> => ipcRenderer.invoke('simulator:paste', udid, how),
  /** Saves a screenshot to the Desktop or a file for the chat (its path), or puts it on the clipboard (null). */
  screenshot: (udid: string, to: 'desktop' | 'clipboard' | 'chat'): Promise<string | null> => ipcRenderer.invoke('simulator:screenshot', udid, to),
  /** Starts recording the screen, or stops and returns the movie's path on the Desktop. */
  record: (udid: string, on: boolean): Promise<string | null> => ipcRenderer.invoke('simulator:record', udid, on),
  showFile: (file: string): Promise<void> => ipcRenderer.invoke('simulator:show-file', file),
  getXcode: (): Promise<void> => ipcRenderer.invoke('simulator:get-xcode'),
  onFrame: (handler: (frame: PaneFrame) => void): (() => void) => subscribe('simulator:frame', handler),
  /** Whether a device takes input, why not, and how it is turned. */
  onSession: (handler: (session: PaneSession) => void): (() => void) => subscribe('simulator:session', handler),
  /** The agent's ios_simulator tool showing a device: the pane opens on it. */
  onReveal: (handler: (udid: string) => void): (() => void) => subscribe('simulator:reveal', handler)
}
