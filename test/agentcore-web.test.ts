import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { htmlToText } from '../src/main/webSearch'
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

test('html becomes readable text: chrome and scripts go, structure and link targets stay', () => {
  const text = htmlToText(
    '<html><head><style>p{color:red}</style><script>if (a<b) go()</script></head><body>' +
      '<nav><a href="https://x.dev/home">Home</a></nav><h2 class="t">Title</h2><!-- note -->' +
      '<p>One &amp; <b>two</b></p><ul><li>first<li>second</ul><nav-bar>kept</nav-bar>' +
      '<p>See <a class="l" href="https://example.com/doc">the <i>docs</i></a>.</p><svg/>after<footer>bye</footer></body></html>'
  )
  assert.doesNotMatch(text, /color|go\(\)|Home|note|bye/)
  assert.match(text, /^## Title\n\s*One & two\s*\n/)
  assert.match(text, /\n- first\s*\n- second/)
  assert.match(text, /kept/, 'a custom element whose name starts with nav is not navigation')
  assert.match(text, /the docs \(https:\/\/example\.com\/doc\)/)
  assert.match(text, /after/, 'a self-closed svg does not swallow the rest of the page')
})

test('html that never closes its tags converts in linear time', () => {
  const pages = [
    '<svg>'.repeat(100_000),
    '<a'.repeat(250_000),
    '<h1'.repeat(150_000),
    '<!--'.repeat(120_000),
    '<br'.repeat(150_000),
    '<a href="http://x">y'.repeat(25_000),
    `<script>${'x'.repeat(500_000)}`
  ]
  for (const page of pages) {
    const started = performance.now()
    htmlToText(page)
    const took = performance.now() - started
    assert.ok(took < 500, `${page.slice(0, 20)}… took ${Math.round(took)}ms`)
  }
  assert.equal(htmlToText('<script>never closed'), 'never closed')
})
