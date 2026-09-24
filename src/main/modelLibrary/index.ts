import os from 'node:os'
import { libraryProgressKey, pullRef, type LibraryState } from '@shared/modelLibrary'
import type { ModelDownloadProgress } from '@shared/types'
import { findLibraryModel } from './catalog'
import { deleteModel, listInstalled, ollamaStatus, ollamaVersion, pullModel, type PullProgress } from './ollama'

export { LIBRARY } from './catalog'
export { startOllama } from './ollama'

/** In-flight pulls by progress key, so a second click can't start a duplicate and Cancel has something to abort. */
const inflight = new Map<string, AbortController>()

export async function libraryState(): Promise<LibraryState> {
  const ollama = await ollamaStatus()
  const installed = ollama.state === 'running' ? await listInstalled().catch(() => []) : []
  return { ramBytes: os.totalmem(), chip: os.cpus()[0]?.model.trim() ?? '', ollama, installed }
}

/**
 * Pulls one catalog variant through Ollama. Only ids from the catalog are
 * accepted — the renderer never gets to name an arbitrary thing to pull.
 * Progress goes out on the same channel as Hugging Face downloads so the
 * header's Downloads panel shows it, throttled because `/api/pull` reports
 * every few kilobytes and each event re-renders that panel.
 */
export async function pullLibraryVariant(
  modelId: string,
  variantId: string,
  send: (channel: string, progress: ModelDownloadProgress) => void
): Promise<{ name: string }> {
  const model = findLibraryModel(modelId)
  const variant = model?.variants.find((v) => v.id === variantId)
  if (!model || !variant) throw new Error(`Unknown library model ${modelId}/${variantId}`)
  if (model.unsupported) throw new Error(model.unsupported)
  if (!(await ollamaVersion())) throw new Error('Ollama isn’t running. Start it from the Models page, then try again.')

  const key = libraryProgressKey(model, variant)
  const id = `${key.repoId}::${key.filename}`
  if (inflight.has(id)) throw new Error(`${model.name} is already downloading.`)
  const controller = new AbortController()
  inflight.set(id, controller)

  let lastSent = 0
  let lastPhase: PullProgress['phase'] | null = null
  const emit = (progress: PullProgress, force = false): void => {
    const now = Date.now()
    if (!force && progress.phase === lastPhase && now - lastSent < 150) return
    lastSent = now
    lastPhase = progress.phase
    send('models:download-progress', { ...key, ...progress })
  }

  try {
    // Show the row in the Downloads panel before Ollama has resolved the manifest.
    emit({ receivedBytes: 0, totalBytes: variant.sizeBytes, phase: 'downloading' }, true)
    await pullModel(pullRef(variant), variant.sizeBytes, emit, controller.signal)
    return { name: pullRef(variant) }
  } finally {
    inflight.delete(id)
  }
}

export function cancelLibraryPull(modelId: string, variantId: string): void {
  const model = findLibraryModel(modelId)
  const variant = model?.variants.find((v) => v.id === variantId)
  if (!model || !variant) return
  const key = libraryProgressKey(model, variant)
  inflight.get(`${key.repoId}::${key.filename}`)?.abort()
}

export function cancelAllLibraryPulls(): void {
  for (const controller of inflight.values()) controller.abort()
}

/** Removes a model from Ollama by the exact name `/api/tags` listed it under. */
export async function removeInstalledModel(name: string): Promise<void> {
  const installed = await listInstalled()
  if (!installed.some((m) => m.name === name)) throw new Error(`${name} isn’t installed in Ollama.`)
  await deleteModel(name)
}
