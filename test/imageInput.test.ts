import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { isImageUnsupported, resetTextOnlyModels, runAgent } from '../src/main/agent/loop'
import { stripImages } from '../src/main/agent/context'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import type { NeutralMessage } from '../src/main/providers/adapters/types'
import type { StreamEvent, StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/**
 * A model that can't see images: the provider's refusal is recognised, the
 * images are taken out and the request asked again at once — and every later
 * request leaves them out from the start, since a worker's thread keeps its
 * screenshots forever.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

beforeEach(() => resetTextOnlyModels())

test('provider refusals of an image are recognised; other errors are not', () => {
  for (const message of [
    '404: No endpoints found that support image input',
    'Invalid content type. image_url is only supported by certain models.',
    'This model does not support image input',
    'Image input is not supported for this model',
    'vision is not supported by this model'
  ]) {
    assert.equal(isImageUnsupported(new Error(message)), true, message)
  }
  for (const message of ['429: rate limited', '401: invalid key', 'context length exceeded', 'No endpoints found matching your data policy']) {
    assert.equal(isImageUnsupported(new Error(message)), false, message)
  }
})

test('stripImages replaces screenshots and attachments with a note, leaving the rest', () => {
  const messages: NeutralMessage[] = [
    { role: 'user', text: 'look', images: [{ mime: 'image/png', data: PNG }] },
    { role: 'assistant', text: '', calls: [{ id: 'c', name: 'computer', input: {} }] },
    { role: 'tool', results: [{ id: 'c', name: 'computer', output: 'Screenshot of display 0', images: [{ mime: 'image/png', data: PNG }] }] }
  ]
  const original = messages[2]
  assert.equal(stripImages(messages), true)
  assert.deepEqual(messages[0], { role: 'user', text: "look\n[an image was here; this model can't see images]" })
  const tool = messages[2] as Extract<NeutralMessage, { role: 'tool' }>
  assert.equal(tool.results[0].images, undefined)
  assert.match(tool.results[0].output, /Screenshot of display 0\n\[an image was here/)
  assert.ok((original as Extract<NeutralMessage, { role: 'tool' }>).results[0].images, 'the original message is untouched')
  assert.equal(stripImages(messages), false, 'nothing left to take out')
})

test('a model that refuses images is asked again without them, and later turns leave them out from the start', async () => {
  const bodies: string[] = []
  const { server, url } = await sseServer((body) => {
    const raw = JSON.stringify(body)
    bodies.push(raw)
    if (raw.includes('image_url')) return { status: 404, body: JSON.stringify({ error: { message: 'No endpoints found that support image input', code: 404 } }) }
    return [chunk({ content: 'Got it.' }, 'stop')]
  })
  store.saveProviderConfig({ fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, models: [{ id: 'text-only', label: 'Text Only', providerId: 'fake' }] } })
  secrets.set('fake', 'key')
  const shot = join(mkdtempSync(join(tmpdir(), 'eaon-png-')), 'shot.png')
  writeFileSync(shot, Buffer.from(PNG, 'base64'))
  const request = (): StreamRequest => ({
    chatId: 'img-chat',
    messageId: `m${Math.random()}`,
    providerId: 'fake',
    modelId: 'text-only',
    effort: 'medium',
    mode: 'work',
    history: [
      { id: 'u0', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'open the site' }] },
      {
        id: 'a0',
        role: 'assistant',
        createdAt: 1,
        parts: [{ type: 'tool', id: 't0', name: 'ios_simulator', input: { action: 'screenshot' }, output: 'Screenshot of iPhone', status: 'done', images: [shot] }]
      },
      { id: 'u1', role: 'user', createdAt: 2, parts: [{ type: 'text', text: 'continue' }] }
    ],
    summary: null,
    projectInstructions: '',
    cwd: mkdtempSync(join(tmpdir(), 'eaon-img-')),
    work: { swarm: false, plan: false },
    goal: null
  })
  const events: StreamEvent[] = []
  await runAgent(request(), (e) => events.push(e), { approver: async () => true })
  assert.equal(bodies.length, 2, 'one refusal, then the same request without the image')
  assert.ok(bodies[0].includes('image_url'))
  assert.ok(!bodies[1].includes('image_url'))
  assert.match(bodies[1], /this model can't see images/)
  const said = events.filter((e): e is Extract<StreamEvent, { type: 'reasoning' }> => e.type === 'reasoning').map((e) => e.text).join('')
  assert.match(said, /Text Only can't see images, so they were left out/)
  assert.ok(!events.some((e) => e.type === 'error'), 'the turn did not fail')

  bodies.length = 0
  await runAgent(request(), () => {}, { approver: async () => true })
  assert.equal(bodies.length, 1, 'the next turn leaves the image out from the start')
  assert.ok(!bodies[0].includes('image_url'))
  server.close()
})
