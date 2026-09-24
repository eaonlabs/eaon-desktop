import { ipcRenderer } from 'electron'

/**
 * Renderer bridge for the browserBridge feature. Exposed as `window.api.browserBridge`.
 * Keep every channel this feature uses in this one file.
 */
export const browserBridgeApi = {}

// Referenced so the import is never flagged unused while the bridge is empty.
void ipcRenderer
