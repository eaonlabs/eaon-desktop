import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { startLocalServer, stopLocalServer } from '../src/main/localServer'
import { getProvider, testProvider } from '../src/main/providers'
import { refreshLocalProviders } from '../src/main/providers/localDiscovery'
import { isOwnServerUrl } from '../src/main/providers/compat'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { chunk, sseServer } from './helpers'

/**
 * The Local API Server proxies other apps' requests to the provider adapters:
 * their system prompt verbatim, and only the tools they send (see
 * gateway.test.ts for tools and the other wire formats).
 */
test('local API server proxies chat completions, streaming and not', async () => {
  const upstream = await sseServer(() => [chunk({ content: 'Hello' }), chunk({ content: ' there' }, 'stop')])
  store.saveProviderConfig({
    fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: upstream.url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] }
  })
  secrets.set('fake', 'key')
  store.patchSettings({ localServer: { port: 47299 } })
  const status = await startLocalServer()
  assert.equal(status.running, true)

  const plain = await fetch(`${status.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }] })
  })
  const body = (await plain.json()) as { choices: { message: { content: string } }[] }
  assert.equal(body.choices[0].message.content, 'Hello there')

  const upstreamBody = upstream.requests[0] as { messages: { role: string; content: string }[]; tools?: unknown }
  assert.equal(upstreamBody.messages[0].content, 'Be brief.', 'system prompt passed through verbatim')
  assert.equal(upstreamBody.tools, undefined, 'no tools offered to proxied requests')

  const streamed = await fetch(`${status.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'fake-model', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  })
  const text = await streamed.text()
  assert.match(text, /"content":"Hello"/)
  assert.match(text, /data: \[DONE\]/)

  await stopLocalServer()
  upstream.server.close()
})

/* Everything below points the other local runtimes away so discovery only sees Jan. */
const quietLocals = { ollama: { enabled: false }, 'lm-studio': { enabled: false }, 'llama-cpp': { enabled: false }, mlx: { enabled: false }, vllm: { enabled: false } }

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (piece: string) => (text += piece))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  return check()
}

/** An upstream that sends one token and then never finishes, like a model mid-reply. */
async function stallingUpstream(): Promise<{ url: string; server: Server; closed: () => boolean }> {
  let closed = false
  const server = createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${chunk({ content: 'Hel' })}\n\n`)
    res.on('close', () => (closed = true))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, server, closed: () => closed }
}

test('Jan on the server’s own port is neither listed from it nor proxied back to it', async () => {
  // Jan's default port (1337) is also this server's. Discovery used to copy
  // every model the server offers into Jan, and Jan sorts before custom
  // providers, so a request for one of them was proxied to itself forever.
  const upstream = await sseServer(() => [chunk({ content: 'Hello' }), chunk({ content: ' there' }, 'stop')])
  const port = 47301
  store.saveProviderConfig({
    ...quietLocals,
    jan: { baseUrl: `http://127.0.0.1:${port}/v1` },
    fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: upstream.url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] }
  })
  secrets.set('fake', 'key')
  store.patchSettings({ localServer: { port } })
  const status = await startLocalServer()
  try {
    await refreshLocalProviders(true)
    assert.deepEqual(getProvider('jan')!.models, [], 'Jan must not mirror the server’s own list')
    const tested = await testProvider('jan')
    assert.equal(tested.ok, false)
    assert.match(tested.message, /Local API Server/)

    // A list mirrored by an earlier build (saved whole, as `models`) is dropped, and never routed to.
    const config = store.getProviderConfig()
    store.saveProviderConfig({ ...config, jan: { ...config.jan, models: [{ id: 'fake-model', label: 'Fake', providerId: 'jan' }] } })
    const reply = await fetch(`${status.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(5000)
    })
    assert.equal(((await reply.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content, 'Hello there')
    assert.equal(upstream.requests.length, 1)
    assert.equal(await refreshLocalProviders(true), true)
    assert.deepEqual(getProvider('jan')!.models, [])
  } finally {
    await stopLocalServer()
    upstream.server.close()
  }
})

test('a client that disconnects stops the run upstream', async () => {
  const upstream = await stallingUpstream()
  store.saveProviderConfig({ ...quietLocals, slow: { name: 'Slow', kind: 'openai-compatible', baseUrl: upstream.url, models: [{ id: 'slow-model', label: 'Slow', providerId: 'slow' }] } })
  secrets.set('slow', 'key')
  store.patchSettings({ localServer: { port: 47302 } })
  const status = await startLocalServer()
  try {
    const controller = new AbortController()
    const response = await fetch(`${status.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'slow-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal
    })
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    assert.equal(await until(upstream.closed), true, 'the upstream request is cancelled when the client goes away')
  } finally {
    upstream.server.closeAllConnections()
    upstream.server.close()
    await stopLocalServer()
  }
})

