import type { EngineId, EngineModels, EngineStatus } from '@shared/engines'
import type { EngineAdapter } from './types'
import { nativeEngine } from './native'
import { codexEngine } from './codex'

/**
 * The engines Eaon can run agents on, and what it last learned about each.
 *
 * Status and model lists are cached so every picker and settings page reads
 * the same answer without each one starting the engine; `refresh` asks the
 * engines again (at launch, on a timer, and when the user presses Refresh),
 * and listeners hear about every change.
 */

const adapters = new Map<EngineId, EngineAdapter>()
const statuses = new Map<EngineId, EngineStatus>()
const modelLists = new Map<EngineId, EngineModels>()
const listeners = new Set<() => void>()
const unsubscribers = new Map<EngineId, () => void>()

export function registerEngine(adapter: EngineAdapter): void {
  unsubscribers.get(adapter.id)?.()
  adapters.set(adapter.id, adapter)
  // A turn that finds the sign-in expired says so here, so Settings doesn't keep showing "Signed in".
  const stop = adapter.subscribe?.((status) => {
    statuses.set(adapter.id, status)
    changed()
  })
  if (stop) unsubscribers.set(adapter.id, stop)
}

registerEngine(nativeEngine)
registerEngine(codexEngine)

export function engine(id: EngineId): EngineAdapter | undefined {
  return adapters.get(id)
}

export function engineIds(): EngineId[] {
  return [...adapters.keys()]
}

export function cachedStatuses(): EngineStatus[] {
  return [...statuses.values()]
}

export function cachedModels(id: EngineId): EngineModels | null {
  return modelLists.get(id) ?? null
}

export function onEnginesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function changed(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('[engines] a listener failed:', error)
    }
  }
}

/** Checks one engine (or all) again. Never throws: problems end up in each status's `error`. */
export async function refreshEngines(options: { id?: EngineId; force?: boolean; models?: boolean } = {}): Promise<EngineStatus[]> {
  const ids = options.id ? [options.id] : engineIds()
  await Promise.all(
    ids.map(async (id) => {
      const adapter = adapters.get(id)
      if (!adapter) return
      const status = await adapter.detect({ force: options.force })
      statuses.set(id, status)
      if (options.models !== false && status.installed) modelLists.set(id, await adapter.listModels({ force: options.force }))
    })
  )
  changed()
  return cachedStatuses()
}

export async function disposeEngines(): Promise<void> {
  await Promise.allSettled([...adapters.values()].map((adapter) => adapter.dispose()))
}
