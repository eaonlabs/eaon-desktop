import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import type { StreamEvent } from '@shared/types'

/**
 * Plan mode against a real local model (opt-in, EAON_LIVE=1): does a small
 * model actually research read-only and hand over a plan?
 */
const MODEL = process.env.EAON_LIVE_MODEL ?? 'nemotron-3-nano:4b'

test('plan mode with a real model researches and presents a plan', { skip: !process.env.EAON_LIVE, timeout: 300_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-plan-'))
  writeFileSync(join(cwd, 'app.py'), 'def add(a, b):\n    return a - b\n\nprint(add(2, 3))\n')
  const events: StreamEvent[] = []
  const outcome = await runAgent(
    {
      chatId: 'plan-live',
      messageId: `m${Date.now()}`,
      providerId: 'ollama',
      modelId: MODEL,
      effort: 'medium',
      mode: 'work',
      history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'app.py prints the wrong answer. Plan a fix.' }] }],
      summary: null,
      projectInstructions: '',
      cwd,
      work: { swarm: false, plan: true },
      goal: null
    },
    (e) => events.push(e),
    { approver: async () => false }
  )
  const calls = events.filter((e) => e.type === 'tool-call').map((e) => (e as { name: string }).name)
  console.log('calls:', calls.join(', '), '| plan:', JSON.stringify(events.find((e) => e.type === 'plan')), '| error:', outcome.error)
  assert.equal(outcome.error, undefined)
  assert.ok(!calls.includes('write_file') && !calls.includes('edit_file'))
})
