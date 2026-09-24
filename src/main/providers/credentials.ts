import type { Provider } from '@shared/types'
import { secrets } from '../secrets'
import type { Credentials } from './adapters/types'
import { oauthFlow } from './oauth'

/**
 * Every set of credentials worth trying for a provider, in order.
 *
 * A key provider yields its primary key and then each fallback key; the loop
 * moves on to the next only when a request fails with an auth-shaped error.
 * A signed-in subscription provider yields one set, refreshed if needed. A
 * local runtime yields a single empty set.
 */
export async function credentialAttempts(provider: Provider): Promise<Credentials[]> {
  if (provider.auth === 'oauth') {
    const flow = oauthFlow(provider.oauthFlow)
    if (!flow) throw new Error(`${provider.name} sign-in is not available in this build.`)
    if (!flow.isSignedIn()) throw new Error(`Sign in to ${provider.name} first, in Settings → Model providers.`)
    return [await flow.credentials(provider)]
  }

  const primary = secrets.get(provider.id)
  const keys = [...(primary ? [primary] : []), ...secrets.getFallbacks(provider.id)]
  if (keys.length > 0) return keys.map((apiKey) => ({ apiKey }))
  if (provider.local || provider.auth === 'none') return [{}]
  throw new Error(`No API key for ${provider.name}. Add one in Settings → Model providers.`)
}

/** True for errors shaped like "this specific key is bad", worth retrying with the next key. */
export function isAuthError(error: unknown): boolean {
  const status = (error as { status?: number })?.status
  if (status === 401 || status === 403) return true
  const message = error instanceof Error ? error.message : String(error)
  return /^(401|403)\b/.test(message) || /invalid[_ ]api[_ ]key|unauthorized|authentication failed|incorrect api key/i.test(message)
}
