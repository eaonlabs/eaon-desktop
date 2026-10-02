import { ipcRenderer } from 'electron'
import type { LibraryModel, LibraryState } from '@shared/modelLibrary'

/**
 * Renderer bridge for the modelLibrary feature. Exposed as `window.api.modelLibrary`.
 */
export const modelLibraryApi = {
  catalog: (): Promise<LibraryModel[]> => ipcRenderer.invoke('modelLibrary:catalog'),
  state: (): Promise<LibraryState> => ipcRenderer.invoke('modelLibrary:state'),
  /** Downloads a library variant; resolves with its id in the model picker. */
  get: (modelId: string, variantId: string): Promise<{ id: string }> => ipcRenderer.invoke('modelLibrary:get', modelId, variantId),
  cancel: (modelId: string, variantId: string): Promise<void> => ipcRenderer.invoke('modelLibrary:cancel', modelId, variantId),
  /** Deletes a downloaded model by its picker id. */
  remove: (id: string): Promise<void> => ipcRenderer.invoke('modelLibrary:remove', id),
  /** Frees the memory the loaded model holds; it loads again on next use. */
  unload: (): Promise<void> => ipcRenderer.invoke('modelLibrary:unload')
}
