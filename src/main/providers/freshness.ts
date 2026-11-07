import type { ModelInfo, Provider } from '@shared/types'
import { LOCAL_MODEL_PROVIDER, providerReadiness } from '@shared/modelSelection'
import { GATEWAY_PROVIDER_ID } from '@shared/freeCredits'
import { goesToEaonGateway } from '../eaonAddress'
import { providerMeta } from './catalog'

/**
 * Keeps connected providers' model lists fresh without anyone pressing
 * Refresh: shortly after launch and then every ten minutes, each provider
 * that is switched on, signed in or keyed, and has a listing endpoint asks
 * for its own `/models` again when its list is older than `MAX_AGE_MS` (a few
 * hours). Eaon Lite's list is changed on gateway.eaon.dev, so it is asked
 * every ten minutes (`EAON_MAX_AGE_MS`).
 *
 * Local runtimes have their own, faster discovery (localDiscovery.ts); a
 * provider whose last check found its credentials broken is left alone until
 * the user fixes it, rather than retried every few hours. Eaon's own gateway
 * (Eaon Lite, Eaon Event) is the exception: it takes no key, and what it
 * refuses is this copy of Eaon or a code, which an update or a change on
 * gateway.eaon.dev ends without anyone touching Settings. So it is asked
 * again at every tick while it refuses, and first of all right at launch,
 * before anyone opens a model picker; the gateway answers a refusal before
 * counting anything against its limits, so asking costs nothing. (A healthy
 * listing does count, per network, so it waits for the first check like the
 * rest.) Its limit for the day is waited out. A failed refresh keeps the last list
 * that worked (`refreshModels` only replaces it on success) and the picker
 * never flickers: listeners hear about a change only when a list, or whether
 * a provider needs attention, actually changed.
 */

export const FIRST_CHECK_MS = 20_000
export const EVERY_MS = 10 * 60_000
export const MAX_AGE_MS = 6 * 60 * 60_000
export const EAON_MAX_AGE_MS = 10 * 60_000
/** Several providers at once, but not sixty: some hosts rate-limit `/models`. */
const CONCURRENCY = 3

const failed = (p: Provider): boolean => Boolean(p.health && !p.health.ok)

/** The providers due for a background refresh at `now`. Pure, for tests. */
export function providersDue(providers: Provider[], now: number, maxAge = MAX_AGE_MS): Provider[] {
  return providers.filter((p) => {
    if (p.local || p.id === LOCAL_MODEL_PROVIDER || !providerMeta(p.id).listsModels) return false
    if (!p.enabled || !(p.hasKey || p.signedIn || p.auth === 'none')) return false
    // The gateway's limit for the day: asking before it ends only gets the same answer.
    if (failed(p) && p.health?.until && p.health.until > now) return false
    if (goesToEaonGateway(p) && failed(p)) return true
    if (providerReadiness(p).state === 'attention' && failed(p)) return false
    const age = p.id === GATEWAY_PROVIDER_ID ? Math.min(maxAge, EAON_MAX_AGE_MS) : maxAge
    return !p.modelsListedAt || now - p.modelsListedAt >= age
  })
}

const fingerprint = (models: ModelInfo[]): string => models.map((m) => `${m.id}\u0000${m.label}`).join('\n')

/** What the pages show of a provider: what needs attention, then (after a separator no message contains) its list. */
const shown = (p: Provider | undefined): string => `${p && failed(p) ? (p.health?.issue?.message ?? '') : ''}\u0001${fingerprint(p?.models ?? [])}`

export interface FreshnessDeps {
  list: () => Provider[]
  get: (id: string) => Provider | undefined
  refresh: (id: string) => Promise<unknown>
  now?: () => number
  maxAge?: number
}

/** Refreshes every due provider (of those `only` picks); resolves true when what any of them shows changed. Never throws. */
export async function refreshDueProviders(deps: FreshnessDeps, only: (p: Provider) => boolean = () => true): Promise<boolean> {
  const now = deps.now?.() ?? Date.now()
  const due = providersDue(deps.list(), now, deps.maxAge).filter(only)
  let changed = false
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < due.length) {
      const provider = due[next++]
      const before = shown(provider)
      try {
        await deps.refresh(provider.id)
      } catch {
        // Kept: the last list that worked, now marked as the kept copy.
      }
      if (shown(deps.get(provider.id)) !== before) changed = true
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker))
  return changed
}

/** Starts the background refresh, a refusal from Eaon's gateway at once; returns a function that stops it. */
export function startModelFreshness(deps: FreshnessDeps, onChanged: () => void): () => void {
  let running = false
  const tick = (only?: (p: Provider) => boolean): void => {
    if (running) return
    running = true
    void refreshDueProviders(deps, only)
      .then((changed) => changed && onChanged())
      .finally(() => {
        running = false
      })
  }
  tick((p) => goesToEaonGateway(p) && failed(p))
  const first = setTimeout(tick, FIRST_CHECK_MS)
  const timer = setInterval(tick, EVERY_MS)
  first.unref?.()
  timer.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
