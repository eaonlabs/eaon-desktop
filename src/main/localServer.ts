import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { hostname } from 'node:os'
import type { LocalServerStatus } from '@shared/types'
import { isLoopbackHost, setOwnServerPort } from './providers/compat'
import { anthropicError, anthropicModelList, serveCountTokens, serveMessages } from './gateway/anthropic'
import { gatewayModels, tokenAllowed } from './gateway/models'
import { serveChatCompletions } from './gateway/openaiChat'
import { serveResponses } from './gateway/responses'
import { store } from './store'

/**
 * Eaon's gateway: a local server that lets other apps on this machine use the
 * models set up in Eaon. It speaks OpenAI chat completions and Responses and
 * Anthropic Messages (see `gateway/`), tools included, through the same
 * provider adapters, keys and fallback keys the chat uses.
 *
 * Bound to 127.0.0.1 only — this exposes the user's API keys by proxy, so it
 * must never be reachable from the network.
 */

let server: Server | null = null
let status: LocalServerStatus = { running: false, port: 1337, url: null }
let onStatusChange: ((status: LocalServerStatus) => void) | null = null

export function setLocalServerListener(listener: (status: LocalServerStatus) => void): void {
  onStatusChange = listener
}

export function getLocalServerStatus(): LocalServerStatus {
  return status
}

function publish(next: LocalServerStatus): void {
  status = next
  onStatusChange?.(status)
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  const body = raw ? (JSON.parse(raw) as unknown) : {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object')
  return body as Record<string, unknown>
}

/**
 * Browser pages may call the server only from loopback origins or from
 * desktop-app schemes (Obsidian's app://, VS Code webviews, extensions) —
 * Ollama's default rule. Binding to 127.0.0.1 keeps the network out, but not
 * a website open in the user's browser, which could otherwise spend their
 * keys through this server. CLIs and SDKs send no Origin at all.
 */
function allowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    const url = new URL(origin)
    if (url.protocol === 'http:' || url.protocol === 'https:') return isLoopbackHost(url.hostname)
    return ['app:', 'file:', 'tauri:', 'vscode-webview:', 'vscode-file:', 'chrome-extension:', 'moz-extension:', 'safari-web-extension:'].includes(url.protocol)
  } catch {
    // "null": a sandboxed iframe or a redirect, which any site can arrange.
    return false
  }
}

/**
 * A DNS-rebinding page reaches this socket under its own public domain name.
 * Anything else is let through, as Ollama does: IP literals, `localhost`,
 * `.localhost`/`.local`/`.internal` names (Docker's host.docker.internal), and
 * this machine's hostname.
 */
