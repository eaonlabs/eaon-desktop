import {
  LIBRARY,
  cancelAllLibraryPulls,
  cancelLibraryPull,
  libraryState,
  pullLibraryVariant,
  removeInstalledModel,
  startOllama
} from '../modelLibrary'
import type { Feature } from './types'

/**
 * The curated local-model library behind the Models page: catalog, Ollama
 * status and installed models, one-click pulls and deletes. Pull progress is
 * sent on the existing `models:download-progress` channel so the header's
 * Downloads panel picks it up with no extra wiring. See
 * .eaonbrain/local-model-hub.md.
 */
export const modelLibraryFeature: Feature = {
  id: 'modelLibrary',
  register: ({ ipcMain, send }) => {
    ipcMain.handle('modelLibrary:catalog', () => LIBRARY)
    ipcMain.handle('modelLibrary:state', () => libraryState())
    ipcMain.handle('modelLibrary:get', (_e, modelId: string, variantId: string) =>
      pullLibraryVariant(modelId, variantId, (channel, progress) => send(channel, progress))
    )
    ipcMain.handle('modelLibrary:cancel', (_e, modelId: string, variantId: string) => cancelLibraryPull(modelId, variantId))
    ipcMain.handle('modelLibrary:remove', (_e, name: string) => removeInstalledModel(name))
    ipcMain.handle('modelLibrary:start-ollama', () => startOllama())
  },
  // A pull Ollama is still running keeps its partial layers and resumes next
  // time, so aborting on quit loses nothing.
  dispose: () => cancelAllLibraryPulls()
}
