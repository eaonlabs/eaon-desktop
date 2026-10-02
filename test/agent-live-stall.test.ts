import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import type { StreamEvent } from '@shared/types'

/**
 * The prompt that stalled a 4B model in the app: its first call fails (the
 * folder does not exist yet) and it used to end the turn with an empty reply.
 */
const MODEL = process.env.EAON_LIVE_MODEL ?? 'nemotron-3-nano:4b'

test('a small model recovers after a failed first tool call', { skip: !process.env.EAON_LIVE, timeout: 300_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-stall-'))
  const events: StreamEvent[] = []
  const outcome = await runAgent(
    {
      chatId: 'stall',
      messageId: `m${Date.now()}`,
      providerId: 'ollama',
      modelId: MODEL,
      effort: 'medium',
      mode: 'work',
      history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'Make a folder called notes with a file todo.md listing three groceries, then show me the file.' }] }],
      summary: null,
      projectInstructions: '',
      cwd,
      work: { swarm: false, plan: false },
      goal: null
    },
    (e) => events.push(e),
    { approver: async () => true }
  )
  const calls = events.filter((e) => e.type === 'tool-call').map((e) => `${(e as { name: string }).name}(${JSON.stringify((e as { input: Record<string, unknown> }).input).slice(0, 120)})`)
  console.log('results:', JSON.stringify(events.filter((e) => e.type === 'tool-result').map((e) => (e as { output: string }).output.slice(0, 150))))
  console.log('calls:', calls.join(', '), '| text:', JSON.stringify(outcome.text.slice(0, 200)), '| reasoning chars:', events.filter((e) => e.type === 'reasoning').map((e) => (e as { text: string }).text).join('').length)
  assert.ok(existsSync(join(cwd, 'notes', 'todo.md')), 'todo.md written')
  assert.ok(readFileSync(join(cwd, 'notes', 'todo.md'), 'utf8').length > 0)
})
