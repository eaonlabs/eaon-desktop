import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

/**
 * A small but honest MCP server over streamable HTTP, optionally behind an
 * OAuth 2.1 authorization server of its own: RFC 9728 and RFC 8414 metadata,
 * Dynamic Client Registration, PKCE (S256, verified), refresh tokens, and a
 * way to expire an access token mid-session. Only what the client under test
 * needs, but every check a real server makes on the flow is made here too.
 */

export interface FakeMcpOptions {
  /** Require OAuth. Default: no auth at all. */
  oauth?: boolean
  /** Offer Dynamic Client Registration (default true when oauth). */
  dcr?: boolean
  /** A pre-made confidential client for the no-DCR case. */
  manualClient?: { id: string; secret: string }
  tools?: { name: string; description: string }[]
}

export interface FakeMcp {
  base: string
  url: string
  server: Server
  /** Every client registered through DCR. */
  registrations: Record<string, unknown>[]
  /** Parameters of every /authorize request. */
  authorizeRequests: URLSearchParams[]
  /** Parameters of every /token request. */
  tokenRequests: URLSearchParams[]
  /** Access tokens currently accepted by the MCP endpoint. */
  validTokens: Set<string>
  /** Bearer tokens seen on MCP requests, in order. */
  seenTokens: string[]
  close: () => Promise<void>
}

const json = (res: import('node:http').ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url')

export async function fakeMcp(options: FakeMcpOptions = {}): Promise<FakeMcp> {
  const oauth = options.oauth === true
  const dcr = oauth && options.dcr !== false
  const tools = options.tools ?? [
    { name: 'echo', description: 'Echoes its input' },
    { name: 'whoami', description: 'Says which token called it' }
  ]
  const registrations: Record<string, unknown>[] = []
  const authorizeRequests: URLSearchParams[] = []
  const tokenRequests: URLSearchParams[] = []
  const validTokens = new Set<string>()
  const refreshTokens = new Set<string>()
  const seenTokens: string[] = []
  const clients = new Map<string, { secret?: string; redirectUris: string[] }>()
  if (options.manualClient) clients.set(options.manualClient.id, { secret: options.manualClient.secret, redirectUris: [] })
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>()
  let counter = 0

  let base = ''
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' && oauth) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read', 'write'] })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server' && oauth) {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(dcr ? { registration_endpoint: `${base}/register` } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: dcr ? ['none'] : ['client_secret_post']
      })
    }
    if (url.pathname === '/register' && req.method === 'POST' && dcr) {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>
      registrations.push(body)
      const clientId = `dcr-client-${++counter}`
      clients.set(clientId, { redirectUris: body.redirect_uris as string[] })
      return json(res, 201, { ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) })
    }
    if (url.pathname === '/authorize' && oauth) {
      authorizeRequests.push(url.searchParams)
      const p = url.searchParams
      const client = clients.get(p.get('client_id') ?? '')
      const redirectUri = p.get('redirect_uri') ?? ''
      if (!client) return json(res, 400, { error: 'invalid_client' })
      if (client.redirectUris.length > 0 && !client.redirectUris.includes(redirectUri)) return json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri mismatch' })
      if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
        return json(res, 400, { error: 'invalid_request' })
      }
      const code = `code-${++counter}`
      codes.set(code, { challenge: p.get('code_challenge')!, clientId: p.get('client_id')!, redirectUri })
      const back = new URL(redirectUri)
      back.searchParams.set('code', code)
      if (p.get('state')) back.searchParams.set('state', p.get('state')!)
      res.writeHead(302, { Location: back.href })
      return res.end()
    }
    if (url.pathname === '/token' && req.method === 'POST' && oauth) {
      const params = new URLSearchParams(await readBody(req))
      tokenRequests.push(params)
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')
        : null
      const clientId = params.get('client_id') ?? (basic ? decodeURIComponent(basic[0]) : '')
      const client = clients.get(clientId)
      if (!client) return json(res, 401, { error: 'invalid_client' })
      if (client.secret && (params.get('client_secret') ?? (basic ? decodeURIComponent(basic[1]) : '')) !== client.secret) {
        return json(res, 401, { error: 'invalid_client', error_description: 'bad secret' })
      }
      const issue = (): void => {
        const access = `at-${++counter}`
        const refresh = `rt-${counter}`
        validTokens.add(access)
        refreshTokens.add(refresh)
        json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh })
      }
      if (params.get('grant_type') === 'authorization_code') {
        const code = codes.get(params.get('code') ?? '')
        codes.delete(params.get('code') ?? '')
        if (!code || code.clientId !== clientId) return json(res, 400, { error: 'invalid_grant' })
        if (s256(params.get('code_verifier') ?? '') !== code.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
        if (params.get('redirect_uri') !== code.redirectUri) return json(res, 400, { error: 'invalid_grant' })
        return issue()
      }
      if (params.get('grant_type') === 'refresh_token') {
        if (!refreshTokens.delete(params.get('refresh_token') ?? '')) return json(res, 400, { error: 'invalid_grant' })
        return issue()
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }

    if (url.pathname === '/mcp') {
      if (oauth) {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
        seenTokens.push(token)
        if (!validTokens.has(token)) {
          await readBody(req)
          res.writeHead(401, {
            'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
          })
          return res.end()
        }
      }
      if (req.method === 'GET') {
        res.writeHead(405)
        return res.end()
      }
      if (req.method === 'DELETE') {
        res.writeHead(200)
        return res.end()
      }
      const message = JSON.parse(await readBody(req)) as { id?: number; method: string; params?: Record<string, unknown> }
      if (message.id === undefined) {
        res.writeHead(202)
        return res.end()
      }
      const reply = (result: unknown): void => json(res, 200, { jsonrpc: '2.0', id: message.id, result })
      if (message.method === 'initialize') {
        return reply({
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '1' }
        })
      }
      if (message.method === 'tools/list') {
        return reply({
          tools: tools.map((t) => ({
            ...t,
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            annotations: { readOnlyHint: true }
          }))
        })
      }
      if (message.method === 'tools/call') {
        const args = (message.params?.arguments ?? {}) as { text?: string }
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? 'anonymous'
        const text = message.params?.name === 'whoami' ? token : String(args.text ?? '')
        return reply({ content: [{ type: 'text', text }] })
      }
      return json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such method' } })
    }

    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    base,
    url: `${base}/mcp`,
    server,
    registrations,
    authorizeRequests,
    tokenRequests,
    validTokens,
    seenTokens,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/**
 * Plays the browser: follows the authorization URL to its redirect and
 * delivers it to the app's loopback listener, as a real browser would after
 * the user clicked Allow.
 */
export async function actAsBrowser(authorizationUrl: string): Promise<void> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' })
  const location = res.headers.get('location')
  if (!location) throw new Error(`authorize answered ${res.status}: ${await res.text()}`)
  await fetch(location)
}
