import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import { workSystemPrompt } from '../src/main/agent/prompts'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import type { StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/** Ask, Plan and Agent: Ask answers from the project and can't change it; it is told so, and the tools say no. */

const request = (cwd: string, work: { plan: boolean; ask?: boolean }): StreamRequest =>
  ({ chatId: 'ask-e2e', messageId: `m${Math.random()}`, providerId: 'fake', modelId: 'fake-model', effort: 'medium', mode: 'work', history: [], summary: null, projectInstructions: '', cwd, work: { swarm: false, ...work }, goal: null }) as StreamRequest

const call = (name: string, args: Record<string, unknown>): string[] => [chunk({ tool_calls: [{ index: 0, id: `c_${name}`, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')]
const say = (text: string): string[] => [chunk({ content: text }, 'stop')]
type Body = { messages: { role: string; content?: unknown }[] }

const base = { cwd: '/tmp/x', projectInstructions: '', guidance: [], swarm: false, goal: null }

test('the prompt says which mode the agent is in: Ask answers and changes nothing, Plan presents a plan, Agent does neither', () => {
  const ask = workSystemPrompt({ ...base, plan: false, ask: true })
  assert.match(ask, /ASK MODE is on/)
  assert.match(ask, /Do not write a plan, do not call present_plan/)
  assert.doesNotMatch(ask, /PLAN MODE is on/)
  const plan = workSystemPrompt({ ...base, plan: true })
  assert.match(plan, /PLAN MODE is on/)
  assert.doesNotMatch(plan, /ASK MODE/)
  assert.doesNotMatch(workSystemPrompt({ ...base, plan: true, ask: true }), /ASK MODE/, 'Plan wins when both are somehow on')
  const agent = workSystemPrompt({ ...base, plan: false })
  assert.doesNotMatch(agent, /ASK MODE|PLAN MODE/)
})

test('in Ask mode a file write is refused and nothing is created, and the model can still answer', { timeout: 30_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-ask-'))
  store.patchSettings({ approvalMode: 'full' } as never)
  let round = 0
  const { url, server, requests } = await sseServer(() => (++round === 1 ? call('write_file', { path: 'oops.txt', content: 'x' }) : say('It does not write files in Ask mode.')))
  store.saveProviderConfig({ fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] } })
  secrets.set('fake', 'key')
  try {
    await runAgent(request(cwd, { plan: false, ask: true }), () => {}, { approver: async () => true })
  } finally {
    server.close()
    store.patchSettings({ approvalMode: 'ask' } as never)
  }
  assert.equal(existsSync(join(cwd, 'oops.txt')), false, 'even with full access, Ask changes nothing')
  const first = requests[0] as unknown as Body
  assert.match(JSON.stringify(first.messages[0]), /ASK MODE is on/)
  const tools = (requests[1] as unknown as Body).messages.filter((m) => m.role === 'tool')
  assert.match(String(tools[tools.length - 1].content), /Unknown tool "write_file"/, 'the tool that writes is not even offered')
  const offered = (first as unknown as { tools?: { function: { name: string } }[] }).tools?.map((t) => t.function.name) ?? []
  assert.ok(offered.includes('read_file') && !offered.includes('write_file') && !offered.includes('present_plan'), offered.join(','))
})

test('in Agent mode the same write goes through', { timeout: 30_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-agent-'))
  store.patchSettings({ approvalMode: 'full' } as never)
  let round = 0
  const { url, server } = await sseServer(() => (++round === 1 ? call('write_file', { path: 'made.txt', content: 'x' }) : say('done')))
  store.saveProviderConfig({ fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] } })
  secrets.set('fake', 'key')
  try {
    await runAgent(request(cwd, { plan: false }), () => {}, { approver: async () => true })
  } finally {
    server.close()
    store.patchSettings({ approvalMode: 'ask' } as never)
  }
  assert.equal(existsSync(join(cwd, 'made.txt')), true)
})
