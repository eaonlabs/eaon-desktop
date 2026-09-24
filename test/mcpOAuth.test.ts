import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { MCP_OAUTH_REDIRECT_URI } from '@shared/mcpCatalog'
import type { McpServer } from '@shared/types'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { callMcpTool, getStatuses, reconnectMcpServer, shutdownMcp, syncMcpServers } from '../src/main/mcp'
import { cancelSignIn, ClientIdRequiredError, hasOAuthTokens, resetOAuthCache, signIn, signOut } from '../src/main/mcpOAuth'
import { actAsBrowser, fakeMcp } from './mcpFixtures'

/**
 * The browser sign-in end to end against a local OAuth-protected MCP server:
 * discovery, Dynamic Client Registration, PKCE, the loopback redirect, the
 * code exchange, connecting with the token, a refresh on 401, surviving a
 * restart, and the manual-client path for servers without DCR.
 */

const opened: string[] = []
const browser = globalThis as { __eaonOpenExternal?: (url: string) => Promise<void> | void }
browser.__eaonOpenExternal = async (url) => {
  opened.push(url)
  await actAsBrowser(url)
}

const row = (id: string, url: string): McpServer => ({
  id,
  name: id,
  transport: 'http',
  command: '',
  args: [],
  env: {},
  url,
  enabled: true,
  official: false
})

const statusOf = (id: string) => getStatuses().find((s) => s.serverId === id)

after(async () => {
  await shutdownMcp()
})

test('a server that wants OAuth shows "needs sign-in" without opening a browser or registering', async () => {
  const fake = await fakeMcp({ oauth: true })
  try {
    store.saveMcpServers([row('bg', fake.url)])
    await syncMcpServers()
    assert.equal(statusOf('bg')?.state, 'needs-auth')
    assert.equal(opened.length, 0, 'a background connect must never open the browser')
    assert.equal(fake.registrations.length, 0, 'a background connect must never register a client')
  } finally {
    await fake.close()
  }
})

test('sign-in registers, uses PKCE, connects, refreshes on 401 and survives a restart', async () => {
  const fake = await fakeMcp({ oauth: true })
  try {
    store.saveMcpServers([row('oauth', fake.url)])
    opened.length = 0

    await signIn('oauth', fake.url)

    // Registered as a public native client with the fixed loopback redirect.
    assert.equal(fake.registrations.length, 1)
    assert.deepEqual(fake.registrations[0].redirect_uris, [MCP_OAUTH_REDIRECT_URI])
    assert.equal(fake.registrations[0].token_endpoint_auth_method, 'none')
    // The browser was sent to the authorization endpoint with PKCE, state and
    // the RFC 8707 resource indicator.
    assert.equal(opened.length, 1)
    const authorize = fake.authorizeRequests[0]
    assert.equal(authorize.get('code_challenge_method'), 'S256')
    assert.ok(authorize.get('state'))
    assert.equal(authorize.get('resource'), fake.url)
    assert.equal(authorize.get('redirect_uri'), MCP_OAUTH_REDIRECT_URI)
    // The fake verifies the PKCE verifier against the challenge; a token only
    // comes back if it matched.
    assert.equal(fake.tokenRequests[0].get('grant_type'), 'authorization_code')
    assert.ok(hasOAuthTokens('oauth', fake.url))
    // Stored in the vault, never in mcp.json.
    assert.match(secrets.get('mcp-oauth:oauth') ?? '', /access_token/)
    assert.ok(!JSON.stringify(store.getMcpServers()).includes('at-'))

    const status = await reconnectMcpServer('oauth')
    assert.equal(status?.state, 'ready')
    assert.equal(status?.toolCount, 2)
    const first = await callMcpTool('whoami', {}, 5000, 'oauth')
    assert.match(first, /^at-/)

    // The access token expires mid-session: the next call gets a 401, the SDK
    // refreshes through our provider, and the call goes through — no browser.
    fake.validTokens.clear()
    const second = await callMcpTool('whoami', {}, 5000, 'oauth')
    assert.match(second, /^at-/)
    assert.notEqual(second, first)
    assert.equal(fake.tokenRequests.at(-1)?.get('grant_type'), 'refresh_token')
    assert.equal(opened.length, 1)

    // A restart: nothing in memory, tokens come back out of the vault.
    await shutdownMcp()
    resetOAuthCache()
    await syncMcpServers()
    assert.equal(statusOf('oauth')?.state, 'ready')
    assert.equal(await callMcpTool('whoami', {}, 5000, 'oauth'), second)

    // Tokens issued for this URL are never offered to a different one.
    assert.equal(hasOAuthTokens('oauth', 'http://127.0.0.1:1/elsewhere'), false)

    // Signing out drops the tokens; the server goes back to "Sign in".
    await signOut('oauth', fake.url)
    assert.equal(hasOAuthTokens('oauth', fake.url), false)
    const after = await reconnectMcpServer('oauth')
    assert.equal(after?.state, 'needs-auth')

    // Signing in again reuses the registered client instead of making a new one.
    await signIn('oauth', fake.url)
    assert.equal(fake.registrations.length, 1)
    assert.equal((await reconnectMcpServer('oauth'))?.state, 'ready')
  } finally {
    await fake.close()
  }
})

test('servers without DCR ask for a client id, then sign in with it and its secret', async () => {
  const fake = await fakeMcp({ oauth: true, dcr: false, manualClient: { id: 'manual-client', secret: 's3cret' } })
  try {
    store.saveMcpServers([row('manual', fake.url)])
    await assert.rejects(signIn('manual', fake.url), ClientIdRequiredError)

    await signIn('manual', fake.url, { client: { clientId: 'manual-client', clientSecret: 's3cret' } })
    const exchange = fake.tokenRequests.find((p) => p.get('grant_type') === 'authorization_code')
    assert.equal(exchange?.get('client_id'), 'manual-client')
    assert.equal(exchange?.get('client_secret'), 's3cret')
    assert.equal((await reconnectMcpServer('manual'))?.state, 'ready')
  } finally {
    await fake.close()
  }
})

test('a sign-in can be cancelled, and a redirect with the wrong state is refused', async () => {
  const fake = await fakeMcp({ oauth: true })
  // A browser that never comes back.
  let authorizationUrl = ''
  browser.__eaonOpenExternal = (url) => {
    authorizationUrl = url
  }
  try {
    const pending = signIn('cancel', fake.url)
    while (!authorizationUrl) await new Promise((r) => setTimeout(r, 10))

    // A forged redirect (wrong state) is rejected and does not finish the sign-in.
    const forged = await fetch(`${MCP_OAUTH_REDIRECT_URI}?code=stolen&state=not-the-state`)
    assert.equal(forged.status, 400)

    cancelSignIn('cancel')
    await assert.rejects(pending, /cancelled/)
    assert.equal(hasOAuthTokens('cancel', fake.url), false)

    // The listener is released once nothing is waiting.
    await assert.rejects(fetch(MCP_OAUTH_REDIRECT_URI, { signal: AbortSignal.timeout(2000) }))
  } finally {
    browser.__eaonOpenExternal = async (url) => {
      opened.push(url)
      await actAsBrowser(url)
    }
    await fake.close()
  }
})
