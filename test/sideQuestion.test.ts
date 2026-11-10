import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { askSideQuestion } from '../src/main/agent/sideQuestion'
import { removeProvider, updateProvider } from '../src/main/providers'
import { secrets } from '../src/main/secrets'
import { SIDE_SYSTEM, answerAsQuote, parseSideQuestion, sideContext, sideQuestionPrompt, type SideQuestionRequest } from '../src/shared/sideQuestion'
import type { ChatMessage } from '../src/shared/types'

/**
 * A side question ("/btw …", shared/sideQuestion.ts, main/agent/sideQuestion.ts):
 * one request with the conversation as text and no tools. A stand-in provider
 * on this computer answers here; nothing reaches a real model.
 */

test('"/btw" with something after it is a side question; nothing else is', () => {
  assert.equal(parseSideQuestion('/btw what does --force do?'), 'what does --force do?')
  assert.equal(parseSideQuestion('  /BTW   why\nthe second line'), 'why\nthe second line')
  assert.equal(parseSideQuestion('/btw'), '', 'asked nothing yet')
  assert.equal(parseSideQuestion('/btw   '), '')
  assert.equal(parseSideQuestion('/btwx hello'), null, 'another word')
  assert.equal(parseSideQuestion('please /btw this'), null, 'only at the start')
  assert.equal(parseSideQuestion('what is /btw'), null)
})

test('the model gets the conversation as text, then the question', () => {
  assert.equal(sideQuestionPrompt('USER: hi', ' why? '), 'The conversation so far:\n\nUSER: hi\n\n---\nThe side question:\nwhy?')
  assert.match(sideQuestionPrompt('  ', 'why?'), /\(Nothing has been said in the conversation yet\.\)/)
  assert.match(SIDE_SYSTEM, /no tools/)
  assert.match(SIDE_SYSTEM, /not added to the conversation/)
})

test('"Add to message" quotes the question and the answer', () => {
  assert.equal(answerAsQuote('What is x?', 'It is y.\n\nMore.'), '> Side question: What is x?\n>\n> It is y.\n>\n> More.\n\n')
})

test('the chat goes along as it stands, less system notes, empty messages and what a summary covers', () => {
  const msg = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({ id, role, parts: text ? [{ type: 'text', text }] : [], createdAt: 1 })
  const chat = { messages: [msg('a', 'user', 'one'), msg('b', 'assistant', 'two'), msg('s', 'system', 'note'), msg('c', 'user', 'three'), msg('d', 'assistant', '')], summary: null }
  assert.deepEqual(sideContext(chat).history.map((m) => m.id), ['a', 'b', 'c'])
  const summarized = sideContext({ ...chat, summary: { text: 'Earlier: one and two.', throughMessageId: 'b' } })
  assert.deepEqual(summarized.history.map((m) => m.id), ['c'])
  assert.equal(summarized.summary, 'Earlier: one and two.')
  assert.deepEqual(sideContext(null), { history: [], summary: null })
})

/* ---------------------------------------------------------------- the model */

const bodies: Array<Record<string, unknown>> = []
let mode: 'ok' | 'fail' = 'ok'
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    bodies.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
    if (mode === 'fail') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'the model is down' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const content of ['It ran ', '`npm test`.']) {
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)
    }
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const id = 'side-question-test'
updateProvider(id, { name: 'Side test', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` })
secrets.set(id, 'sk-side-test')
after(() => {
  server.close()
  removeProvider(id)
})

const said = (text: string): ChatMessage['parts'] => [{ type: 'text', text }]
const history: ChatMessage[] = [
  { id: 'u1', role: 'user', parts: said('Run the tests and fix what fails'), createdAt: 1 },
  {
    id: 'a1',
    role: 'assistant',
    createdAt: 2,
    parts: [
      ...said('Running them now.'),
      { type: 'tool', id: 't1', name: 'run_command', input: { command: 'npm test' }, output: '2 passing', status: 'done' }
    ]
  },
  { id: 'a2', role: 'assistant', createdAt: 3, parts: [{ type: 'tool', id: 't2', name: 'run_command', input: { command: 'npm run lint' }, output: null, status: 'running' }] }
]
const request = (extra: Partial<SideQuestionRequest> = {}): SideQuestionRequest => ({ id: 'q1', providerId: id, modelId: 'stand-in', question: 'what command did it run?', history, summary: null, ...extra })

test('it answers from the conversation, streams the words, sends no tools, and puts nothing in the chat', async () => {
  bodies.length = 0
  const streamed: string[] = []
  const result = await askSideQuestion(request(), (delta) => streamed.push(delta), new AbortController().signal)
  assert.deepEqual(result, { ok: true, text: 'It ran `npm test`.' })
  assert.equal(streamed.join(''), 'It ran `npm test`.')
  assert.equal(bodies.length, 1)
  const body = bodies[0] as { model: string; tools?: unknown[]; messages: Array<{ role: string; content: unknown }> }
  assert.equal(body.model, 'stand-in')
  assert.ok(!body.tools || body.tools.length === 0, 'no tools: it can’t change anything')
  const sent = JSON.stringify(body.messages)
  assert.match(sent, /side question/i)
  assert.match(sent, /Run the tests and fix what fails/)
  assert.match(sent, /npm test/, 'what the reply being written has done so far counts')
  assert.match(sent, /what command did it run\?/)
  assert.equal(history.length, 3, 'the stored chat is untouched')
})

test('a compaction summary stands in for the messages it covers', async () => {
  bodies.length = 0
  await askSideQuestion(request({ summary: 'The user wants the tests fixed; the build was set up with pnpm.' }), () => {}, new AbortController().signal)
  assert.match(JSON.stringify(bodies[0].messages), /build was set up with pnpm/)
})

test('an empty question, an unknown provider, a failing model and a stop each say so', async () => {
  const signal = new AbortController().signal
  assert.deepEqual(await askSideQuestion(request({ question: '   ' }), () => {}, signal), { ok: false, error: 'Ask something after /btw.' })
  const gone = await askSideQuestion(request({ providerId: 'no-such-provider' }), () => {}, signal)
  assert.equal(gone.ok, false)
  mode = 'fail'
  const failed = await askSideQuestion(request(), () => {}, signal)
  assert.equal(failed.ok, false)
  assert.match((failed as { error: string }).error, /down|500/)
  mode = 'ok'
  const stopper = new AbortController()
  stopper.abort()
  assert.deepEqual(await askSideQuestion(request(), () => {}, stopper.signal), { ok: false, error: 'Stopped.' })
})
