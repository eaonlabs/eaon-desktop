import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Provider } from '@shared/types'
import { anthropicAdapter } from '../src/main/providers/adapters/anthropic'
import { ollamaAdapter } from '../src/main/providers/adapters/ollama'
import { openaiChatAdapter } from '../src/main/providers/adapters/openaiChat'
import { openaiResponsesAdapter } from '../src/main/providers/adapters/openaiResponses'
import { describeErrorBody, ProviderHttpError, type Adapter, type TurnRequest } from '../src/main/providers/adapters/types'
import { classifyProviderError, ProviderIssueError } from '../src/main/providers/errors'
import { redactSecrets } from '../src/main/providers/redact'
import { providerFetch, RedirectRefusedError } from '../src/main/providers/safeFetch'
import { STREAM_LIMITS } from '../src/main/providers/streamGuard'
import { getProvider, refreshModels, removeProvider, updateProvider } from '../src/main/providers'
import { secrets } from '../src/main/secrets'
import { provider } from './helpers'

/*
 * Provider requests carry the user's key, so: a redirect never takes it to
 * another origin, a provider echoing it back never puts it on screen or in
 * "Copy details", and a stream that keeps sending data, or goes quiet, ends.
 */

const KEY = 'sk-proj-SECRETSECRET0123456789'

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; server: Server; close: () => void }> {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    close: () => {
      server.closeAllConnections()
      server.close()
    }
  }
}

/** Two origins: `front` answers with `reply`, `elsewhere` records whatever reaches it. */
async function twoOrigins(reply: (elsewhere: string) => { status: number; location?: string; body?: string }): Promise<{
  front: string
  elsewhere: string
  hitElsewhere: () => { url: string; headers: IncomingMessage['headers'] }[]
  close: () => void
}> {
  const hits: { url: string; headers: IncomingMessage['headers'] }[] = []
  const elsewhere = await listen((req, res) => {
    req.resume()
    hits.push({ url: req.url ?? '', headers: req.headers })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'leaked' }] }))
  })
  const front = await listen((req, res) => {
    req.resume()
    const answer = reply(elsewhere.url)
    res.writeHead(answer.status, { 'Content-Type': 'application/json', ...(answer.location ? { Location: answer.location } : {}) })
    res.end(answer.body ?? '{}')
  })
  return { front: front.url, elsewhere: elsewhere.url, hitElsewhere: () => hits, close: () => (front.close(), elsewhere.close()) }
}

/* ------------------------------------------------------------ redirects */

test('redirect: a cross-origin redirect is refused before any key header reaches the other site', async () => {
  const o = await twoOrigins((elsewhere) => ({ status: 307, location: `${elsewhere}/v1/models` }))
  try {
    for (const header of ['x-api-key', 'api-key', 'x-goog-api-key', 'authorization']) {
      await assert.rejects(
        providerFetch(`${o.front}/v1/models`, { headers: { [header]: KEY } }),
        (error: unknown) => error instanceof RedirectRefusedError && /redirected the request to 127\.0\.0\.1:\d+/.test(error.message) && !error.message.includes(KEY),
        header
      )
    }
    assert.equal(o.hitElsewhere().length, 0, 'nothing reached the other origin')
    const issue = classifyProviderError(new RedirectRefusedError(`${o.front}/x`, `${o.elsewhere}/y`), provider({ id: 'x', name: 'Custom' }))
    assert.equal(issue.action, 'open-settings')
    assert.match(issue.message, /Check the base URL/)
  } finally {
    o.close()
  }
})

