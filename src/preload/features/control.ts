import { ipcRenderer } from 'electron'
import type { ControlAction } from '@shared/control'

/**
 * Renderer bridge for the control feature. Exposed as `window.api.control`.
 * Main sends the actions Eaon CLI asked for that only the window can do.
 */
export const controlApi = {
  onAction: (handler: (action: ControlAction) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: ControlAction): void => handler(action)
    ipcRenderer.on('control:action', listener)
    return () => ipcRenderer.removeListener('control:action', listener)
  }
}
