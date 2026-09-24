import { ipcRenderer } from 'electron'

/**
 * Renderer bridge for the computerUse feature. Exposed as `window.api.computerUse`.
 * Keep every channel this feature uses in this one file.
 */
export const computerUseApi = {}

// Referenced so the import is never flagged unused while the bridge is empty.
void ipcRenderer
