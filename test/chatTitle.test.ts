import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cleanTitle, writeChatTitle } from '../src/main/agent/chatTitle'
import { removeProvider, updateProvider } from '../src/main/providers'
import { secrets } from '../src/main/secrets'

/**
 * A new chat is named by the model it runs on (main/agent/chatTitle.ts): one
 * short request with no tools, whose answer becomes the sidebar's name. A
 * stand-in provider on this computer answers here.
 */

const bodies: Array<Record<string, unknown>> = []
let answer = 'Fix the login redirect'
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    bodies.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
    if (answer === 'FAIL') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'down' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const id = 'title-test'
updateProvider(id, { name: 'Title test', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` })
secrets.set(id, 'sk-title-test')
after(() => {
  server.close()
  removeProvider(id)
})

test('the chat’s own model names it from the first message and reply, with no tools', async () => {
  bodies.length = 0
  answer = 'Fix the login redirect'
  const title = await writeChatTitle({ providerId: id, modelId: 'stand-in', message: 'the login page sends me back to /home after signing in, why?', reply: 'The redirect reads a stale cookie.' })
  assert.equal(title, 'Fix the login redirect')
  assert.equal(bodies.length, 1)
  const body = bodies[0] as { model: string; tools?: unknown[]; messages: Array<{ role: string; content: unknown }> }
  assert.equal(body.model, 'stand-in')
  assert.ok(!body.tools || body.tools.length === 0)
  const sent = JSON.stringify(body.messages)
  assert.match(sent, /login page sends me back/)
  assert.match(sent, /stale cookie/)
})

test('what the model adds around a title is taken off', async () => {
  answer = 'Title: "Planning a trip to Kyoto."'
  assert.equal(await writeChatTitle({ providerId: id, modelId: 'stand-in', message: 'help me plan 5 days in kyoto', reply: '' }), 'Planning a trip to Kyoto')
  assert.equal(cleanTitle('<think>they want a name</think>\n**Weekly budget sheet**'), 'Weekly budget sheet')
  assert.equal(cleanTitle('## Rust lifetimes explained\nSecond line'), 'Rust lifetimes explained')
  assert.equal(cleanTitle('“Résumé review”'), 'Résumé review')
  assert.equal(cleanTitle('   \n  '), null)
  assert.equal(cleanTitle('x'.repeat(80))?.length, 60)
})

test('a failed request, an unknown provider or an empty message leaves the name as it is', async () => {
  answer = 'FAIL'
  assert.equal(await writeChatTitle({ providerId: id, modelId: 'stand-in', message: 'hello', reply: '' }), null)
  assert.equal(await writeChatTitle({ providerId: 'no-such-provider', modelId: 'x', message: 'hello', reply: '' }), null)
  assert.equal(await writeChatTitle({ providerId: id, modelId: 'stand-in', message: '   ', reply: '' }), null)
})
