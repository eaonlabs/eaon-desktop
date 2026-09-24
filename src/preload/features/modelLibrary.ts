import { ipcRenderer } from 'electron'
import type { LibraryModel, LibraryState, OllamaStatus } from '@shared/modelLibrary'

/**
 * Renderer bridge for the modelLibrary feature. Exposed as `window.api.modelLibrary`.
 * Keep every channel this feature uses in this one file. Pull progress arrives
 * through `window.api.models.onDownloadProgress`, shared with Hugging Face
 * downloads, and is already mirrored into the store's `modelDownloads`.
 */
export const modelLibraryApi = {
  catalog: (): Promise<LibraryModel[]> => ipcRenderer.invoke('modelLibrary:catalog'),
  state: (): Promise<LibraryState> => ipcRenderer.invoke('modelLibrary:state'),
  /** Pulls a catalog variant through Ollama; resolves with the name it is installed under. */
  get: (modelId: string, variantId: string): Promise<{ name: string }> =>
    ipcRenderer.invoke('modelLibrary:get', modelId, variantId),
  cancel: (modelId: string, variantId: string): Promise<void> => ipcRenderer.invoke('modelLibrary:cancel', modelId, variantId),
  /** Deletes an Ollama model by its exact installed name. */
  remove: (name: string): Promise<void> => ipcRenderer.invoke('modelLibrary:remove', name),
  startOllama: (): Promise<OllamaStatus> => ipcRenderer.invoke('modelLibrary:start-ollama')
}
