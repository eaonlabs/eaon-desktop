import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProviderAuthStatus } from '@shared/providers'
import { providerAuthFeature } from '../src/main/features/providerAuth'
import type { FeatureContext } from '../src/main/features/types'
import { __test as codex } from '../src/main/providers/oauth/codex'

/** Registers the feature against a recording ipcMain and window. */
function register(): { handlers: Map<string, (...args: unknown[]) => unknown>; sent: [string, unknown][] } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const sent: [string, unknown][] = []
  providerAuthFeature.register({
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
    getWindow: () => null,
    send: (channel: string, payload: unknown) => sent.push([channel, payload]),
    emitStream: () => {}
  } as unknown as FeatureContext)
  return { handlers, sent }
}

test('signing out tells the settings page, so it stops showing "Signed in"', async () => {
  // The page refreshes its provider list (and so `signedIn`) only on a status
  // event; sign-out used to return its status without sending one.
  codex.store.set({ access: 'a', refresh: 'r', expires: Date.now() + 3_600_000, accountId: 'acct' })
  const { handlers, sent } = register()
  await handlers.get('provider-auth:sign-out')!(null, 'openai-codex')
  const status = sent.find(([channel]) => channel === 'provider-auth:status')?.[1] as ProviderAuthStatus | undefined
  assert.ok(status, 'a status event is published')
  assert.equal(status.providerId, 'openai-codex')
  assert.equal(status.signedIn, false)
  assert.equal(status.state, 'idle')
  providerAuthFeature.dispose?.()
})
