import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import { getProvider, refreshModels } from '../src/main/providers'
import { LOCAL_CONTEXT } from '../src/main/providers/models'
import type { StreamEvent, StreamRequest } from '@shared/types'

/**
 * Opt-in (EAON_LIVE=1): the native Ollama path end to end — model list from
 * /api/tags + /api/show, then a thinking-enabled chat through /api/chat.
 *
 *   EAON_LIVE=1 npm run test:main -- ollama-live
 */

async function ollamaUp(): Promise<string[]> {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) })
    return ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? []
  } catch {
    return []
  }
}

test('the Ollama list carries capabilities and a context no larger than num_ctx', { skip: !process.env.EAON_LIVE, timeout: 60_000 }, async (t) => {
  const installed = await ollamaUp()
  if (installed.length === 0) return t.skip('Ollama not running')
  const models = await refreshModels('ollama')
  assert.ok(models.length > 0)
  // Embedding and image models are not chat models.
  assert.ok(!models.some((m) => /embed/.test(m.id)), 'embedding model listed')
  for (const model of models) {
    if (!/[:-]cloud$/.test(model.id)) assert.ok((model.contextWindow ?? 0) <= LOCAL_CONTEXT, `${model.id} window ${model.contextWindow}`)
  }
  const oss = models.find((m) => m.id.startsWith('gpt-oss'))
  if (oss) {
    assert.equal(oss.reasoning, true)
    assert.equal(oss.tools, true)
    assert.deepEqual(oss.efforts, ['light', 'medium', 'high'])
  }
  console.log(models.map((m) => `${m.id} ctx=${m.contextWindow} tools=${m.tools} think=${m.reasoning} vision=${m.vision ?? false}`).join('\n'))
})

for (const MODEL of (process.env.EAON_LIVE_MODELS ?? 'gpt-oss:20b,gemma4:e2b').split(',')) {
  test(`${MODEL}: thinking and a tool call through /api/chat`, { skip: !process.env.EAON_LIVE, timeout: 240_000 }, async (t) => {
    if (!(await ollamaUp()).includes(MODEL)) return t.skip(`${MODEL} not installed`)
    await refreshModels('ollama')
    assert.ok(getProvider('ollama')!.models.some((m) => m.id === MODEL))
    const events: StreamEvent[] = []
    const request: StreamRequest = {
      chatId: 'live-ollama',
      messageId: `m${Date.now()}`,
      providerId: 'ollama',
      modelId: MODEL,
      effort: 'light',
      mode: 'work',
      history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'Use the list_dir tool on "." and then tell me how many entries you saw.' }] }],
      summary: null,
      projectInstructions: '',
      cwd: null,
      work: { swarm: false, plan: false },
      goal: null
    }
    const outcome = await runAgent(request, (event) => events.push(event), { approver: async () => true })
    const tools = events.filter((e) => e.type === 'tool-call').map((e) => (e as { name: string }).name)
    const reasoning = events.filter((e) => e.type === 'reasoning').length
    console.log(`${MODEL}: tools=${tools.join(',')} reasoningEvents=${reasoning} usage=${JSON.stringify(outcome.usage)} error=${outcome.error}`)
    assert.equal(outcome.error, undefined)
    assert.ok(tools.length > 0, 'no tool was called')
    assert.ok(outcome.text.trim().length > 0, 'no answer text')
  })
}
