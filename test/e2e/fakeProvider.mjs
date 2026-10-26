/**
 * A fake OpenAI-compatible model server for the end-to-end suite.
 *
 * It serves `GET /v1/models` and streaming `POST /v1/chat/completions`, and
 * each test decides what a request gets with `fake.route(fn)`: a streamed
 * text, a stream held open until the test releases it, a tool call, an HTTP
 * error, malformed SSE, or a connection dropped mid-stream. Eaon reaches it
 * through the keyless LM Studio provider (see `useFakeModel` in fixtures.mjs),
 * so no key, keychain or real model is involved.
 */
import { createServer } from 'node:http'
import { scaled } from './timing.mjs'

const MODEL_RESPONSE_BASE = { object: 'chat.completion.chunk', created: 0 }

/**
 * What a route returns. Build them with the helpers on `reply`.
 * @typedef {{ kind: 'text', chunks: string[], delayMs: number, usage?: { input: number, output: number } }
 *   | { kind: 'hold', first: string, label: string }
 *   | { kind: 'tool', name: string, args: Record<string, unknown>, text: string }
 *   | { kind: 'status', status: number, message: string, headers: Record<string, string> }
 *   | { kind: 'malformed' }
 *   | { kind: 'drop', first: string }
 *   | { kind: 'hang' }} Reply
 */

/**
 * What a route is given about the request.
 * @typedef {{
 *   index: number,
 *   body: any,
 *   model: string,
 *   messages: any[],
 *   lastUser: string,
 *   system: string,
 *   tools: string[],
 *   toolResultsSinceUser: number,
 *   worker: string | null
 * }} ChatRequest
 */

export const reply = {
  /**
   * A streamed reply, split into a few chunks; with `usage`, a last chunk
   * reports the tokens it took, as a provider does when asked.
   * @param {string} text
   * @param {{ delayMs?: number, usage?: { input: number, output: number } }} [options]
   */
  text: (text, { delayMs = 15, usage } = {}) => /** @type {Reply} */ ({ kind: 'text', chunks: splitChunks(text), delayMs, ...(usage ? { usage } : {}) }),
  /**
   * Sends `first`, then keeps the stream open until the test calls
   * `finish()` on the handle from `fake.nextHeld()`. `label` names it in
   * failure messages and lets a test pick its own stream.
   */
  hold: (first = 'Working on it', label = '') => /** @type {Reply} */ ({ kind: 'hold', first, label }),
  /** One tool call, optionally after some text. */
  tool: (name, args, text = '') => /** @type {Reply} */ ({ kind: 'tool', name, args, text }),
  /**
   * An HTTP error with an OpenAI-style JSON body. Pass `retry-after-ms` in
   * `headers` to keep Eaon's backoff for 429 and 5xx short in a test.
   */
  status: (status, message = 'fake error', headers = {}) => /** @type {Reply} */ ({ kind: 'status', status, message, headers }),
  /** A 200 event stream whose events are not JSON, then the end. */
  malformed: () => /** @type {Reply} */ ({ kind: 'malformed' }),
  /** Some text, then the socket is destroyed without a finish. */
  drop: (first = 'Partial') => /** @type {Reply} */ ({ kind: 'drop', first }),
  /** Accepts the request and never answers. */
  hang: () => /** @type {Reply} */ ({ kind: 'hang' })
}

function splitChunks(text) {
  const words = text.split(/(?<= )/)
  const chunks = []
  for (let i = 0; i < words.length; i += 3) chunks.push(words.slice(i, i + 3).join(''))
  return chunks.length ? chunks : ['']
}

/** Text of a message's content, whether a string or content parts. */
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('')
  return ''
}

/** @param {any} body @param {number} index @returns {ChatRequest} */
function describe(body, index) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const system = messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => contentText(m.content)).join('\n')
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i
      break
    }
  }
  const lastUser = lastUserIndex === -1 ? '' : contentText(messages[lastUserIndex].content)
  const toolResultsSinceUser = messages.slice(lastUserIndex + 1).filter((m) => m.role === 'tool').length
  const worker = /You are ([\w-]+), one of the user's Eaon Workers/.exec(system)?.[1] ?? null
  const tools = Array.isArray(body?.tools) ? body.tools.map((t) => t?.function?.name ?? t?.name).filter(Boolean) : []
  return { index, body, model: String(body?.model ?? ''), messages, lastUser, system, tools, toolResultsSinceUser, worker }
}