test('redirect: a same-origin move is followed with the headers; a body survives 307 but not a POST turned into a GET', async () => {
  const seen: { url: string; key: string | undefined; body: string }[] = []
  const server = await listen((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', key: req.headers['x-api-key'] as string | undefined, body })
      if (req.url === '/old') {
        res.writeHead(307, { Location: '/new' })
        return res.end()
      }
      if (req.url === '/gone') {
        res.writeHead(302, { Location: '/new' })
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  try {
    const moved = await providerFetch(`${server.url}/old`, { method: 'POST', headers: { 'x-api-key': KEY }, body: '{"hello":1}' })
    assert.equal(moved.status, 200)
    assert.deepEqual(seen.at(-1), { url: '/new', key: KEY, body: '{"hello":1}' })
    // A 302 on a POST would become a GET and lose the request: handed back as it is, never silently resent.
    const turned = await providerFetch(`${server.url}/gone`, { method: 'POST', headers: { 'x-api-key': KEY }, body: '{"hello":1}' })
    assert.equal(turned.status, 302)
    await turned.body?.cancel()
  } finally {
    server.close()
  }
})

test('redirect: every request path of a provider refuses to carry the key elsewhere — turns, listings and the Anthropic SDK', { timeout: 30_000 }, async () => {
  const o = await twoOrigins((elsewhere) => ({ status: 307, location: `${elsewhere}/v1/models` }))
  const request = (p: Provider): TurnRequest => ({
    provider: p,
    modelId: 'm',
    model: undefined,
    credentials: { apiKey: KEY },
    system: 's',
    messages: [{ role: 'user', text: 'hi' }],
    tools: [],
    effort: 'medium',
    signal: new AbortController().signal,
    cacheKey: 'c',
    agentic: false,
    onText: () => {},
    onReasoning: () => {}
  })
  const cases: [string, Adapter, Provider][] = [
    ['openai-chat', openaiChatAdapter, provider({ id: 'fake', name: 'Fake', baseUrl: `${o.front}/v1` })],
    ['openai-responses', openaiResponsesAdapter, provider({ id: 'fake', name: 'Fake', kind: 'openai-responses', baseUrl: `${o.front}/v1` })],
    ['anthropic', anthropicAdapter, provider({ id: 'fake', name: 'Fake', kind: 'anthropic', baseUrl: o.front })],
    ['ollama', ollamaAdapter, provider({ id: 'ollama', name: 'Ollama', kind: 'ollama', local: true, baseUrl: `${o.front}/v1` })]
  ]
  try {
    for (const [name, adapter, p] of cases) {
      const error = await adapter.turn(request(p)).then(
        () => null,
        (e: unknown) => e
      )
      assert.ok(error, `${name} fails`)
      // Whatever shape the failure takes, it names the redirect and never echoes the key.
      const text = `${(error as Error).message} ${String((error as { cause?: unknown }).cause ?? '')}`
      assert.match(text, /redirected/i, name)
      assert.ok(!text.includes(KEY), name)
    }
    for (const kind of ['openai-compatible', 'anthropic'] as const) {
      const id = `redir-${kind}`
      updateProvider(id, { name: 'Redirecting', kind, baseUrl: kind === 'anthropic' ? o.front : `${o.front}/v1` })
      secrets.set(id, KEY)
      try {
        await assert.rejects(refreshModels(id), (error: unknown) => error instanceof ProviderIssueError && /redirected/.test(error.issue.message) && error.issue.action === 'open-settings', kind)
      } finally {
        removeProvider(id)
      }
    }
    assert.equal(o.hitElsewhere().length, 0, 'the key never reached the other origin, on any path')
    assert.equal(getProvider('redir-anthropic'), undefined)
  } finally {
    o.close()
  }
})

/* ------------------------------------------------------------ redaction */

test('redaction: a provider echoing the key never puts it in an error, its details or a stream error', async () => {
  const scrubbed = redactSecrets(`Incorrect API key provided: ${KEY}.`)
  assert.match(scrubbed, /^Incorrect API key provided: .*redacted.*\.$/)
  assert.ok(!scrubbed.includes(KEY) && !scrubbed.includes(KEY.slice(8)), 'only a short prefix, which says which key it was, stays')
  assert.doesNotMatch(describeErrorBody(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } })), /SECRETSECRET/)
  assert.doesNotMatch(describeErrorBody(500, `upstream said Bearer abcdefghijklmnop1234 and ?key=AIzaSyA1234567890abcdefghijkl`), /abcdefghijklmnop1234|AIzaSy/)
  const echo = new ProviderHttpError(418, describeErrorBody(418, `teapot: ${KEY}`))
  const issue = classifyProviderError(echo, provider({ id: 'x', name: 'X' }))
  assert.equal(issue.kind, 'other')
  assert.doesNotMatch(`${issue.message} ${issue.detail ?? ''}`, /SECRETSECRET/)

  // Through a real adapter: the SDK's parsed body and the plain fetch body alike.
  const fake = await listen((req, res) => {
    req.resume()
    res.writeHead(418, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `teapot says ${KEY}`, type: 'invalid_request_error' } }))
  })
  try {
    for (const [adapter, p] of [
      [openaiChatAdapter, provider({ id: 'fake', name: 'Fake', baseUrl: `${fake.url}/v1` })],
      [anthropicAdapter, provider({ id: 'fake', name: 'Fake', kind: 'anthropic', baseUrl: fake.url })]
    ] as [Adapter, Provider][]) {
      const error = (await adapter
        .turn({ provider: p, modelId: 'm', model: undefined, credentials: { apiKey: KEY }, system: '', messages: [{ role: 'user', text: 'hi' }], tools: [], effort: 'medium', signal: new AbortController().signal, cacheKey: 'c', agentic: false, onText: () => {}, onReasoning: () => {} })
        .then(() => null, (e: unknown) => e)) as Error
      assert.ok(error)
      assert.doesNotMatch(error.message, /SECRETSECRET/, p.kind)
    }
  } finally {
    fake.close()
  }
})

