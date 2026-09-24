import { ipcRenderer } from 'electron'

/**
 * Renderer bridge for the pets feature. Exposed as `window.api.pets`.
 * Keep every channel this feature uses in this one file.
 */
export const petsApi = {}

// Referenced so the import is never flagged unused while the bridge is empty.
void ipcRenderer