/**
 * A stream the test holds open.
 * @typedef {{
 *   label: string,
 *   request: ChatRequest,
 *   open: boolean,
 *   aborted: boolean,
 *   closed: Promise<void>,
 *   write: (text: string) => void,
 *   finish: (text?: string) => void
 * }} HeldStream
 */

/**
 * @param {{ models?: string[] }} [options]
 */
export async function startFakeProvider({ models = ['fake-model'] } = {}) {
  /** @type {(req: ChatRequest) => Reply} */
  let route = () => reply.text('Hello from the fake model.')
  /** @type {ChatRequest[]} */
  const chats = []
  /**
   * The app's requests to name a new chat (src/main/agent/chatTitle.ts), kept
   * out of `chats` so a test's last chat request is still the conversation's.
   * Answered with `titleReply`: nothing by default, so a chat keeps its first
   * message as its name, as scenarios that find it by that name expect.
   * @type {ChatRequest[]}
   */
  const titles = []
  let titleReply = ''
  /** @type {{ method: string, url: string }[]} */
  const requests = []
  /** @type {HeldStream[]} */
  const held = []
  /** @type {Set<(stream: HeldStream) => void>} */
  const heldWaiters = new Set()
  /** @type {Set<() => void>} */
  const requestWaiters = new Set()
  const sockets = new Set()
  let modelList = models
  /** Event codes it accepts, as Eaon's gateway would (Eaon Event): the code, and what it gives. */
  /** @type {Map<string, { name: string, endsAt: number, limits: { requestsPerDay: number, tokensPerDay: number, requestsPerMinute: number } }>} */
  const codes = new Map()

  const chunk = (model, delta, finish = null) =>
    `data: ${JSON.stringify({ ...MODEL_RESPONSE_BASE, id: 'fake', model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

  const server = createServer(async (req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' })
    const parts = []
    for await (const part of req) parts.push(part)
    if (req.method === 'GET' && /\/models\/?(\?.*)?$/.test(req.url ?? '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // A model can come with a name, as Eaon's gateway gives its models one.
      res.end(JSON.stringify({ object: 'list', data: modelList.map((m) => (typeof m === 'string' ? { id: m, object: 'model', owned_by: 'fake' } : { object: 'model', owned_by: 'fake', ...m })) }))
      return
    }
    if (req.method === 'POST' && /\/codes\/redeem\/?$/.test(req.url ?? '')) {
      let asked = ''
      try {
        asked = String(JSON.parse(Buffer.concat(parts).toString() || '{}').code ?? '')
      } catch {
        asked = ''
      }
      const code = codes.get(asked)
      res.writeHead(code ? 200 : 404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(code ? { code } : { error: { message: "That code isn't valid. Check it and try again.", code: 'invalid_code' } }))
      return
    }
    if (req.method !== 'POST' || !/\/chat\/completions\/?$/.test(req.url ?? '')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `The fake provider has no ${req.method} ${req.url}` } }))
      return
    }
    let body
    try {
      body = JSON.parse(Buffer.concat(parts).toString() || '{}')
    } catch {
      body = {}
    }
    const request = describe(body, chats.length)
    const naming = request.system.startsWith('You name conversations')
    if (naming) titles.push(request)
    else {
      chats.push(request)
      for (const wake of requestWaiters) wake()
    }
    let answer
    try {
      answer = naming ? reply.text(titleReply) : route(request)
    } catch (error) {
      answer = reply.status(500, `The fake provider's route threw: ${error instanceof Error ? error.message : error}`)
    }
    const model = request.model || (typeof modelList[0] === 'string' ? modelList[0] : modelList[0]?.id)
    switch (answer.kind) {
      case 'status': {
        res.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers })
        res.end(JSON.stringify({ error: { message: answer.message, type: 'fake_error', code: answer.status } }))
        return
      }
      case 'hang':
        // The socket stays open until the client gives up or the server closes.
        return
      case 'malformed': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {this is not json\n\n')
        res.write('data: <<<garbage>>>\n\n')
        res.end()
        return
      }
      case 'drop': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(model, { role: 'assistant', content: answer.first }))
        setTimeout(() => res.socket?.destroy(), 50)
        return
      }
      case 'tool': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (answer.text) res.write(chunk(model, { role: 'assistant', content: answer.text }))
        res.write(
          chunk(model, {
            role: 'assistant',
            tool_calls: [{ index: 0, id: `call_${request.index}`, type: 'function', function: { name: answer.name, arguments: JSON.stringify(answer.args) } }]
          })
        )
        res.write(chunk(model, {}, 'tool_calls'))
        res.end('data: [DONE]\n\n')
        return
      }
      case 'text': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const piece of answer.chunks) {
          if (res.destroyed) return
          res.write(chunk(model, { role: 'assistant', content: piece }))
          if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs))
        }
        res.write(chunk(model, {}, 'stop'))
        if (answer.usage) {
          const usage = { prompt_tokens: answer.usage.input, completion_tokens: answer.usage.output, total_tokens: answer.usage.input + answer.usage.output }
          res.write(`data: ${JSON.stringify({ ...MODEL_RESPONSE_BASE, id: 'fake', model, choices: [], usage })}\n\n`)
        }
        res.end('data: [DONE]\n\n')
        return
      }
      case 'hold': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(model, { role: 'assistant', content: answer.first }))
        /** @type {() => void} */
        let markClosed = () => {}
        /** @type {HeldStream} */
        const stream = {
          label: answer.label,
          request,
          open: true,
          aborted: false,
          closed: new Promise((resolve) => (markClosed = resolve)),
          write(text) {
            if (stream.open) res.write(chunk(model, { content: text }))
          },
          finish(text = '') {
            if (!stream.open) return
            if (text) res.write(chunk(model, { content: text }))
            res.write(chunk(model, {}, 'stop'))
            res.end('data: [DONE]\n\n')
            stream.open = false
            markClosed()
          }
        }
        // The client going away (Stop, a quit, a crash) closes the response early.
        res.on('close', () => {
          if (!stream.open) return
          stream.open = false
          stream.aborted = true
          markClosed()
        })
        held.push(stream)
        for (const wake of heldWaiters) wake(stream)
        return
      }
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    /** Every chat completion request, oldest first, but for the ones naming a chat. */
    chats,
    /** The requests naming a new chat, oldest first. */
    titles,
    /** What a request to name a chat gets back: '' (the default) leaves the chat's name alone. */
    nameChats(title) {
      titleReply = title
    },
    /** Every HTTP request (method and URL), including model listings. */
    requests,
    /** Held streams, oldest first. */
    held,
    /** @param {(req: ChatRequest) => Reply} fn */
    route(fn) {
      route = fn
    },
    /** @param {(string | { id: string, name?: string, description?: string })[]} ids */
    setModels(ids) {
      modelList = ids
    },
    /** An event code it accepts at /codes/redeem, as Eaon's gateway would. */
    addCode(token, code) {
      codes.set(token, code)
    },
    /**
     * Resolves with the next held stream that matches (one already open counts).
     * @param {(stream: HeldStream) => boolean} [match]
     */
    nextHeld(match = () => true, timeout = 20_000) {
      timeout = scaled(timeout)
      const existing = held.find((s) => s.open && !s.taken && match(s))
      if (existing) {
        existing.taken = true
        return Promise.resolve(existing)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          heldWaiters.delete(wake)
          reject(new Error(`the fake provider got no held stream within ${timeout} ms (${chats.length} chat requests so far)`))
        }, timeout)
        const wake = (stream) => {
          if (stream.taken || !match(stream)) return
          stream.taken = true
          clearTimeout(timer)
          heldWaiters.delete(wake)
          resolve(stream)
        }
        heldWaiters.add(wake)
      })
    },
    /**
     * Resolves once `count` chat requests have arrived in total.
     */
    waitForChats(count, timeout = 20_000) {
      timeout = scaled(timeout)
      if (chats.length >= count) return Promise.resolve(chats[count - 1])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          requestWaiters.delete(wake)
          reject(new Error(`the fake provider expected ${count} chat requests within ${timeout} ms, got ${chats.length}`))
        }, timeout)
        const wake = () => {
          if (chats.length < count) return
          clearTimeout(timer)
          requestWaiters.delete(wake)
          resolve(chats[count - 1])
        }
        requestWaiters.add(wake)
      })
    },
    async close() {
      for (const stream of held) if (stream.open) stream.finish()
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    }
  }
}

/** @typedef {Awaited<ReturnType<typeof startFakeProvider>>} FakeProvider */
