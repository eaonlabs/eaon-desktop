import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  /** A canned `tools/call` result per tool name, instead of the echo. */
  results?: Record<string, unknown>
  /** Tools that never answer, like a server stuck on a slow backend. */
  hang?: string[]
  /** Hand out an `mcp-session-id` and insist on it, as stateful servers do. */
  sessions?: boolean
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
  /** `tools/call` requests that arrived, by tool name, and how many were cancelled by the client. */
  calls: string[]
  cancelled: number
  /** Forgets every session, as a server does when it restarts. */
  dropSessions: () => void
  /** The next this-many refresh requests fail with a 500, as a vendor having a bad minute. */
  refreshFailures: number
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
  const sessions = new Set<string>()
  const calls: string[] = []
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
        if (result.refreshFailures > 0) {
          result.refreshFailures--
          return json(res, 500, { error: 'server_error' })
        }
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
      const session = req.headers['mcp-session-id']
      if (options.sessions && message.method !== 'initialize' && !sessions.has(String(session))) {
        return json(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } })
      }
      if (message.id === undefined) {
        if (message.method === 'notifications/cancelled') result.cancelled++
        res.writeHead(202)
        return res.end()
      }
      const reply = (value: unknown, headers: Record<string, string> = {}): void =>
        json(res, 200, { jsonrpc: '2.0', id: message.id, result: value }, headers)
      if (message.method === 'initialize') {
        const id = `session-${++counter}`
        if (options.sessions) sessions.add(id)
        return reply(
          {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1' }
          },
          options.sessions ? { 'mcp-session-id': id } : {}
        )
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
        const name = String(message.params?.name)
        calls.push(name)
        if (options.hang?.includes(name)) return
        if (options.results?.[name]) return reply(options.results[name])
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
  const result: FakeMcp = {
    base,
    url: `${base}/mcp`,
    server,
    registrations,
    authorizeRequests,
    tokenRequests,
    validTokens,
    seenTokens,
    calls,
    cancelled: 0,
    dropSessions: () => sessions.clear(),
    refreshFailures: 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
  return result
}

/**
 * A stdio MCP server whose misbehaviour is scripted per test. Written to a
 * temp file and run with `node <path> '<options json>'`; plain Node, no imports.
 */
export interface StdioScript {
  /** Appends the server's pid to this file on start, one per line. */
  pidFile?: string
  /** Answers `initialize` only after this long. */
  initDelayMs?: number
  /** `tools/list` fails. */
  toolsListError?: boolean
  /** Advertises no tools capability at all (a prompts/resources-only server). */
  noTools?: boolean
  /** Advertises `tools.listChanged`; calling `grow` adds a tool and says so. */
  listChanged?: boolean
  /** Writes this to stderr and exits with status 1 before answering anything. */
  dieWith?: string
  /** Offers a `crash` tool that makes the process exit mid-call. */
  crashable?: boolean
}

const STDIO_SCRIPT = `
const options = JSON.parse(process.argv[2] || '{}')
const fs = require('node:fs')
if (options.pidFile) fs.appendFileSync(options.pidFile, process.pid + '\\n')
if (options.dieWith) {
  process.stderr.write('starting up\\n' + options.dieWith + '\\n')
  process.exit(1)
}
const tools = [{ name: 'ping', description: 'Answers pong', inputSchema: { type: 'object', properties: {} } }]
if (options.listChanged) tools.push({ name: 'grow', description: 'Adds a tool', inputSchema: { type: 'object', properties: {} } })
if (options.crashable) tools.push({ name: 'crash', description: 'Exits', inputSchema: { type: 'object', properties: {} } })
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handle(JSON.parse(line))
  }
})
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
function handle(message) {
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    const capabilities = options.noTools ? { prompts: {} } : { tools: options.listChanged ? { listChanged: true } : {} }
    const answer = () => send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities, serverInfo: { name: 'scripted', version: '1' } } })
    return options.initDelayMs ? setTimeout(answer, options.initDelayMs) : answer()
  }
  if (message.method === 'tools/list') {
    if (options.toolsListError) return send({ id: message.id, error: { code: -32603, message: 'tools are broken' } })
    return send({ id: message.id, result: { tools } })
  }
  if (message.method === 'tools/call') {
    if (message.params.name === 'crash') {
      process.stderr.write('fatal: out of memory\\n')
      process.exit(3)
    }
    if (message.params.name === 'grow') {
      tools.push({ name: 'grown', description: 'Added later', inputSchema: { type: 'object', properties: {} } })
      send({ method: 'notifications/tools/list_changed' })
    }
    return send({ id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } })
  }
  send({ id: message.id, error: { code: -32601, message: 'no such method' } })
}
`

let stdioScriptPath: string | null = null

/** Path of the scripted stdio server, written once per test process. */
export function stdioScript(): string {
  if (!stdioScriptPath) {
    const dir = mkdtempSync(join(tmpdir(), 'eaon-mcp-stdio-'))
    stdioScriptPath = join(dir, 'server.cjs')
    writeFileSync(stdioScriptPath, STDIO_SCRIPT)
  }
  return stdioScriptPath
}

/** True while a process with this pid exists. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Pids a scripted server wrote to its pid file. */
export function pidsIn(file: string): number[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

/** Polls until `check` passes or the time runs out; returns whether it passed. */
export async function eventually(check: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return check()
}

/**
 * A server that only speaks the older HTTP+SSE transport (GET an event
 * stream, POST to the endpoint it names), which plenty of hand-run servers
 * still do. Built on the SDK's own server so the wire format is the real one.
 */
export async function fakeSseMcp(): Promise<{ url: string; close: () => Promise<void> }> {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
  const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js')
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')
  const transports = new Map<string, InstanceType<typeof SSEServerTransport>>()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res)
      transports.set(transport.sessionId, transport)
      const mcp = new Server({ name: 'sse-only', version: '1' }, { capabilities: { tools: {} } })
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'legacy', description: 'Served over SSE', inputSchema: { type: 'object' as const, properties: {} } }]
      }))
      mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text' as const, text: 'over sse' }] }))
      await mcp.connect(transport)
      return
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const transport = transports.get(url.searchParams.get('sessionId') ?? '')
      if (transport) return void transport.handlePostMessage(req, res)
    }
    // What an SSE-only server says to a streamable HTTP POST on /sse.
    res.writeHead(405).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    url: `${base}/sse`,
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
