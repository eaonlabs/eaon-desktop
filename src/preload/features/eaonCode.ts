import { ipcRenderer } from 'electron'

/**
 * Renderer bridge for the eaonCode feature. Exposed as `window.api.eaonCode`.
 * Keep every channel this feature uses in this one file.
 */
export const eaonCodeApi = {}

// Referenced so the import is never flagged unused while the bridge is empty.
void ipcRenderer
