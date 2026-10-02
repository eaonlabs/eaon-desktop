import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { goalBudgetExceeded, runAgent, timeLeft } from '../src/main/agent/loop'
import { workSystemPrompt } from '../src/main/agent/prompts'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import type { StreamEvent, StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/**
 * Full autonomy (approvals set to `full`) and goals with an end time, against
 * a scripted provider. Full autonomy must run risky commands without asking
 * and still stop at the ones that can't be undone; an end time must replace
 * the continuation and minute caps without dropping the token budget, and
 * offer `wait` instead of a tight loop.
 */

type Body = { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }

const toolCall = (name: string, args: Record<string, unknown>, id = `c_${name}`): string[] => [
  chunk({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
]
const say = (text: string): string[] => [chunk({ content: text }, 'stop')]
const toolNames = (body: Body): string[] => (body.tools ?? []).map((t) => t.function.name)

async function setup(handler: (body: Body, index: number) => string[]) {
  let index = 0
  const server = await sseServer((body) => handler(body as unknown as Body, index++))
  store.saveProviderConfig({
    fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: server.url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] }
  })
  secrets.set('fake', 'key')
  return server
}

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    chatId: 'c1',
    messageId: `m${Math.random()}`,
    providerId: 'fake',
    modelId: 'fake-model',
    effort: 'medium',
    mode: 'work',
    history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'do the thing' }] }],
    summary: null,
    projectInstructions: '',
    cwd: mkdtempSync(join(tmpdir(), 'eaon-autonomy-')),
    work: { swarm: false, plan: false },
    goal: null,
    ...overrides
  }
}

before(() => store.patchSettings({ approvalMode: 'full' }))
after(() => store.patchSettings({ approvalMode: 'ask' }))

test('full autonomy runs ordinary and risky commands without asking, and still asks before sudo', async () => {
  const { server } = await setup((_body, i) =>
    i === 0
      ? toolCall('run_command', { command: 'echo made > made.txt' }, 'c1')
      : i === 1
        ? toolCall('run_command', { command: 'rm -rf ./build-output' }, 'c2')
        : i === 2
          ? toolCall('run_command', { command: 'sudo rm -rf /tmp/x' }, 'c3')
          : say('Done.')
  )
  const asked: string[] = []
  const events: StreamEvent[] = []
  await runAgent(request(), (e) => events.push(e), {
    approver: async (tool, input) => {
      asked.push(String(input.command ?? tool))
      return false
    }
  })
  server.close()
  assert.deepEqual(asked, ['sudo rm -rf /tmp/x'], 'only the catastrophic command waited for the user')
  const results = events.filter((e) => e.type === 'tool-result') as Extract<StreamEvent, { type: 'tool-result' }>[]
  assert.deepEqual(
    results.map((r) => r.status),
    ['done', 'done', 'denied']
  )
})

test('the system prompt tells the agent it may act without asking only under full autonomy', () => {
  const base = { cwd: '/tmp', projectInstructions: '', guidance: [], swarm: false, plan: false, goal: null }
  assert.match(workSystemPrompt({ ...base, autonomy: true }), /Full autonomy is on/)
  assert.doesNotMatch(workSystemPrompt({ ...base, autonomy: false }), /Full autonomy is on/)
  const until = new Date(2026, 9, 1, 17, 0).getTime()
  assert.match(workSystemPrompt({ ...base, goal: { text: 'x', status: 'active', iterations: 0, until } }), /until .*5:00 PM.*call wait/s)
})

test('a goal with an end time ignores the continuation and minute caps but keeps the token budget', () => {
  const settings = store.getSettings()
  const capped = { ...settings, work: { ...settings.work, goalMaxMinutes: 60, goalMaxTokens: 1000 } }
  const usage = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 })
  const until = 10 * 60 * 60_000
  assert.equal(goalBudgetExceeded(capped, 0, usage(10), 3 * 60 * 60_000, until), null, 'three hours in, still before the end time')
  assert.match(goalBudgetExceeded(capped, 0, usage(10), until, until) ?? '', /end time/)
  assert.match(goalBudgetExceeded(capped, 0, usage(5000), 60_000, until) ?? '', /token limit/)
  assert.equal(timeLeft(Date.now() + 130 * 60_000 + 1000), '2 h 10 min')
  assert.equal(timeLeft(Date.now() + 25 * 60_000 + 1000), '25 min')
})

test('a goal with an end time keeps going past the continuation cap, offers wait, and stops at the end time', async () => {
  store.patchSettings({ work: { goalMaxIterations: 1 } })
  const until = Date.now() + 2500
  const { server, requests } = await setup((_body, i) => (i < 3 ? say(`step ${i}`) : i === 3 ? toolCall('wait', { minutes: 5, reason: 'build' }) : say('waited')))
  const events: StreamEvent[] = []
  const started = Date.now()
  await runAgent(request({ goal: { text: 'keep at it', status: 'active', iterations: 0, until } }), (e) => events.push(e))
  server.close()
  store.patchSettings({ work: { goalMaxIterations: 8 } })
  assert.ok(requests.length >= 4, `continued past the cap of 1 (${requests.length} requests)`)
  assert.ok(toolNames(requests[0] as unknown as Body).includes('wait'), 'wait is offered')
  const nudge = (requests[1] as unknown as Body).messages.at(-1)
  assert.match(String(nudge?.content), /you have \d+ min left/)
  // wait never runs past the end time: five minutes asked, about two seconds left.
  assert.ok(Date.now() - started < 10_000, 'wait stopped at the end time')
  const last = events.filter((e) => e.type === 'goal').at(-1) as Extract<StreamEvent, { type: 'goal' }>
  assert.equal(last.goal.status, 'paused')
  assert.match(last.goal.summary ?? '', /end time/)
})

test('an ordinary goal does not get wait', async () => {
  const { server, requests } = await setup(() => toolCall('goal_complete', { summary: 'ok' }))
  await runAgent(request({ goal: { text: 'x', status: 'active', iterations: 0 } }), () => {})
  server.close()
  assert.ok(!toolNames(requests[0] as unknown as Body).includes('wait'))
})
