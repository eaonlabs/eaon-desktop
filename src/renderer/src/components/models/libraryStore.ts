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
  /** Last failure per pull (progress id) or per installed model name. */
  errors: Record<string, string>
  startingOllama: boolean

  load: () => Promise<void>
  refresh: () => Promise<void>
  get: (model: LibraryModel, variant: LibraryVariant) => Promise<void>
  cancel: (model: LibraryModel, variant: LibraryVariant) => void
  remove: (name: string) => Promise<void>
  /** "Browse Hugging Face": download one GGUF file and register it with Ollama. Errors land under `repoId::filename`. */
  downloadFile: (repoId: string, filename: string) => Promise<void>
  removeDownloaded: (repoId: string, filename: string) => Promise<void>
  startOllama: () => Promise<void>
}

const message = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  // ipcRenderer.invoke wraps main-process errors in this prefix.
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Makes a model the user just pulled or deleted show up in (or leave) the composer's picker. */
async function refreshOllamaProvider(): Promise<void> {
  try {
    await window.api.providers.refreshModels('ollama')
  } catch {
    /* Ollama provider disabled or unreachable — the picker keeps its last list. */
  }
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
  startingOllama: false,

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
      // One click should be enough even when Ollama is installed but not running.
      if (get().state?.ollama.state === 'stopped') await get().startOllama()
      await window.api.modelLibrary.get(model.id, variant.id)
      await get().refresh()
      await refreshOllamaProvider()
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

  async remove(name) {
    set((s) => {
      const errors = { ...s.errors }
      delete errors[name]
      return { errors }
    })
    try {
      await window.api.modelLibrary.remove(name)
      await get().refresh()
      await refreshOllamaProvider()
    } catch (error) {
      set((s) => ({ errors: { ...s.errors, [name]: message(error) } }))
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
      const model = await useApp.getState().downloadModel(repoId, filename)
      await get().refresh()
      if (model.ollamaName) await refreshOllamaProvider()
    } catch (error) {
      set((s) => ({ errors: { ...s.errors, [id]: message(error) } }))
    }
  },

  async removeDownloaded(repoId, filename) {
    await window.api.models.delete(repoId, filename)
    await get().refresh()
    await refreshOllamaProvider()
  },

  async startOllama() {
    set({ startingOllama: true })
    try {
      await window.api.modelLibrary.startOllama()
      await get().refresh()
      await refreshOllamaProvider()
    } catch (error) {
      set((s) => ({ errors: { ...s.errors, ollama: message(error) } }))
      throw error
    } finally {
      set({ startingOllama: false })
    }
  }
}))
