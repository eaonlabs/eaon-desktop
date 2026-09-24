import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Provider } from '@shared/types'

/** A throwaway HTTP server that answers every request with `handler`'s SSE lines. */
export async function sseServer(
  handler: (body: Record<string, unknown>, req: IncomingMessage) => string[] | { status: number; body: string }
): Promise<{ url: string; server: Server; requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {}
    requests.push(body)
    const reply = handler(body, req)
    if (!Array.isArray(reply)) {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' })
      res.end(reply.body)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const line of reply) res.write(`data: ${line}\n\n`)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/v1`, server, requests }
}

export function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'test',
    name: 'Test',
    kind: 'openai-compatible',
    baseUrl: '',
    hasKey: true,
    enabled: true,
    models: [],
    builtIn: false,
    local: false,
    fallbackCount: 0,
    ...overrides
  }
}

export const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })
