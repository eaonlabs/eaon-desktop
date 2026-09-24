import { ipcRenderer } from 'electron'

/**
 * Renderer bridge for the plugins feature. Exposed as `window.api.plugins`.
 * Keep every channel this feature uses in this one file.
 */
export const pluginsApi = {}

// Referenced so the import is never flagged unused while the bridge is empty.
void ipcRenderer
