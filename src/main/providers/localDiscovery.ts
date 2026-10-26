import { LOCAL_PROVIDER_ID } from '../llama/models'
import { isOwnServerUrl } from './compat'
import { clearListed, getProvider, listProviders, refreshModels } from './index'

/**
 * Keeps local runtimes' model lists current without the user asking.
 *
 * Ollama, llama.cpp and MLX serve whatever is installed right now, and
 * nothing else ever refreshed their lists — someone who installed Ollama and
 * pulled a model saw "No model" until they found the refresh button in
 * Settings. Probing is cheap (loopback, short timeout), so it runs at launch
 * and whenever the window comes back into focus, throttled.
 */

const THROTTLE_MS = 30_000
let last = 0
let running: Promise<boolean> | null = null

/** Resolves true when any local provider's model list changed. */
export function refreshLocalProviders(force = false): Promise<boolean> {
  if (running) return running
  if (!force && Date.now() - last < THROTTLE_MS) return Promise.resolve(false)
  last = Date.now()
  running = (async () => {
    let changed = false
    // Eaon's own runtime lists what is downloaded; there is no server to probe.
    const locals = listProviders().filter((p) => p.local && p.enabled && p.baseUrl && p.id !== LOCAL_PROVIDER_ID)
    await Promise.all(
      locals.map(async (provider) => {
        // The app's own Local API Server holds that port, so anything listed
        // there came from this app (see `isOwnServerUrl`); never probe it.
        if (isOwnServerUrl(provider.baseUrl)) {
          if (provider.models.length > 0) {
            clearListed(provider.id)
            changed = true
          }
          return
        }
        // The models and whether each is live or the kept copy: a server
        // that stopped or started again keeps the same ids, and Settings
        // went on saying "Ready" (or "Not running") until Refresh.
        const state = (models: typeof provider.models): string => models.map((m) => `${m.id}\u0000${m.source?.kind ?? ''}`).join('\n')
        const before = state(provider.models)
        try {
          await Promise.race([
            refreshModels(provider.id),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500))
          ])
        } catch {
          // Not running is the normal state for most local runtimes; keep the
          // last known list rather than emptying the picker.
        }
        if (state(getProvider(provider.id)?.models ?? []) !== before) changed = true
      })
    )
    return changed
  })().finally(() => {
    running = null
  })
  return running
}
