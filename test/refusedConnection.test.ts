import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import { removeProvider, updateProvider } from '../src/main/providers'
import type { StreamEvent } from '@shared/types'

/**
 * A server of the user's own on this computer that isn't running refuses the
 * connection. That's said at once, not after "The provider is busy" and
 * three retries (about 22 seconds).
 */

const id = 'refused-test'
const free = createServer()
await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve))
const port = (free.address() as AddressInfo).port
await new Promise<void>((resolve) => free.close(() => resolve()))
updateProvider(id, { name: 'My server', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1` })
after(() => removeProvider(id))

test('a refused connection to a server on this computer fails at once, without "busy" retries', async () => {
  const events: StreamEvent[] = []
  const started = Date.now()
  const outcome = await runAgent(
    {
      chatId: 'refused',
      messageId: `m${Date.now()}`,
      providerId: id,
      modelId: 'any-model',
      effort: 'medium',
      mode: 'chat',
      history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'hello' }] }],
      summary: null,
      projectInstructions: '',
      cwd: null,
      work: { swarm: false, plan: false },
      goal: null
    },
    (e) => events.push(e),
    { approver: async () => true }
  )
  assert.ok(Date.now() - started < 1500, `answered in ${Date.now() - started} ms`)
  const said = JSON.stringify(events)
  assert.doesNotMatch(said, /busy|retrying in/i)
  assert.ok(outcome.error || events.some((e) => e.type === 'error'), 'the turn ends with an error')
  assert.match(said, /refused|reach|connect/i)
})
