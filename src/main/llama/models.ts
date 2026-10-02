import type { DownloadedModel, ModelInfo } from '@shared/types'
import { store } from '../store'
import type { RuntimeModel } from './runtime'

/**
 * The models Eaon's runtime can run: every GGUF downloaded on the Models
 * page, from the curated library or from Browse Hugging Face. They appear in
 * the model picker under the built-in "On this computer" provider.
 */

export const LOCAL_PROVIDER_ID = 'eaon-local'

/** The id a downloaded model goes by in the picker and in requests. */
export function localModelId(model: Pick<DownloadedModel, 'repoId' | 'quant' | 'filename' | 'library'>): string {
  if (model.library) return `${model.library.modelId}:${model.library.variantId}`
  const repo = model.repoId.split('/').pop() ?? model.repoId
  return `${repo.replace(/-gguf$/i, '')}:${model.quant || model.filename.replace(/\.gguf$/i, '')}`.toLowerCase()
}

export const isEmbeddingModel = (model: DownloadedModel): boolean =>
  model.capabilities?.includes('embedding') === true || /embed/i.test(model.repoId)

export function localModels(): DownloadedModel[] {
  return store.getDownloadedModels()
}

export function findLocalModel(id: string): DownloadedModel | undefined {
  return localModels().find((model) => localModelId(model) === id)
}

export function runtimeModel(model: DownloadedModel): RuntimeModel {
  return {
    id: localModelId(model),
    path: model.path,
    ...(model.mmprojPath ? { mmprojPath: model.mmprojPath } : {}),
    ...(model.contextLength ? { contextLength: model.contextLength } : {})
  }
}

/** A downloaded chat model as the picker lists it. */
export function localModelInfo(model: DownloadedModel): ModelInfo {
  const caps = new Set(model.capabilities ?? [])
  const repo = model.repoId.split('/').pop()?.replace(/-gguf$/i, '') ?? model.repoId
  return {
    id: localModelId(model),
    label: model.label ?? `${repo} · ${model.quant}`,
    providerId: LOCAL_PROVIDER_ID,
    // A model the library did not describe may still call tools: llama-server
    // renders its own chat template, and --jinja parses the calls back out.
    tools: model.capabilities ? caps.has('tools') : true,
    ...(model.mmprojPath ? { vision: true } : {}),
    reasoning: caps.has('reasoning'),
    efforts: [],
    contextWindow: Math.min(model.contextLength ?? 32_768, 32_768)
  }
}
