import { llamaRuntime } from '../llama/runtime'
import {
  LIBRARY,
  cancelAllLibraryPulls,
  cancelLibraryPull,
  libraryState,
  pullLibraryVariant,
  removeInstalledModel
} from '../modelLibrary'
import type { Feature } from './types'

/**
 * The curated local-model library behind the Models page: catalog, the state
 * of Eaon's own llama.cpp runtime, downloaded models, one-click downloads and
 * deletes. Download progress goes out on `models:download-progress` so the
 * header's Downloads panel picks it up. See .eaonbrain on the local runtime.
 */
export const modelLibraryFeature: Feature = {
  id: 'modelLibrary',
  register: ({ ipcMain, send }) => {
    // A model server left running by a crash would hold its memory until quit by hand.
    void llamaRuntime.reapOrphans()
    ipcMain.handle('modelLibrary:catalog', () => LIBRARY)
    ipcMain.handle('modelLibrary:state', () => libraryState())
    ipcMain.handle('modelLibrary:get', (_e, modelId: string, variantId: string) =>
      pullLibraryVariant(modelId, variantId, (channel, progress) => send(channel, progress))
    )
    ipcMain.handle('modelLibrary:cancel', (_e, modelId: string, variantId: string) => cancelLibraryPull(modelId, variantId))
    ipcMain.handle('modelLibrary:remove', (_e, id: string) => removeInstalledModel(id))
    // Frees the memory a loaded model holds, without deleting it.
    ipcMain.handle('modelLibrary:unload', () => llamaRuntime.unload())
  },
  dispose: () => cancelAllLibraryPulls(),
  // Loaded models are llama-server processes; they must not outlive Eaon.
  shutdown: () => llamaRuntime.shutdown()
}
