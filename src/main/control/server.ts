import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { gatewayToken } from '../gateway/models'
import { toolInfo, type ControlTool } from './tools'

/**
 * Eaon's control API over HTTP, mounted by the Local API Server:
 *
 *   /control/mcp                  MCP (streamable HTTP, stateless) — what Eaon CLI connects to
 *   GET  /control/v1/tools        the tools, as plain JSON
 *   POST /control/v1/tools/<name> run one with a JSON body of arguments
 *
 * This can change the app, so unlike the model routes it never answers
 * without this install's key: a request with none, or another one, is refused.
 * The server is loopback-only and checks Host and Origin before it gets here.
 */

let tools: ControlTool[] = []

export function setControlTools(next: ControlTool[]): void {
  tools = next
}

export const CONTROL_PREFIX = '/control'

/** The key the caller sent, as `Authorization: Bearer` or `x-api-key`. */
function sentKey(req: IncomingMessage): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim()
  const apiKey = Array.isArray(req.headers['x-api-key']) ? req.headers['x-api-key'][0] : req.headers['x-api-key']
  return bearer || apiKey?.trim() || ''
}

export function authorised(req: IncomingMessage): boolean {
  const sent = Buffer.from(sentKey(req))
  const key = Buffer.from(gatewayToken())
  return sent.length === key.length && timingSafeEqual(sent, key)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 1_000_000) throw new Error('Request too large')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : undefined
}

const asArgs = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

async function call(name: string, args: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; error: string; status: number }> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) return { ok: false, error: `No tool "${name}".`, status: 404 }
  try {
    return { ok: true, result: await tool.run(args) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), status: 400 }
  }
}

/** One MCP server per request: stateless, so there is no session to lose when Eaon restarts. */
function mcpServer(): Server {
  const server = new Server({ name: 'eaon', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'Controls the Eaon desktop app: models, the ADE, workers and chats.' })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => {
      const info = toolInfo(tool)
      return {
        name: info.name,
        description: info.description,
        inputSchema: info.input as { type: 'object' },
        annotations: { readOnlyHint: info.risk === 'read', destructiveHint: info.risk === 'danger', openWorldHint: false }
      }
    })
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const outcome = await call(request.params.name, asArgs(request.params.arguments))
    if (!outcome.ok) return { isError: true, content: [{ type: 'text' as const, text: outcome.error }] }
    return { content: [{ type: 'text' as const, text: JSON.stringify(outcome.result ?? { done: true }, null, 2) }] }
  })
  return server
}

/**
 * Answers a `/control/*` request. Returns false for any other path, so the
 * caller carries on with its own routes.
 */
export async function handleControl(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== CONTROL_PREFIX && !pathname.startsWith(`${CONTROL_PREFIX}/`)) return false
  if (!authorised(req)) {
    json(res, 401, { error: { message: 'The control API needs this Eaon’s key: Eaon → Settings → Local API Server.' } })
    return true
  }
  const path = pathname.replace(/\/+$/, '')

  if (path === `${CONTROL_PREFIX}/mcp`) {
    if (req.method !== 'POST') {
      // Stateless: no standalone event stream to open, no session to end.
      res.setHeader('Allow', 'POST')
      json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
      return true
    }
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
      return true
    }
    const server = mcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
    return true
  }

  if (path === `${CONTROL_PREFIX}/v1/tools` && req.method === 'GET') {
    json(res, 200, { tools: tools.map(toolInfo) })
    return true
  }

  const named = /^\/control\/v1\/tools\/([a-z0-9_]+)$/.exec(path)
  if (named && req.method === 'POST') {
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      json(res, 400, { error: { message: 'Invalid JSON body' } })
      return true
    }
    const outcome = await call(named[1], asArgs(body))
    if (outcome.ok) json(res, 200, { result: outcome.result ?? null })
    else json(res, outcome.status, { error: { message: outcome.error } })
    return true
  }

  json(res, 404, { error: { message: `No route for ${req.method} ${pathname}` } })
  return true
}