/* ----------------------------------------------------- stream idle and total */

const request = (p: Provider, signal = new AbortController().signal): TurnRequest => ({
  provider: p,
  modelId: 'm',
  model: undefined,
  credentials: { apiKey: 'k' },
  system: 's',
  messages: [{ role: 'user', text: 'hi' }],
  tools: [],
  effort: 'medium',
  signal,
  cacheKey: 'c',
  agentic: false,
  onText: () => {},
  onReasoning: () => {}
})

const chatChunk = (content: string): string => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`

test('stream limits: a reply that keeps sending data ends at the total cap; one that goes quiet ends at the idle cap; Stop stays a cancellation', { timeout: 30_000 }, async () => {
  const saved = { ...STREAM_LIMITS }
  let mode: 'chatty' | 'quiet' = 'chatty'
  let open = 0
  const fake = await listen((req, res) => {
    req.resume()
    open++
    res.on('close', () => open--)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(chatChunk('Hel'))
    // Chatty: a token every few ms, forever. Quiet: one token, then nothing.
    if (mode === 'chatty') {
      const timer = setInterval(() => res.write(chatChunk('.')), 5)
      res.on('close', () => clearInterval(timer))
    }
  })
  const p = provider({ id: 'fake', name: 'Fake', baseUrl: `${fake.url}/v1` })
  const settled = async (): Promise<void> => {
    const deadline = Date.now() + 2000
    while (open > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    assert.equal(open, 0, 'the provider connection is closed')
  }
  try {
    Object.assign(STREAM_LIMITS, { idleMs: 60_000, totalMs: 400 })
    const started = Date.now()
    const chatty = (await openaiChatAdapter.turn(request(p)).then(() => null, (e: unknown) => e)) as Error
    assert.equal(chatty?.name, 'TimeoutError')
    assert.match(chatty.message, /Fake was still replying after .*, so the request was stopped/)
    assert.ok(Date.now() - started < 3000)
    assert.equal(classifyProviderError(chatty, p).kind, 'timeout')
    await settled()

    mode = 'quiet'
    Object.assign(STREAM_LIMITS, { idleMs: 300, totalMs: 60_000 })
    const quiet = (await openaiChatAdapter.turn(request(p)).then(() => null, (e: unknown) => e)) as Error
    assert.equal(quiet?.name, 'TimeoutError')
    assert.match(quiet.message, /Fake stopped sending data for/)
    await settled()

    // The user's Stop is still a cancellation, not a timeout.
    Object.assign(STREAM_LIMITS, { idleMs: 60_000, totalMs: 60_000 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const stopped = (await openaiChatAdapter.turn(request(p, controller.signal)).then(() => null, (e: unknown) => e)) as Error
    assert.ok(stopped)
    assert.notEqual(stopped.name, 'TimeoutError')
    await settled()
  } finally {
    Object.assign(STREAM_LIMITS, saved)
    fake.close()
  }
})

test('stream limits: a reply that is still arriving is left alone', { timeout: 15_000 }, async () => {
  const saved = { ...STREAM_LIMITS }
  const fake = await listen((req, res) => {
    req.resume()
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    let n = 0
    const timer = setInterval(() => {
      res.write(chatChunk(`w${n++} `))
      if (n === 8) {
        clearInterval(timer)
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
        res.end()
      }
    }, 60)
  })
  try {
    // Chunks come faster than the idle cap and the whole reply fits the total.
    Object.assign(STREAM_LIMITS, { idleMs: 400, totalMs: 5000 })
    const result = await openaiChatAdapter.turn(request(provider({ id: 'fake', name: 'Fake', baseUrl: `${fake.url}/v1` })))
    assert.equal(result.stop, 'end')
    assert.match(result.text, /w7/)
  } finally {
    Object.assign(STREAM_LIMITS, saved)
    fake.close()
  }
})
