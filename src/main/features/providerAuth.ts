import { shell } from 'electron'
import type { ProviderAuthPrompt, ProviderAuthStatus, ProviderMeta } from '@shared/providers'
import { getProvider, listProviders, refreshModels } from '../providers'
import { PROVIDER_META, providerMeta } from '../providers/catalog'
import { oauthFlow, type OAuthFlow } from '../providers/oauth'
import type { Feature, FeatureContext } from './types'

/**
 * Browser sign-in for providers: ChatGPT (Codex), GitHub Copilot, and
 * OpenRouter's key minting. Tokens never cross into the renderer; it sees
 * sign-in state, the account label, and — while a sign-in runs — the URL to
 * open and the device code to type.
 *
 * Channels (all under `provider-auth:`): `meta`, `status`, `sign-in`,
 * `cancel`, `sign-out`, `submit-code`, and the `status` event pushed whenever
 * a sign-in moves.
 */

interface Running {
  controller: AbortController
  status: ProviderAuthStatus
}

const running = new Map<string, Running>()
let ctx: FeatureContext | null = null

/** The flow a provider signs in with: its OAuth flow, or the key-minting flow for OpenRouter. */
function flowFor(providerId: string): OAuthFlow | undefined {
  const provider = getProvider(providerId)
  return oauthFlow(provider?.auth === 'oauth' ? provider.oauthFlow : providerMeta(providerId).keyFlow)
}

function statusOf(providerId: string): ProviderAuthStatus | null {
  const active = running.get(providerId)
  if (active) return active.status
  const flow = flowFor(providerId)
  if (!flow) return null
  const signedIn = flow.isSignedIn()
  return { providerId, flow: flow.id, signedIn, state: 'idle', ...(signedIn && flow.account?.() ? { account: flow.account() } : {}) }
}

function allStatuses(): ProviderAuthStatus[] {
  return listProviders()
    .map((provider) => statusOf(provider.id))
    .filter((status): status is ProviderAuthStatus => status !== null)
}

const publish = (status: ProviderAuthStatus): void => ctx?.send('provider-auth:status', status)

/** Only ever hand http(s) URLs to the OS opener. */
function openInBrowser(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(parsed.href)
  } catch {
    /* not a URL; nothing to open */
  }
}

async function signIn(providerId: string): Promise<ProviderAuthStatus> {
  const flow = flowFor(providerId)
  if (!flow) throw new Error(`${providerId} has no browser sign-in.`)
  running.get(providerId)?.controller.abort()

  const entry: Running = {
    controller: new AbortController(),
    status: { providerId, flow: flow.id, signedIn: flow.isSignedIn(), state: 'pending' }
  }
  running.set(providerId, entry)
  publish(entry.status)

  const onPrompt = (prompt: ProviderAuthPrompt): void => {
    entry.status = { ...entry.status, prompt }
    publish(entry.status)
    // A device code has to be read before the page is useful, so that page
    // opens from the settings UI once the user has seen the code. A plain
    // authorization page opens straight away.
    if (!prompt.code) openInBrowser(prompt.url)
  }

  try {
    await flow.signIn(onPrompt, entry.controller.signal)
    running.delete(providerId)
    // The account's real model list (Copilot differs per plan); best effort.
    await refreshModels(providerId).catch(() => {})
    const done = statusOf(providerId)!
    publish(done)
    return done
  } catch (error) {
    running.delete(providerId)
    const cancelled = entry.controller.signal.aborted
    const failed: ProviderAuthStatus = {
      providerId,
      flow: flow.id,
      signedIn: flow.isSignedIn(),
      state: cancelled ? 'idle' : 'error',
      ...(cancelled ? {} : { error: error instanceof Error ? error.message : String(error) })
    }
    publish(failed)
    return failed
  }
}

export const providerAuthFeature: Feature = {
  id: 'providerAuth',

  register(context) {
    ctx = context
    const { ipcMain } = context
    ipcMain.handle('provider-auth:meta', (): Record<string, ProviderMeta> => PROVIDER_META)
    ipcMain.handle('provider-auth:status', (): ProviderAuthStatus[] => allStatuses())
    ipcMain.handle('provider-auth:sign-in', (_e, providerId: string) => signIn(providerId))
    ipcMain.handle('provider-auth:cancel', (_e, providerId: string) => {
      running.get(providerId)?.controller.abort()
    })
    ipcMain.handle('provider-auth:sign-out', async (_e, providerId: string) => {
      running.get(providerId)?.controller.abort()
      await flowFor(providerId)?.signOut()
      return statusOf(providerId)
    })
    ipcMain.handle('provider-auth:submit-code', (_e, providerId: string, input: string) => {
      flowFor(providerId)?.submitCode?.(input)
    })
    ipcMain.handle('provider-auth:open', (_e, url: string) => openInBrowser(url))
  },

  dispose() {
    for (const entry of running.values()) entry.controller.abort()
    running.clear()
  }
}
