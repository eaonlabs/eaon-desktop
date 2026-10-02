import { readFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import {
  diskShortfall,
  libraryProgressKey,
  mainFile,
  projectorFile,
  runtimeGap,
  type InstalledModel,
  type LibraryModel,
  type LibraryState,
  type LibraryVariant,
  type RuntimeInfo
} from '@shared/modelLibrary'
import type { DownloadedModel, ModelDownloadProgress } from '@shared/types'
import { isEmbeddingModel, localModelId, localModels } from '../llama/models'
import { llamaBinary, llamaRuntime } from '../llama/runtime'
import { deleteDownloadedModel, fetchHfFile, freeBytes, localPathFor, modelsDir } from '../modelHub'
import { store } from '../store'
import { findLibraryModel } from './catalog'

export { LIBRARY } from './catalog'

/**
 * The curated library, run by Eaon's own llama.cpp: Get downloads a variant's
 * GGUF (and vision projector) from Hugging Face into Eaon's models folder,
 * where the "On this computer" provider finds it. No Ollama anywhere.
 *
 * In-flight downloads by progress key: a second Get joins the one running,
 * and Cancel has something to abort.
 */
const inflight = new Map<string, { controller: AbortController; promise: Promise<{ id: string }> }>()

/** The PRs the bundled llama-server was built with, from the build.json next to it. */
function runtimePulls(binary: string | null): number[] {
  if (!binary) return []
  try {
    const info = JSON.parse(readFileSync(join(dirname(binary), 'build.json'), 'utf8')) as { pulls?: unknown }
    return Array.isArray(info.pulls) ? info.pulls.filter((n): n is number => typeof n === 'number') : []
  } catch {
    return []
  }
}

export async function runtimeInfo(): Promise<RuntimeInfo> {
  const status = await llamaRuntime.status()
  return { available: status.binary !== null, version: status.version, pulls: runtimePulls(status.binary), loaded: status.chat }
}

function installedFrom(model: DownloadedModel): InstalledModel {
  return {
    id: localModelId(model),
    label: model.label ?? `${model.repoId.split('/').pop()?.replace(/-gguf$/i, '')} · ${model.quant}`,
    repoId: model.repoId,
    filename: model.filename,
    quant: model.quant,
    sizeBytes: model.sizeBytes,
    downloadedAt: model.downloadedAt,
    ...(model.library ? { library: model.library } : {}),
    vision: Boolean(model.mmprojPath),
    embedding: isEmbeddingModel(model)
  }
}

export async function libraryState(): Promise<LibraryState> {
  return {
    ramBytes: os.totalmem(),
    freeDiskBytes: await freeBytes(modelsDir()),
    chip: os.cpus()[0]?.model.trim() ?? '',
    runtime: await runtimeInfo(),
    installed: localModels().map(installedFrom)
  }
}

/**
 * Downloads one catalog variant. Only ids from the catalog are accepted — the
 * renderer never names an arbitrary thing to fetch. Progress goes out on the
 * channel the header's Downloads panel listens to.
 */
export async function pullLibraryVariant(
  modelId: string,
  variantId: string,
  send: (channel: string, progress: ModelDownloadProgress) => void
): Promise<{ id: string }> {
  const model = findLibraryModel(modelId)
  const variant = model?.variants.find((v) => v.id === variantId)
  if (!model || !variant) throw new Error(`Unknown library model ${modelId}/${variantId}`)
  const key = libraryProgressKey(model, variant)
  const id = `${key.repoId}::${key.filename}`
  const running = inflight.get(id)
  if (running) return running.promise
  const controller = new AbortController()
  const promise = downloadVariant(model, variant, send, controller.signal).finally(() => inflight.delete(id))
  inflight.set(id, { controller, promise })
  return promise
}

async function downloadVariant(
  model: LibraryModel,
  variant: LibraryVariant,
  send: (channel: string, progress: ModelDownloadProgress) => void,
  signal: AbortSignal
): Promise<{ id: string }> {
  const gap = runtimeGap(model, await runtimeInfo())
  if (gap) throw new Error(gap)
  // Checked here too: the page's numbers may be minutes old, and a download
  // that fills the disk fails late and leaves the system short of space.
  const shortfall = diskShortfall(variant.sizeBytes, await freeBytes(modelsDir()))
  if (shortfall) throw new Error(shortfall)

  const key = libraryProgressKey(model, variant)
  const emit = (receivedBytes: number, phase: ModelDownloadProgress['phase'] = 'downloading'): void =>
    send('models:download-progress', { ...key, receivedBytes, totalBytes: variant.sizeBytes, phase })
  emit(0)

  const { repo, files } = variant.source
  let done = 0
  for (const file of files) {
    const dest = localPathFor(repo, file)
    // A projector another variant of this repo already brought is reused.
    const existing = localModels().some((m) => m.mmprojPath === dest)
    if (existing && /mmproj/i.test(file)) continue
    done += await fetchHfFile(repo, file, dest, signal, (received) => emit(done + received))
  }

  const main = mainFile(variant)
  const projector = projectorFile(variant)
  const entry: DownloadedModel = {
    repoId: repo,
    filename: main,
    quant: variant.quant,
    sizeBytes: variant.sizeBytes,
    path: localPathFor(repo, main),
    downloadedAt: Date.now(),
    ...(projector ? { mmprojFilename: projector, mmprojPath: localPathFor(repo, projector) } : {}),
    library: { modelId: model.id, variantId: variant.id },
    label: `${model.name} · ${variant.quant}`,
    capabilities: model.capabilities,
    contextLength: model.contextLength
  }
  const others = store.getDownloadedModels().filter((m) => !(m.repoId === repo && m.filename === main))
  store.saveDownloadedModels([...others, entry])
  return { id: localModelId(entry) }
}

export function cancelLibraryPull(modelId: string, variantId: string): void {
  const model = findLibraryModel(modelId)
  const variant = model?.variants.find((v) => v.id === variantId)
  if (!model || !variant) return
  const key = libraryProgressKey(model, variant)
  inflight.get(`${key.repoId}::${key.filename}`)?.controller.abort()
}

export function cancelAllLibraryPulls(): void {
  for (const { controller } of inflight.values()) controller.abort()
}

/** Deletes a downloaded model (by its picker id), unloading it first if it is running. */
export async function removeInstalledModel(id: string): Promise<void> {
  const model = localModels().find((m) => localModelId(m) === id)
  if (!model) throw new Error(`${id} isn’t downloaded.`)
  const status = await llamaRuntime.status()
  if (status.chat?.modelId === id) llamaRuntime.unload('chat')
  if (status.embedding?.modelId === id) llamaRuntime.unload('embedding')
  await deleteDownloadedModel(model.repoId, model.filename)
}

export { llamaBinary }
