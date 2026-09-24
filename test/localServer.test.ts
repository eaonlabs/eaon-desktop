import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startLocalServer, stopLocalServer } from '../src/main/localServer'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { chunk, sseServer } from './helpers'

/**
 * The Local API Server proxies other apps' OpenAI-style requests through the
 * agent loop with `rawSystem` — their system prompt verbatim and no tools.
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
