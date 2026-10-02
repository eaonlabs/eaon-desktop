import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import { estimateTokens } from '../src/main/agent/context'
import { chatSystemPrompt, workSystemPrompt } from '../src/main/agent/prompts'
import { guidanceFor, toolsFor, toSpec, type ToolQuery } from '../src/main/agent/tools'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import type { StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/**
 * Token budgets, measured rather than assumed. The fixed cost of every
 * request (system prompt + tool schemas) is what each model round pays before
 * any conversation, so a regression here multiplies across every turn. The
 * numbers print with the test run; the asserts are the ceilings.
 */

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    chatId: 'tb',
    messageId: `m${Math.random()}`,
    providerId: 'fake',
    modelId: 'fake-model',
    effort: 'medium',
    mode: 'work',
    history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'go' }] }],
    summary: null,
    projectInstructions: '',
    cwd: mkdtempSync(join(tmpdir(), 'eaon-tb-')),
    work: { swarm: false, plan: false },
    goal: null,
    ...overrides
  }
}

function overhead(req: StreamRequest): { system: number; tools: number; names: string[] } {
  const settings = store.getSettings()
  const query: ToolQuery = { mode: req.mode, cwd: req.cwd, depth: 0, readOnly: req.work.plan, settings, request: req }
  const tools = toolsFor(query)
  const system =
    req.mode === 'chat'
      ? chatSystemPrompt('', tools.some((t) => t.name === 'web_search'))
      : workSystemPrompt({ cwd: req.cwd!, projectInstructions: '', guidance: guidanceFor(query), swarm: req.work.swarm, plan: req.work.plan, goal: req.goal })
  return { system: estimateTokens(system), tools: estimateTokens(JSON.stringify(tools.map(toSpec))), names: tools.map((t) => t.name) }
}

test('fixed per-request overhead stays inside its budget, per mode', () => {
  const rows = {
    chat: overhead(request({ mode: 'chat', cwd: null })),
    work: overhead(request()),
    plan: overhead(request({ work: { swarm: false, plan: true } })),
    swarm: overhead(request({ work: { swarm: true, plan: false } }))
  }
  for (const [mode, row] of Object.entries(rows)) {
    console.log(`overhead ${mode}: system ≈${row.system} + tools ≈${row.tools} = ≈${row.system + row.tools} tokens (${row.names.length} tools)`)
  }
  // Chat is the lean product: one tool, a short prompt.
  assert.deepEqual(rows.chat.names, ['web_search'])
  assert.ok(rows.chat.system + rows.chat.tools < 1_200, 'chat overhead')
  // Plan mode withholds write tools, so it must cost less than Work.
  assert.ok(rows.plan.tools < rows.work.tools)
  assert.ok(rows.work.system + rows.work.tools < 9_000, 'work overhead')
  assert.ok(rows.swarm.system + rows.swarm.tools < 10_000, 'swarm overhead')
})

test('A/B: an unchanged re-read costs a pointer, not a second copy', async () => {
  // Same script both times: read big.txt, read it again, answer. In A the
  // file is unchanged between reads (dedupe applies); in B a tool touches it
  // in between, so the second read is genuinely new and sent in full.
  const body = Array.from({ length: 400 }, (_, i) => `line ${i}: ${'x'.repeat(40)}`).join('\n')
  const run = async (touch: boolean): Promise<number> => {
    const req = request()
    writeFileSync(join(req.cwd!, 'big.txt'), body)
    let index = 0
    let lastBody = ''
    const server = await sseServer((b) => {
      lastBody = JSON.stringify(b)
      const i = index++
      const call = (name: string, args: Record<string, unknown>) => [
        chunk({ tool_calls: [{ index: 0, id: `c${i}`, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
      ]
      if (i === 0) return call('read_file', { path: 'big.txt' })
      if (i === 1 && touch) return call('write_file', { path: 'other.txt', content: 'x' })
      if (i === (touch ? 2 : 1)) return call('read_file', { path: 'big.txt' })
      return [chunk({ content: 'done' }, 'stop')]
    })
    store.saveProviderConfig({ fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: server.url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] } })
    secrets.set('fake', 'key')
    await runAgent(req, () => {}, { approver: async () => true })
    server.server.close()
    return estimateTokens(lastBody)
  }
  const deduped = await run(false)
  const full = await run(true)
  const saved = full - deduped
  console.log(`re-read A/B: final request ≈${deduped} tokens with dedupe vs ≈${full} without (${saved} saved, ${Math.round((saved / full) * 100)}%)`)
  // The file alone is ≈4.6k tokens; nearly all of the second copy is saved.
  assert.ok(saved > 3_500, `saved ${saved}`)
})
