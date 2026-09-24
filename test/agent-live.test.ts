import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import type { StreamEvent, StreamRequest } from '@shared/types'

/**
 * End-to-end: the real loop, real tools and a real model through Ollama.
 * Opt-in (EAON_LIVE=1) and skipped when Ollama is not running, since it needs
 * a local model and takes tens of seconds.
 */
const MODEL = process.env.EAON_LIVE_MODEL ?? 'nemotron-3-nano:4b'

async function ollamaUp(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) })
    const body = (await res.json()) as { models?: { name: string }[] }
    return Boolean(body.models?.some((m) => m.name === MODEL))
  } catch {
    return false
  }
}

function request(overrides: Partial<StreamRequest>): StreamRequest {
  return {
    chatId: 'live',
    messageId: `m${Date.now()}`,
    providerId: 'ollama',
    modelId: MODEL,
    effort: 'medium',
    mode: 'work',
    history: [],
    summary: null,
    projectInstructions: '',
    cwd: null,
    work: { swarm: false, plan: false },
    goal: null,
    ...overrides
  }
}

test('Work mode creates a real file with a local model', { skip: !process.env.EAON_LIVE, timeout: 240_000 }, async (t) => {
  if (!(await ollamaUp())) return t.skip(`Ollama or ${MODEL} not available`)
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-live-'))
  const events: StreamEvent[] = []
  const outcome = await runAgent(
    request({
      cwd,
      history: [
        {
          id: 'u1',
          role: 'user',
          createdAt: 0,
          parts: [{ type: 'text', text: 'Create a file named hello.txt in the work folder containing exactly: Hello from Eaon' }]
        }
      ]
    }),
    (event) => events.push(event),
    { approver: async () => true }
  )
  const calls = events.filter((e) => e.type === 'tool-call').map((e) => (e as { name: string }).name)
  console.log('tools called:', calls.join(', '), '| usage:', JSON.stringify(outcome.usage), '| error:', outcome.error)
  assert.equal(outcome.error, undefined)
  assert.ok(existsSync(join(cwd, 'hello.txt')), 'hello.txt was written')
  assert.match(readFileSync(join(cwd, 'hello.txt'), 'utf8'), /Hello from Eaon/)
  assert.ok(events.some((e) => e.type === 'done'))
})

test('Chat mode offers only web search', { skip: !process.env.EAON_LIVE, timeout: 120_000 }, async (t) => {
  if (!(await ollamaUp())) return t.skip(`Ollama or ${MODEL} not available`)
  const events: StreamEvent[] = []
  const outcome = await runAgent(
    request({
      mode: 'chat',
      history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'Reply with just the word pong.' }] }]
    }),
    (event) => events.push(event)
  )
  assert.equal(outcome.error, undefined)
  assert.match(outcome.text.toLowerCase(), /pong/)
  assert.ok(!events.some((e) => e.type === 'tool-call' && (e as { name: string }).name !== 'web_search'))
})