function allowedHost(host: string | undefined): boolean {
  if (!host) return true
  let name: string
  try {
    name = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  if (isIP(name.replace(/^\[|\]$/g, ''))) return true
  return name === 'localhost' || /\.(localhost|local|internal)$/.test(name) || name === hostname().toLowerCase()
}

const OPENAPI_SPEC = {
  openapi: '3.0.0',
  info: {
    title: 'Eaon Local API',
    version: '2.0.0',
    description:
      'The models set up in Eaon, over the OpenAI (chat completions, Responses) and Anthropic (Messages) APIs, tools included. Send the key from Eaon → Settings → Local API Server as a Bearer token or x-api-key.'
  },
  paths: {
    '/v1/models': { get: { summary: 'List the models Eaon can reach (Anthropic shape when anthropic-version is sent)' } },
    '/v1/chat/completions': { post: { summary: 'OpenAI chat completions, streaming or not, with tools' } },
    '/v1/responses': { post: { summary: 'OpenAI Responses, streaming or not, with function and custom tools' } },
    '/v1/messages': { post: { summary: 'Anthropic Messages, streaming or not, with tools and thinking' } },
    '/v1/messages/count_tokens': { post: { summary: 'An estimate of the input tokens for a Messages request' } }
  }
}

const DOCS_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Eaon Local API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body style="margin:0">
    <div id="ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.onload = () => SwaggerUIBundle({ url: '/openapi.json', dom_id: '#ui' })
    </script>
  </body>
</html>`

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = req.headers.origin
  if (!allowedOrigin(origin) || !allowedHost(req.headers.host)) {
    json(res, 403, { error: { message: 'The Local API Server only answers this machine’s apps and loopback pages.' } })
    return
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key,anthropic-version,anthropic-beta,openai-beta'
    })
    res.end()
    return
  }

  if (url.pathname === '/docs') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(DOCS_HTML)
    return
  }

  if (url.pathname === '/openapi.json') {
    json(res, 200, OPENAPI_SPEC)
    return
  }

  // Health checks: Claude Code sends HEAD /api/hello before its first request.
  if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/api/hello')) {
    json(res, 200, { status: 'ok', name: 'Eaon Local API' })
    return
  }

  // Apps whose base URL leaves out /v1 call /chat/completions and the like.
  const path = /^\/(models|chat\/completions|responses|messages(\/count_tokens)?)$/.test(url.pathname.replace(/\/+$/, ''))
    ? `/v1${url.pathname.replace(/\/+$/, '')}`
    : url.pathname.replace(/\/+$/, '')
  const anthropicStyle = path.startsWith('/v1/messages') || typeof req.headers['anthropic-version'] === 'string'

  if (!tokenAllowed(req.headers)) {
    const message = 'That key is not this Eaon’s. The key is in Eaon → Settings → Local API Server.'
    json(res, 401, anthropicStyle ? anthropicError(message, 'authentication_error') : { error: { message, type: 'invalid_api_key', code: 'invalid_api_key' } })
    return
  }

  if (path === '/v1/models' && req.method === 'GET') {
    if (typeof req.headers['anthropic-version'] === 'string') {
      json(res, 200, anthropicModelList())
      return
    }
    const created = Math.floor(Date.now() / 1000)
    json(res, 200, { object: 'list', data: gatewayModels().map((m) => ({ id: m.id, object: 'model', created, owned_by: m.provider })) })
    return
  }

  const routes: Record<string, (body: Record<string, unknown>) => Promise<void> | void> = {
    '/v1/chat/completions': (body) => serveChatCompletions(res, body),
    '/v1/responses': (body) => serveResponses(res, body),
    '/v1/messages': (body) => serveMessages(res, body),
    '/v1/messages/count_tokens': (body) => serveCountTokens(res, body)
  }
  const route = routes[path]
  if (route && req.method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch {
      json(res, 400, anthropicStyle ? anthropicError('Invalid JSON body', 'invalid_request_error') : { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } })
      return
    }
    await route(body)
    return
  }

  json(res, 404, { error: { message: `No route for ${req.method} ${url.pathname}` } })
}

export async function startLocalServer(): Promise<LocalServerStatus> {
  if (server) return status
  const port = store.getSettings().localServer.port || 1337

  return new Promise((resolve) => {
    const next = createServer((req, res) => {
      void handle(req, res).catch((error) => {
        if (!res.headersSent) json(res, 500, { error: { message: String(error) } })
        else res.end()
      })
    })

    const fail = (error: Error): void => {
      server = null
      setOwnServerPort(null)
      publish({ running: false, port, url: null, error: error.message })
      resolve(status)
    }
    next.on('error', fail)

    // Claimed before listening: at launch local discovery runs alongside this,
    // and a probe that passed the check could still land here once we listen.
    setOwnServerPort(port)
    try {
      // Loopback only — this proxies the user's API keys.
      next.listen(port, '127.0.0.1', () => {
        server = next
        publish({ running: true, port, url: `http://127.0.0.1:${port}` })
        resolve(status)
      })
    } catch (error) {
      // A port out of range throws here rather than emitting 'error'.
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export async function stopLocalServer(): Promise<LocalServerStatus> {
  const port = status.port
  if (!server) {
    publish({ running: false, port, url: null })
    return status
  }
  const closing = server
  server = null
  setOwnServerPort(null)
  const closed = new Promise<void>((resolve) => closing.close(() => resolve()))
  // close() waits for open connections; a client mid-stream (or holding a
  // keep-alive socket) would keep Stop Server spinning. Its run is aborted
  // by the response's close handler.
  closing.closeAllConnections()
  await closed
  publish({ running: false, port, url: null })
  return status
}
