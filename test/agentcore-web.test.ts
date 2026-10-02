import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import '../src/main/webSearch'
import { toolsFor, type ToolContext } from '../src/main/agent/tools'
import { store } from '../src/main/store'
import type { StreamRequest } from '@shared/types'

function webFetch(signal: AbortSignal) {
  const settings = store.getSettings()
  const request = { mode: 'work', work: { swarm: false, plan: false }, goal: null } as unknown as StreamRequest
  const tool = toolsFor({ mode: 'work', cwd: null, depth: 0, readOnly: false, settings, request }).find((t) => t.name === 'web_fetch')!
  const ctx = { cwd: '', settings, signal, progress: () => {} } as unknown as ToolContext
  return (url: string) => Promise.resolve(tool.run({ url }, ctx)).then(String)
}

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, server }
}

test('web_fetch stops downloading a huge page instead of buffering all of it', async () => {
  let sent = 0
  const { url, server } = await serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    const line = `${'x'.repeat(1023)}\n`
    const pump = (): void => {
      // Up to 200 MB, far more than a page read needs.
      while (sent < 200 * 1024 * 1024) {
        sent += line.length
        if (!res.write(line)) return void res.once('drain', pump)
      }
      res.end()
    }
    pump()
  })
  const out = await webFetch(new AbortController().signal)(url)
  server.closeAllConnections()
  server.close()
  assert.match(out, /more characters/)
  assert.ok(sent < 50 * 1024 * 1024, `server sent ${sent} bytes`)
})

test('web_fetch gives up when the turn is stopped', { timeout: 10_000 }, async () => {
  const { url, server } = await serve(() => {
    /* never answers */
  })
  const controller = new AbortController()
  const started = Date.now()
  setTimeout(() => controller.abort(), 100)
  await webFetch(controller.signal)(url).catch(() => 'stopped')
  server.closeAllConnections()
  server.close()
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`)
})