test('stopping the server does not wait for a reply that is still streaming', async () => {
  const upstream = await stallingUpstream()
  store.saveProviderConfig({ ...quietLocals, slow: { name: 'Slow', kind: 'openai-compatible', baseUrl: upstream.url, models: [{ id: 'slow-model', label: 'Slow', providerId: 'slow' }] } })
  secrets.set('slow', 'key')
  store.patchSettings({ localServer: { port: 47303 } })
  const status = await startLocalServer()
  try {
    const response = await fetch(`${status.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'slow-model', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    })
    const reader = response.body!.getReader()
    await reader.read()
    let stopped = false
    void stopLocalServer().then(() => (stopped = true))
    assert.equal(await until(() => stopped), true, 'Stop Server returns while a client is mid-stream')
    assert.equal(await until(upstream.closed), true)
    await reader.cancel().catch(() => {})
  } finally {
    upstream.server.closeAllConnections()
    upstream.server.close()
    await stopLocalServer()
  }
})

test('web pages from other origins, and DNS-rebound hosts, cannot use the server', async () => {
  const upstream = await sseServer(() => [chunk({ content: 'ok' }, 'stop')])
  store.saveProviderConfig({ ...quietLocals, fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: upstream.url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] } })
  secrets.set('fake', 'key')
  store.patchSettings({ localServer: { port: 47304 } })
  const status = await startLocalServer()
  const body = { model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] }
  try {
    const evil = await post(`${status.url}/v1/chat/completions`, body, { Origin: 'https://evil.example' })
    assert.equal(evil.status, 403)
    assert.equal(evil.headers['access-control-allow-origin'], undefined)
    const sandboxed = await post(`${status.url}/v1/chat/completions`, body, { Origin: 'null' })
    assert.equal(sandboxed.status, 403)
    const rebound = await post(`${status.url}/v1/chat/completions`, body, { Host: `attacker.example:47304` })
    assert.equal(rebound.status, 403)
    assert.equal(upstream.requests.length, 0, 'nothing reached the provider')

    const local = await post(`${status.url}/v1/chat/completions`, body, { Origin: 'http://localhost:5173' })
    assert.equal(local.status, 200)
    assert.equal(local.headers['access-control-allow-origin'], 'http://localhost:5173')
    const desktopApp = await post(`${status.url}/v1/chat/completions`, body, { Origin: 'app://obsidian.md' })
    assert.equal(desktopApp.status, 200)
    const cli = await post(`${status.url}/v1/chat/completions`, body)
    assert.equal(cli.status, 200)
    // Docker Desktop tools reach loopback servers as host.docker.internal.
    const docker = await post(`${status.url}/v1/chat/completions`, body, { Host: 'host.docker.internal:47304' })
    assert.equal(docker.status, 200)
  } finally {
    await stopLocalServer()
    upstream.server.close()
  }
})

test('content parts and the developer role are read as text and images, not JSON', async () => {
  const upstream = await sseServer(() => [chunk({ content: 'ok' }, 'stop')])
  store.saveProviderConfig({ ...quietLocals, fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: upstream.url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] } })
  secrets.set('fake', 'key')
  store.patchSettings({ localServer: { port: 47305 } })
  const status = await startLocalServer()
  try {
    const reply = await post(`${status.url}/v1/chat/completions`, {
      model: 'fake-model',
      messages: [
        { role: 'developer', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
      ]
    })
    assert.equal(reply.status, 200)
    const sent = upstream.requests[0] as { messages: { role: string; content: unknown }[] }
    assert.deepEqual(sent.messages[0], { role: 'system', content: 'Be brief.' })
    assert.equal(sent.messages[1].role, 'user')
    const parts = sent.messages[1].content as { type: string; text?: string; image_url?: { url: string } }[]
    assert.equal(parts.find((p) => p.type === 'text')?.text, 'What is this?')
    assert.equal(parts.find((p) => p.type === 'image_url')?.image_url?.url, 'data:image/png;base64,AAAA', 'the image is passed on')
  } finally {
    await stopLocalServer()
    upstream.server.close()
  }
})

test('discovery started alongside the server at launch does not list the server', async () => {
  // index.ts starts the server and discovery back to back; the port used to
  // be claimed only once listening, after discovery had already checked it.
  const upstream = await sseServer(() => [chunk({ content: 'ok' }, 'stop')])
  const port = 47306
  store.saveProviderConfig({
    ...quietLocals,
    jan: { baseUrl: `http://127.0.0.1:${port}/v1` },
    fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: upstream.url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] }
  })
  secrets.set('fake', 'key')
  store.patchSettings({ localServer: { port } })
  const starting = startLocalServer()
  const discovering = refreshLocalProviders(true)
  try {
    await Promise.all([starting, discovering])
    assert.deepEqual(getProvider('jan')!.models, [])
  } finally {
    await stopLocalServer()
    upstream.server.close()
  }
})

test('a port out of range is reported as a failed start, not thrown', async () => {
  // listen() throws synchronously for it; at launch (`void startLocalServer()`)
  // that was an unhandled rejection, and the settings page showed nothing.
  store.patchSettings({ localServer: { port: 70000 } })
  const status = await startLocalServer()
  assert.equal(status.running, false)
  assert.match(status.error ?? '', /port/i)
  assert.equal(isOwnServerUrl('http://127.0.0.1:70000/v1'), false)
})
