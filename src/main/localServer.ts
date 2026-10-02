import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { hostname } from 'node:os'
import type { LocalServerStatus, StreamEvent } from '@shared/types'
import type { ChatMessage } from '@shared/types'
import { listProviders } from './providers'
import { isLoopbackHost, isOwnServerUrl, setOwnServerPort } from './providers/compat'
import { runAgent } from './agent/loop'
import { store } from './store'

/**
 * An OpenAI-compatible HTTP server so other tools on this machine can talk to
 * whichever provider the app is configured with. Requests are translated into
 * the same runStream() path the chat UI uses, so BYOK keys, fallback keys and
 * provider routing all apply identically.
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

/** OpenAI message content: a string, or parts of which the text is kept (images are not proxied). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

/** Resolve a model id to the provider that serves it. */
function resolveModel(modelId: string | undefined): { providerId: string; modelId: string } | null {
  // Never route to a provider that points back at this server.
  const providers = listProviders().filter((p) => p.enabled && (p.hasKey || p.local) && !isOwnServerUrl(p.baseUrl))
  if (modelId) {
    for (const provider of providers) {
      const match = provider.models.find((m) => m.id === modelId)
      if (match) return { providerId: provider.id, modelId: match.id }
    }
  }
  const fallback = store.getSettings().localServer.defaultModelId
  if (fallback && fallback !== modelId) return resolveModel(fallback)
  const first = providers.flatMap((p) => p.models)[0]
  return first ? { providerId: first.providerId, modelId: first.id } : null
}

const OPENAPI_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Eaon Local API', version: '1.0.0', description: 'OpenAI-compatible local endpoint.' },
  paths: {
    '/v1/models': {
      get: {
        summary: 'List available models',
        responses: { '200': { description: 'A list of models currently reachable with your configured keys.' } }
      }
    },
    '/v1/chat/completions': {
      post: {
        summary: 'Create a chat completion',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['messages'],
                properties: {
                  model: { type: 'string' },
                  stream: { type: 'boolean' },
                  messages: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { role: { type: 'string' }, content: { type: 'string' } }
                    }
                  }
                }
              }
            }
          }
        },
        responses: { '200': { description: 'A completion, or an SSE stream when stream=true.' } }
      }
    }
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
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
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

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    const models = listProviders()
      .filter((p) => p.enabled && (p.hasKey || p.local) && !isOwnServerUrl(p.baseUrl))
      .flatMap((p) => p.models)
      .map((m) => ({ id: m.id, object: 'model', owned_by: m.providerId }))
    json(res, 200, { object: 'list', data: models })
    return
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch {
      json(res, 400, { error: { message: 'Invalid JSON body' } })
      return
    }

    const messages = (body.messages ?? []) as { role: string; content: unknown }[]
    if (!Array.isArray(messages) || messages.length === 0 || !messages.every((m) => m && typeof m === 'object')) {
      json(res, 400, { error: { message: '`messages` is required' } })
      return
    }

    const resolved = resolveModel(body.model as string | undefined)
    if (!resolved) {
      json(res, 400, { error: { message: 'No model available. Add an API key in Settings → Model providers.' } })
      return
    }

    const settings = store.getSettings()
    // Newer OpenAI clients send the system prompt as `developer`.
    const isSystem = (m: { role: string }): boolean => m.role === 'system' || m.role === 'developer'
    const system = messages
      .filter(isSystem)
      .map((m) => contentText(m.content))
      .join('\n\n')
    const history: ChatMessage[] = messages
      .filter((m) => !isSystem(m))
      .map((m, index) => ({
        id: `m${index}`,
        role: m.role === 'assistant' ? 'assistant' : 'user',
        parts: [{ type: 'text', text: contentText(m.content) }],
        createdAt: 0
      }))

    const wantsStream = body.stream === true
    const id = `chatcmpl-${Math.random().toString(36).slice(2)}`
    const created = Math.floor(Date.now() / 1000)

    if (wantsStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
    }

    let full = ''
    let failed: string | null = null
    // A client that hangs up (Ctrl-C in a CLI, a closed tab, Stop Server)
    // stops the run; otherwise the model keeps generating, and billing, for nobody.
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })

    await runAgent(
      {
        chatId: 'local-api',
        messageId: id,
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        effort: settings.effort,
        mode: 'chat',
        // Proxied verbatim: the caller's own system prompt, and no tools.
        rawSystem: system,
        history,
        summary: null,
        projectInstructions: '',
        cwd: null,
        work: { swarm: false, plan: false },
        goal: null
      },
      (event: StreamEvent) => {
        if (event.type === 'delta') {
          full += event.text
          if (wantsStream) {
            res.write(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model: resolved.modelId,
                choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }]
              })}\n\n`
            )
          }
        } else if (event.type === 'error') {
          failed = event.error
        }
      },
      { signal: controller.signal }
    )
    if (controller.signal.aborted) return

    if (wantsStream) {
      if (failed) {
        res.write(`data: ${JSON.stringify({ error: { message: failed } })}\n\n`)
      } else {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: resolved.modelId,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`
        )
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    if (failed) {
      json(res, 502, { error: { message: failed } })
      return
    }

    json(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: resolved.modelId,
      choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }]
    })
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
