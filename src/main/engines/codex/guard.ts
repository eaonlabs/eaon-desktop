import { isLoopbackHost } from '../../providers/compat'

/**
 * Codex pointed back at Eaon.
 *
 * Settings → Connect apps can set Codex up to use Eaon's own models through
 * the gateway (the Local API Server): `model_provider = "eaon"` with a
 * `base_url` of `http://127.0.0.1:<port>/v1`. A Codex-engine turn started by
 * Eaon would then send every model request back into Eaon, which would answer
 * with whatever model the gateway maps Codex's name to — never the Codex
 * model the user picked, and a worker on the gateway's default model could
 * end up driving itself. Eaon refuses such turns and says why, instead.
 */

export interface CodexProviderTarget {
  /** Codex's provider id ("openai" when the config names none). */
  provider: string
  /** Where that provider sends requests, when the config says; null for Codex's built-in default. */
  baseUrl: string | null
}

/** Reads the effective provider and its base URL from `config/read`'s `config`. */
export function providerTarget(config: Record<string, unknown> | null | undefined, env: NodeJS.ProcessEnv = process.env): CodexProviderTarget {
  const provider = typeof config?.model_provider === 'string' && config.model_provider ? config.model_provider : 'openai'
  const providers = (config?.model_providers && typeof config.model_providers === 'object' ? config.model_providers : {}) as Record<string, unknown>
  const entry = providers[provider] as { base_url?: unknown } | undefined
  if (entry && typeof entry.base_url === 'string' && entry.base_url) return { provider, baseUrl: entry.base_url }
  if (provider === 'openai') {
    const override = typeof config?.openai_base_url === 'string' && config.openai_base_url ? config.openai_base_url : env.OPENAI_BASE_URL || null
    return { provider, baseUrl: override }
  }
  return { provider, baseUrl: null }
}

/**
 * Why Eaon won't run turns on this Codex, or null when it's fine. `ports` are
 * the ports Eaon's Local API Server uses or is set to use.
 */
export function selfRouteReason(target: CodexProviderTarget, ports: (number | null | undefined)[]): string | null {
  if (!target.baseUrl) return null
  let url: URL
  try {
    url = new URL(target.baseUrl)
  } catch {
    return null
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  const ours = ports.filter((p): p is number => typeof p === 'number' && p > 0)
  if (!isLoopbackHost(url.hostname) || !ours.includes(port)) return null
  return (
    `Codex is set up to use Eaon’s own models: its "${target.provider}" provider sends requests to Eaon’s Local API Server (${url.host}). ` +
    'Running Eaon’s agents on it would send every request straight back into Eaon. ' +
    'To use Codex here, disconnect ChatGPT and Codex in Settings → Connect apps (or point Codex at another provider).'
  )
}
