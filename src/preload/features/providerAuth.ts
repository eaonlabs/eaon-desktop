import { ipcRenderer } from 'electron'

/**
 * Renderer bridge for the providerAuth feature. Exposed as `window.api.providerAuth`.
 * Keep every channel this feature uses in this one file.
 */
export const providerAuthApi = {}

// Referenced so the import is never flagged unused while the bridge is empty.
void ipcRenderer
