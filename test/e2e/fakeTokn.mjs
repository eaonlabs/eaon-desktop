/**
 * A Tokn (toknhq.com) on loopback for the end-to-end suite: it approves
 * anyone as @alex and keeps what is sent to it. Eaon is pointed at it with
 * EAON_TOKN_HOST (and EAON_TOKNS_HOST for the Eaon site's pages); the tokn
 * command Eaon runs is pointed at it through the same variable.
 */
import { createServer } from 'node:http'

export async function startFakeTokn() {
  /** @type {any[]} Uploads from Eaon (cliVersion eaon-desktop/…) and from the tokn command. */
  const syncs = []
  /** @type {string[]} Every request, as "METHOD /path". */
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const reply = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify(value))
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    requests.push(`${req.method} ${path}`)
    const user = { id: 'u_e2e', handle: 'alex', name: 'Alex' }
    if (path === '/api/oauth/token') return reply(200, { access_token: 'tok_e2e', token_type: 'Bearer', user })
    if (path === '/api/oauth/revoke') return reply(200, {})
    if (path === '/api/cli/me') return reply(200, { user })
    if (path === '/api/cli/pricing') return reply(200, { models: {} })
    if (path === '/api/cli/sync') {
      syncs.push(JSON.parse(body || '{}'))
      return reply(200, { accepted: 0, rank: 1 })
    }
    // Eaon asking for a code for its tokn command, with its own token.
    if (path === '/api/cli/link-code') {
      if (req.headers.authorization !== 'Bearer tok_e2e') return reply(401, { error: 'this machine is no longer linked' })
      return reply(200, { code: 'ABCD-2345', expiresAt: new Date(Date.now() + 600_000).toISOString() })
    }
    // The tokn command redeeming it.
    if (path === '/api/cli/link') {
      const { code } = JSON.parse(body || '{}')
      if (code !== 'ABCD-2345') return reply(404, { error: 'that code has expired or was already used' })
      return reply(200, { token: 'tok_cli_e2e', user })
    }
    reply(404, { error: 'not found' })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)))
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    url: `http://127.0.0.1:${port}`,
    syncs,
    requests,
    close: () => new Promise((done) => server.close(() => done(undefined)))
  }
}

/**
 * Plays the browser for "Sign in with Tokn": reads the approval page Eaon
 * asked to open and follows Tokn's redirect back to Eaon with a code.
 * @param {import('./harness.mjs').Page} page
 */
export async function approveToknSignIn(page) {
  const authorize = await page.waitFor(async () => (await window.api.usage.account()).signIn.url ?? null, {
    message: 'the Tokn approval page',
    timeout: 15_000
  })
  const params = new URL(authorize).searchParams
  const redirect = new URL(/** @type {string} */ (params.get('redirect_uri')))
  redirect.searchParams.set('code', 'code_e2e')
  redirect.searchParams.set('state', /** @type {string} */ (params.get('state')))
  const back = await fetch(redirect, { headers: { Connection: 'close' } })
  if (back.status !== 200) throw new Error(`Eaon's sign-in page answered ${back.status}`)
  return params
}
