import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { LocalServerStatus, StreamEvent } from '@shared/types'
import { listProviders, runStream } from './providers'
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
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

/** Resolve a model id to the provider that serves it. */
function resolveModel(modelId: string | undefined): { providerId: string; modelId: string } | null {
  const providers = listProviders().filter((p) => p.enabled && (p.hasKey || p.local))
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
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
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
      .filter((p) => p.enabled && (p.hasKey || p.local))
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

    const messages = (body.messages ?? []) as { role: string; content: string }[]
    if (!Array.isArray(messages) || messages.length === 0) {
      json(res, 400, { error: { message: '`messages` is required' } })
      return
    }

    const resolved = resolveModel(body.model as string | undefined)
    if (!resolved) {
      json(res, 400, { error: { message: 'No model available. Add an API key in Settings → Model providers.' } })
      return
    }

    const settings = store.getSettings()
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const wantsStream = body.stream === true
    const id = `chatcmpl-${Math.random().toString(36).slice(2)}`
    const created = Math.floor(Date.now() / 1000)

    if (wantsStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      })
    }

    let full = ''
    let failed: string | null = null

    await runStream(
      {
        chatId: 'local-api',
        messageId: id,
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        effort: settings.effort,
        system,
        messages: turns,
        cwd: null
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
      }
    )

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

    next.on('error', (error) => {
      server = null
      publish({ running: false, port, url: null, error: error.message })
      resolve(status)
    })

    // Loopback only — this proxies the user's API keys.
    next.listen(port, '127.0.0.1', () => {
      server = next
      publish({ running: true, port, url: `http://127.0.0.1:${port}` })
      resolve(status)
    })
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
  await new Promise<void>((resolve) => closing.close(() => resolve()))
  publish({ running: false, port, url: null })
  return status
}
