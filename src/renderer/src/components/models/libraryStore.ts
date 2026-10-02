import { create } from 'zustand'
import { useApp } from '../../state/store'
import {
  libraryProgressKey,
  type LibraryModel,
  type LibraryState,
  type LibraryVariant
} from '@shared/modelLibrary'
import type { DownloadedModel } from '@shared/types'

/**
 * State for the model library, kept outside the app store so the feature owns
 * it end to end. Actions live here rather than in components because a pull
 * outlives the page: the user can start one, open a chat, and the finish still
 * has to clear the Downloads panel row and refresh the model picker.
 */

export const progressId = (model: LibraryModel, variant: LibraryVariant): string => {
  const key = libraryProgressKey(model, variant)
  return `${key.repoId}::${key.filename}`
}

interface LibraryStore {
  catalog: LibraryModel[]
  state: LibraryState | null
  /** Files downloaded through "Browse Hugging Face", from downloaded-models.json. */
  downloaded: DownloadedModel[]
  loadError: string | null
  /** Last failure per download (progress id) or per installed model id. */
  errors: Record<string, string>

  load: () => Promise<void>
  refresh: () => Promise<void>
  get: (model: LibraryModel, variant: LibraryVariant) => Promise<void>
  cancel: (model: LibraryModel, variant: LibraryVariant) => void
  /** Deletes a downloaded model by its picker id. */
  remove: (id: string) => Promise<void>
  /** "Browse Hugging Face": download one GGUF file for Eaon's runtime. Errors land under `repoId::filename`. */
  downloadFile: (repoId: string, filename: string) => Promise<void>
  removeDownloaded: (repoId: string, filename: string) => Promise<void>
  /** Frees the memory the loaded model holds. */
  unload: () => Promise<void>
}

const message = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  // ipcRenderer.invoke wraps main-process errors in this prefix.
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/**
 * Makes a model the user just downloaded or deleted show up in (or leave) the
 * composer's picker: "On this computer" lists what is on disk, so re-reading
 * the providers is enough.
 */
async function refreshLocalProvider(): Promise<void> {
  await useApp.getState().refreshProviders()
}

function clearDownloadRow(id: string): void {
  useApp.setState((s) => {
    if (!(id in s.modelDownloads)) return {}
    const next = { ...s.modelDownloads }
    delete next[id]
    return { modelDownloads: next }
  })
}

export const useLibrary = create<LibraryStore>((set, get) => ({
  catalog: [],
  state: null,
  downloaded: [],
  loadError: null,
  errors: {},

  async load() {
    try {
      const [catalog] = await Promise.all([window.api.modelLibrary.catalog(), get().refresh()])
      set({ catalog, loadError: null })
    } catch (error) {
      set({ loadError: message(error) })
    }
  },

  async refresh() {
    const [state, downloaded] = await Promise.all([
      window.api.modelLibrary.state(),
      window.api.models.downloaded().catch(() => [] as DownloadedModel[])
    ])
    set({ state, downloaded })
  },

  async get(model, variant) {
    const id = progressId(model, variant)
    set((s) => {
      const errors = { ...s.errors }
      delete errors[id]
      return { errors }
    })
    try {
      await window.api.modelLibrary.get(model.id, variant.id)
      await get().refresh()
      await refreshLocalProvider()
    } catch (error) {
      const text = message(error)
      if (text !== 'Download cancelled') set((s) => ({ errors: { ...s.errors, [id]: text } }))
    } finally {
      // The pull's last progress event and this promise settling can race;
      // clearing here guarantees the row leaves the Downloads panel when the
      // button stops waiting, success or failure.
      clearDownloadRow(id)
    }
  },

  cancel(model, variant) {
    void window.api.modelLibrary.cancel(model.id, variant.id)
  },

  async remove(id) {
    set((s) => {
      const errors = { ...s.errors }
      delete errors[id]
      return { errors }
    })
    try {
      await window.api.modelLibrary.remove(id)
      await get().refresh()
      await refreshLocalProvider()
    } catch (error) {
      set((s) => ({ errors: { ...s.errors, [id]: message(error) } }))
    }
  },

  async downloadFile(repoId, filename) {
    const id = `${repoId}::${filename}`
    set((s) => {
      const errors = { ...s.errors }
      delete errors[id]
      return { errors }
    })
    try {
      // The app store's action owns the Downloads panel row for these.
      await useApp.getState().downloadModel(repoId, filename)
      await get().refresh()
      await refreshLocalProvider()
    } catch (error) {
      set((s) => ({ errors: { ...s.errors, [id]: message(error) } }))
    }
  },

  async removeDownloaded(repoId, filename) {
    const id = `${repoId}::${filename}`
    try {
      await window.api.models.delete(repoId, filename)
      await get().refresh()
      await refreshLocalProvider()
    } catch (error) {
      set((s) => ({ errors: { ...s.errors, [id]: message(error) } }))
    }
  },

  async unload() {
    await window.api.modelLibrary.unload()
    await get().refresh()
  }
}))
