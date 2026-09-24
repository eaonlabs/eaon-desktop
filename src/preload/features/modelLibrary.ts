import { ipcRenderer } from 'electron'

/**
 * Renderer bridge for the modelLibrary feature. Exposed as `window.api.modelLibrary`.
 * Keep every channel this feature uses in this one file.
 */
export const modelLibraryApi = {}

// Referenced so the import is never flagged unused while the bridge is empty.
void ipcRenderer
