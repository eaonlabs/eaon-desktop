import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { announcesIntent, runAgent } from '../src/main/agent/loop'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import type { StreamEvent, StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/**
 * The agent loop against a scripted provider: every mode's control flow
 * (plan hand-off, goal continuation, swarm sub-agents, approvals, retries,
 * truncated output) without a model in the loop, so it is deterministic.
 */

type Body = { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }

const toolCall = (name: string, args: Record<string, unknown>, id = `c_${name}`): string[] => [
  chunk({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
]
const say = (text: string): string[] => [chunk({ content: text }, 'stop')]
const toolNames = (body: Body): string[] => (body.tools ?? []).map((t) => t.function.name)
// The sub-agent's own brief, which the lead agent's swarm prompt does not contain.
const isSubagent = (body: Body): boolean => String(body.messages[0]?.content ?? '').includes('report to the lead agent')

async function setup(handler: (body: Body, index: number) => string[] | { status: number; body: string }) {
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
    cwd: mkdtempSync(join(tmpdir(), 'eaon-loop-')),
    work: { swarm: false, plan: false },
    goal: null,
    ...overrides
  }
}

before(() => {
  store.patchSettings({ approvalMode: 'ask' })
})

test('plan mode withholds write tools, and present_plan ends the turn', async () => {
  const { server, requests } = await setup(() =>
    toolCall('present_plan', { title: 'Add login', summary: 'Adds a login page.', steps: ['Create login.tsx', 'Run tests'] })
  )
  const events: StreamEvent[] = []
  const outcome = await runAgent(request({ work: { swarm: false, plan: true } }), (e) => events.push(e))
  server.close()
  assert.equal(outcome.error, undefined)
  assert.equal(requests.length, 1, 'no request after the plan was presented')
  const tools = toolNames(requests[0] as unknown as Body)
  assert.ok(tools.includes('present_plan'))
  assert.ok(tools.includes('read_file') && tools.includes('run_command'))
  assert.ok(!tools.includes('write_file') && !tools.includes('edit_file') && !tools.includes('delete_file'))
  const plan = events.find((e) => e.type === 'plan') as Extract<StreamEvent, { type: 'plan' }>
  assert.deepEqual(plan.plan.steps, ['Create login.tsx', 'Run tests'])
})

test('goal mode sends the agent back until goal_complete', async () => {
  const { server, requests } = await setup((_body, i) =>
    i === 0 ? say('Started on it.') : i === 1 ? toolCall('goal_complete', { summary: 'Built and verified.' }) : say('All done.')
  )
  const events: StreamEvent[] = []
  const outcome = await runAgent(request({ goal: { text: 'ship it', status: 'active', iterations: 0 } }), (e) => events.push(e))
  server.close()
  assert.equal(outcome.error, undefined)
  assert.equal(requests.length, 3)
  const nudge = (requests[1] as unknown as Body).messages.at(-1)
  assert.match(String(nudge?.content), /Keep going toward the goal/)
  const goals = events.filter((e) => e.type === 'goal').map((e) => (e as Extract<StreamEvent, { type: 'goal' }>).goal)
  assert.deepEqual(goals.map((g) => g.status), ['active', 'achieved'])
  assert.equal(goals[1].summary, 'Built and verified.')
})

test('goal mode stops at its continuation limit instead of looping forever', async () => {
  store.patchSettings({ work: { goalMaxIterations: 2 } })
  const { server, requests } = await setup(() => say('still thinking'))
  const events: StreamEvent[] = []
  await runAgent(request({ goal: { text: 'impossible', status: 'active', iterations: 0 } }), (e) => events.push(e))
  server.close()
  store.patchSettings({ work: { goalMaxIterations: 8 } })
  assert.equal(requests.length, 3, 'initial + 2 continuations')
  const last = events.filter((e) => e.type === 'goal').at(-1) as Extract<StreamEvent, { type: 'goal' }>
  assert.equal(last.goal.status, 'paused')
})

test('swarm runs sub-agents with role-scoped tools and returns their reports', async () => {
  let main = 0
  const { server, requests } = await setup((body) => {
    if (isSubagent(body)) {
      const task = String((body.messages.find((m) => m.role === 'user') as { content: string }).content)
      return say(`report for: ${task}`)
    }
    return main++ === 0
      ? toolCall('spawn_agents', { agents: [{ role: 'scout', task: 'find A' }, { role: 'implementer', task: 'change B' }] })
      : say('Synthesis done.')
  })
  const events: StreamEvent[] = []
  const outcome = await runAgent(request({ work: { swarm: true, plan: false } }), (e) => events.push(e), { approver: async () => true })
  server.close()
  assert.equal(outcome.error, undefined)
  const bodies = requests as unknown as Body[]
  const scout = bodies.find((b) => isSubagent(b) && JSON.stringify(b.messages).includes('find A'))!
  const implementer = bodies.find((b) => isSubagent(b) && JSON.stringify(b.messages).includes('change B'))!
  assert.ok(!toolNames(scout).includes('write_file'), 'scout is read-only')
  assert.ok(toolNames(implementer).includes('write_file'), 'implementer can write')
  assert.ok(!toolNames(scout).includes('spawn_agents') && !toolNames(implementer).includes('spawn_agents'), 'no recursion')
  const done = events.filter((e) => e.type === 'subagent' && (e as Extract<StreamEvent, { type: 'subagent' }>).run.status === 'done')
  assert.equal(done.length, 2)
  const result = events.find((e) => e.type === 'tool-result') as Extract<StreamEvent, { type: 'tool-result' }>
  assert.match(result.output, /report for: find A/)
  assert.match(result.output, /report for: change B/)
})

test('a denied write is not performed and the model is told', async () => {
  const req = request()
  const { server, requests } = await setup((_b, i) => (i === 0 ? toolCall('write_file', { path: 'x.txt', content: 'hi' }) : say('OK, I will not.')))
  const events: StreamEvent[] = []
  await runAgent(req, (e) => events.push(e), { approver: async () => false })
  server.close()
  assert.equal(existsSync(join(req.cwd!, 'x.txt')), false)
  const result = events.find((e) => e.type === 'tool-result') as Extract<StreamEvent, { type: 'tool-result' }>
  assert.equal(result.status, 'denied')
  assert.match(JSON.stringify((requests[1] as unknown as Body).messages), /denied/)
})

test('read-only shell commands run without asking; approved writes happen', async () => {
  const req = request()
  const { server } = await setup((_b, i) =>
    i === 0 ? toolCall('run_command', { command: 'ls' }) : i === 1 ? toolCall('write_file', { path: 'y.txt', content: 'yo' }) : say('done')
  )
  const asked: string[] = []
  await runAgent(req, () => {}, { approver: async (tool) => (asked.push(tool), true) })
  server.close()
  assert.deepEqual(asked, ['write_file'])
  assert.equal(existsSync(join(req.cwd!, 'y.txt')), true)
})

test('a 429 is retried after its retry-after, with a visible note', async () => {
  const { server, requests } = await setup((_b, i) =>
    i === 0 ? { status: 429, body: JSON.stringify({ error: { message: 'rate limited' } }) } : say('hello')
  )
  const events: StreamEvent[] = []
  const outcome = await runAgent(request({ mode: 'chat' }), (e) => events.push(e))
  server.close()
  assert.equal(outcome.error, undefined)
  assert.equal(requests.length, 2)
  assert.ok(events.some((e) => e.type === 'reasoning' && /busy \(429\)/.test(e.text)))
})

test('a reply cut off before anything was shown is retried, not accepted', async () => {
  // First response: the connection closes after a role-only chunk — no
  // finish_reason, no [DONE]. Nothing reached the user, so it is safe to retry.
  const { server, requests } = await setup((_b, i) => (i === 0 ? [chunk({ role: 'assistant' })] : say('hello')))
  const events: StreamEvent[] = []
  const outcome = await runAgent(request({ mode: 'chat' }), (e) => events.push(e))
  server.close()
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.text, 'hello')
  assert.equal(requests.length, 2)
})

test('a tool call cut off by the output limit is not executed', async () => {
  const req = request()
  const { server, requests } = await setup((_b, i) =>
    i === 0
      ? [chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":"z.txt","content":"trunc' } }] }, 'length')]
      : say('I will split it up.')
  )
  await runAgent(req, () => {}, { approver: async () => true })
  server.close()
  assert.equal(existsSync(join(req.cwd!, 'z.txt')), false)
  assert.match(JSON.stringify((requests[1] as unknown as Body).messages), /output limit/)
})

test('an unknown tool is reported back instead of failing the turn', async () => {
  const { server, requests } = await setup((_b, i) => (i === 0 ? toolCall('does_not_exist', {}) : say('sorry')))
  const outcome = await runAgent(request(), () => {})
  server.close()
  assert.equal(outcome.error, undefined)
  assert.match(JSON.stringify((requests[1] as unknown as Body).messages), /Unknown tool/)
})

test('a thinking-only reply is nudged instead of ending the turn', async () => {
  const req = request()
  const { server, requests } = await setup((_b, i) =>
    i === 0 ? [chunk({ reasoning_content: 'I should write the file.' }, 'stop')] : i === 1 ? toolCall('write_file', { path: 'n.txt', content: 'x' }) : say('Done.')
  )
  const outcome = await runAgent(req, () => {}, { approver: async () => true })
  server.close()
  assert.equal(outcome.error, undefined)
  assert.equal(existsSync(join(req.cwd!, 'n.txt')), true)
  assert.match(JSON.stringify((requests[1] as unknown as Body).messages), /did not act/)
})

test('a Work reply that only announces its plan is sent back to act, once', async () => {
  const req = request()
  const { server, requests } = await setup((_b, i) =>
    i === 0 ? say("Sure. Steps:\n1. Create the folder\n2. Write the file") : i === 1 ? toolCall('write_file', { path: 'p.txt', content: 'x' }) : say('Done — p.txt is written.')
  )
  await runAgent(req, () => {}, { approver: async () => true })
  server.close()
  assert.equal(existsSync(join(req.cwd!, 'p.txt')), true)
  assert.equal(requests.length, 3)
})

test('intent detection leaves real answers and questions alone', () => {
  assert.equal(announcesIntent("I'll create the file now."), true)
  assert.equal(announcesIntent('Steps:\n1. Create notes/'), true)
  assert.equal(announcesIntent('Done. The file is at notes/todo.md.'), false)
  assert.equal(announcesIntent('Which folder should I use?'), false)
  assert.equal(announcesIntent('Should I also add a README? I will wait for you?'), false)
})
