import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { diskShortfall, libraryProgressKey, pullRef, type LibraryState } from '@shared/modelLibrary'
import type { ModelDownloadProgress } from '@shared/types'
import { findLibraryModel } from './catalog'
import { deleteModel, listInstalled, ollamaStatus, ollamaVersion, pullModel, type PullProgress } from './ollama'

export { LIBRARY } from './catalog'
export { startOllama } from './ollama'

/** In-flight pulls by progress key, so a second click can't start a duplicate and Cancel has something to abort. */
const inflight = new Map<string, AbortController>()

/**
 * Free bytes on the disk Ollama writes models to: OLLAMA_MODELS if set, else
 * ~/.ollama/models. Walks up to the nearest folder that exists, since the
 * models folder is only created by the first pull.
 */
export async function freeDiskBytes(env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  let path = env.OLLAMA_MODELS || join(os.homedir(), '.ollama', 'models')
  for (;;) {
    try {
      const info = await statfs(path)
      return info.bavail * info.bsize
    } catch {
      const parent = dirname(path)
      if (parent === path) return null
      path = parent
    }
  }
}

export async function libraryState(): Promise<LibraryState> {
  const ollama = await ollamaStatus()
  const installed = ollama.state === 'running' ? await listInstalled().catch(() => []) : []
  return { ramBytes: os.totalmem(), freeDiskBytes: await freeDiskBytes(), chip: os.cpus()[0]?.model.trim() ?? '', ollama, installed }
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
  // Checked here too: the page's numbers may be minutes old, and a pull that
  // fills the disk fails late and leaves the system short of space.
  const shortfall = diskShortfall(variant.sizeBytes, await freeDiskBytes())
  if (shortfall) throw new Error(shortfall)

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
