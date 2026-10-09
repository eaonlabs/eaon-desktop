import type { ModelInfo, Provider } from '@shared/types'
import { LOCAL_MODEL_PROVIDER, providerReadiness } from '@shared/modelSelection'
import { providerMeta } from './catalog'

/**
 * Keeps connected providers' model lists fresh without anyone pressing
 * Refresh: shortly after launch and then every few hours, each provider that
 * is switched on, signed in or keyed, and has a listing endpoint asks for
 * its own `/models` again when its list is older than `MAX_AGE_MS`.
 *
 * Local runtimes have their own, faster discovery (localDiscovery.ts); a
 * provider whose last check found its credentials broken is left alone until
 * the user fixes it, rather than retried every few hours. A failed refresh
 * keeps the last list that worked (`refreshModels` only replaces it on
 * success) and the picker never flickers: listeners hear about a change only
 * when a list actually changed.
 */

export const FIRST_CHECK_MS = 20_000
export const EVERY_MS = 6 * 60 * 60_000
export const MAX_AGE_MS = 6 * 60 * 60_000
/** Several providers at once, but not sixty: some hosts rate-limit `/models`. */
const CONCURRENCY = 3

/** The providers due for a background refresh at `now`. Pure, for tests. */
export function providersDue(providers: Provider[], now: number, maxAge = MAX_AGE_MS): Provider[] {
  return providers.filter((p) => {
    if (p.local || p.id === LOCAL_MODEL_PROVIDER || !providerMeta(p.id).listsModels) return false
    if (!p.enabled || !(p.hasKey || p.signedIn)) return false
    if (providerReadiness(p).state === 'attention' && p.health && !p.health.ok) return false
    return !p.modelsListedAt || now - p.modelsListedAt >= maxAge
  })
}

const fingerprint = (models: ModelInfo[]): string => models.map((m) => `${m.id}\u0000${m.label}`).join('\n')

export interface FreshnessDeps {
  list: () => Provider[]
  get: (id: string) => Provider | undefined
  refresh: (id: string) => Promise<unknown>
  now?: () => number
  maxAge?: number
}

/** Refreshes every due provider; resolves true when any provider's visible list changed. Never throws. */
export async function refreshDueProviders(deps: FreshnessDeps): Promise<boolean> {
  const now = deps.now?.() ?? Date.now()
  const due = providersDue(deps.list(), now, deps.maxAge)
  let changed = false
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < due.length) {
      const provider = due[next++]
      const before = fingerprint(provider.models)
      try {
        await deps.refresh(provider.id)
      } catch {
        // Kept: the last list that worked, now marked as the kept copy.
      }
      if (fingerprint(deps.get(provider.id)?.models ?? []) !== before) changed = true
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker))
  return changed
}

/** Starts the background refresh; returns a function that stops it. */
export function startModelFreshness(deps: FreshnessDeps, onChanged: () => void): () => void {
  let running = false
  const tick = (): void => {
    if (running) return
    running = true
    void refreshDueProviders(deps)
      .then((changed) => changed && onChanged())
      .finally(() => {
        running = false
      })
  }
  const first = setTimeout(tick, FIRST_CHECK_MS)
  const timer = setInterval(tick, EVERY_MS)
  first.unref?.()
  timer.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
