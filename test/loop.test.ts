import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { announcesIntent, pauseGoal, runAgent } from '../src/main/agent/loop'
import { registerToolSource, type AgentTool } from '../src/main/agent/tools'
import { powerSaveBlocker } from 'electron'
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

test('the same failing call is refused after three identical failures instead of run again', async () => {
  const { server, requests } = await setup((_b, i) => (i < 4 ? toolCall('read_file', { path: 'missing.txt' }, `c${i}`) : say('Giving up on that file.')))
  const events: StreamEvent[] = []
  const outcome = await runAgent(request(), (e) => events.push(e))
  server.close()
  assert.equal(outcome.error, undefined)
  const results = events.filter((e) => e.type === 'tool-result') as Extract<StreamEvent, { type: 'tool-result' }>[]
  assert.equal(results.length, 4)
  assert.match(results[1].output, /ENOENT|no such file/i)
  assert.match(JSON.stringify((requests[2] as unknown as Body).messages), /failed twice/)
  assert.match(results[3].output, /^Not run: this exact read_file call has already failed 3 times/)
})

test('goal_complete straight after an unchecked change is sent back once to verify', async () => {
  const req = request({ goal: { text: 'make a.txt', status: 'active', iterations: 0 } })
  const { server, requests } = await setup((_b, i) =>
    i === 0
      ? toolCall('write_file', { path: 'a.txt', content: 'hi' })
      : i === 1
        ? toolCall('goal_complete', { summary: 'Wrote it.' }, 'g1')
        : i === 2
          ? toolCall('read_file', { path: 'a.txt' })
          : i === 3
            ? toolCall('goal_complete', { summary: 'Wrote it and read it back: "hi".' }, 'g2')
            : say('Done.')
  )
  const events: StreamEvent[] = []
  await runAgent(req, (e) => events.push(e), { approver: async () => true })
  server.close()
  assert.equal(requests.length, 5)
  assert.match(JSON.stringify((requests[2] as unknown as Body).messages), /Not marked achieved yet: your last action \(write_file\)/)
  const goals = events.filter((e) => e.type === 'goal').map((e) => (e as Extract<StreamEvent, { type: 'goal' }>).goal)
  assert.equal(goals.at(-1)?.status, 'achieved')
  assert.match(goals.at(-1)?.summary ?? '', /read it back/)
})

test('goal_complete is accepted on the second ask even without a check, so it cannot deadlock', async () => {
  const req = request({ goal: { text: 'make b.txt', status: 'active', iterations: 0 } })
  const { server } = await setup((_b, i) =>
    i === 0
      ? toolCall('write_file', { path: 'b.txt', content: 'x' })
      : i <= 2
        ? toolCall('goal_complete', { summary: 'Cannot be checked further.' }, `g${i}`)
        : say('Done.')
  )
  const events: StreamEvent[] = []
  await runAgent(req, (e) => events.push(e), { approver: async () => true })
  server.close()
  const last = events.filter((e) => e.type === 'goal').at(-1) as Extract<StreamEvent, { type: 'goal' }>
  assert.equal(last.goal.status, 'achieved')
})

test('pausing a running goal stops it at the next continuation, with no reason shown', async () => {
  const req = request({ goal: { text: 'endless', status: 'active', iterations: 0 } })
  const { server, requests } = await setup((_b, i) => {
    if (i === 1) pauseGoal(req.messageId)
    return say('still working')
  })
  const events: StreamEvent[] = []
  await runAgent(req, (e) => events.push(e))
  server.close()
  assert.equal(requests.length, 2, 'the step in hand finishes, then no further continuation')
  const last = events.filter((e) => e.type === 'goal').at(-1) as Extract<StreamEvent, { type: 'goal' }>
  assert.equal(last.goal.status, 'paused')
  assert.equal(last.goal.summary, undefined)
})

test('a goal over its token budget pauses and says which limit it hit', async () => {
  store.patchSettings({ work: { goalMaxTokens: 50 } })
  const { server, requests } = await setup(() => [
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'working' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } })
  ])
  const events: StreamEvent[] = []
  await runAgent(request({ goal: { text: 'big', status: 'active', iterations: 0 } }), (e) => events.push(e))
  server.close()
  store.patchSettings({ work: { goalMaxTokens: 2_000_000 } })
  assert.equal(requests.length, 1)
  const last = events.filter((e) => e.type === 'goal').at(-1) as Extract<StreamEvent, { type: 'goal' }>
  assert.equal(last.goal.status, 'paused')
  assert.match(last.goal.summary ?? '', /token limit of 50 reached/)
})

test('prevent sleep holds the machine awake for the run and lets go after', async () => {
  const blocker = powerSaveBlocker as unknown as { active: Set<number>; started: number }
  const before = blocker.started
  store.patchSettings({ general: { preventSleep: true } })
  let heldDuringRun = false
  const { server } = await setup(() => {
    heldDuringRun = blocker.active.size === 1
    return say('hi')
  })
  await runAgent(request({ mode: 'chat' }), () => {})
  server.close()
  store.patchSettings({ general: { preventSleep: false } })
  assert.equal(heldDuringRun, true)
  assert.equal(blocker.started, before + 1)
  assert.equal(blocker.active.size, 0)

  await (async () => {
    const { server } = await setup(() => say('hi'))
    await runAgent(request({ mode: 'chat' }), () => {})
    server.close()
  })()
  assert.equal(blocker.started, before + 1, 'not held when the setting is off')
})

test('a failed call is not evidence: write, failed edit, goal_complete is still sent back', async () => {
  const req = request({ goal: { text: 'make c.txt', status: 'active', iterations: 0 } })
  const { server, requests } = await setup((_b, i) =>
    i === 0
      ? toolCall('write_file', { path: 'c.txt', content: 'one' })
      : i === 1
        ? toolCall('edit_file', { path: 'c.txt', old_text: 'not there', new_text: 'two' })
        : i === 2
          ? toolCall('goal_complete', { summary: 'Done.' }, 'g1')
          : say('ok')
  )
  await runAgent(req, () => {}, { approver: async () => true })
  server.close()
  assert.match(JSON.stringify((requests[3] as unknown as Body).messages), /Not marked achieved yet: your last action \(write_file\)/)
})

test('a pause lands between tool rounds, not only when the model stops calling tools', async () => {
  const req = request({ goal: { text: 'keep reading', status: 'active', iterations: 0 } })
  writeFileSync(join(req.cwd!, 'r.txt'), 'x')
  const { server, requests } = await setup((_b, i) => {
    if (i === 1) pauseGoal(req.messageId)
    return toolCall('read_file', { path: 'r.txt' }, `r${i}`)
  })
  const events: StreamEvent[] = []
  await runAgent(req, (e) => events.push(e))
  server.close()
  assert.equal(requests.length, 2, 'no model call after the pause')
  assert.equal((events.filter((e) => e.type === 'goal').at(-1) as Extract<StreamEvent, { type: 'goal' }>).goal.status, 'paused')
})

/* Tools that misbehave on purpose, offered only to the chats named here. */
const stubborn: AgentTool[] = [
  // Ignores the abort signal and never finishes, like a hung plugin call.
  { name: 'hang', description: 'never returns', inputSchema: { type: 'object', properties: {} }, mutating: false, run: () => new Promise(() => {}) },
  // Asks for its own confirmation after a delay, as computer use does.
  {
    name: 'late_confirm',
    description: 'confirms late',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    run: async (_input, ctx) => {
      await new Promise((r) => setTimeout(r, 100))
      return (await ctx.confirm('late_confirm', {})) ? 'approved' : 'denied'
    }
  }
]
registerToolSource({ id: 'loop-test-stubborn', tools: (query) => (query.request.chatId === 'stubborn' ? stubborn : []) })

test('Stop ends the turn even when a running tool ignores the abort signal', { timeout: 5000 }, async () => {
  const { server } = await setup((_b, i) => (i === 0 ? toolCall('hang', {}) : say('unreachable')))
  const controller = new AbortController()
  const events: StreamEvent[] = []
  const outcome = await runAgent(
    request({ chatId: 'stubborn' }),
    (e) => {
      events.push(e)
      if (e.type === 'tool-call') setTimeout(() => controller.abort(), 20)
    },
    { signal: controller.signal }
  )
  server.close()
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.cancelled, true)
  assert.ok(events.some((e) => e.type === 'done'))
  const result = events.find((e) => e.type === 'tool-result') as Extract<StreamEvent, { type: 'tool-result' }>
  assert.equal(result?.status, 'error', 'the tool card is closed, not left running')
})

test('a stopped run asks for no approval afterwards', { timeout: 5000 }, async () => {
  const { server } = await setup((_b, i) => (i === 0 ? toolCall('late_confirm', {}) : say('unreachable')))
  const controller = new AbortController()
  const events: StreamEvent[] = []
  await runAgent(
    request({ chatId: 'stubborn' }),
    (e) => {
      events.push(e)
      if (e.type === 'tool-call') setTimeout(() => controller.abort(), 20)
    },
    { signal: controller.signal }
  )
  server.close()
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(events.filter((e) => e.type === 'approval-request').length, 0)
})

test('a run whose signal is already aborted never calls the model, and says it was cancelled', async () => {
  const { server, requests } = await setup(() => say('hi'))
  const events: StreamEvent[] = []
  const outcome = await runAgent(request(), (e) => events.push(e), { signal: AbortSignal.abort() })
  server.close()
  assert.equal(requests.length, 0)
  assert.equal(outcome.cancelled, true)
  assert.equal(outcome.error, undefined)
  assert.ok(events.some((e) => e.type === 'done'))

  const again = await setup(() => say('hi'))
  const finished = await runAgent(request(), () => {})
  again.server.close()
  assert.equal(finished.cancelled, undefined, 'a run that finishes is not cancelled')
})

test('a final answer cut off by the output limit is not reported as a round limit', async () => {
  const req = request()
  writeFileSync(join(req.cwd!, 'f.txt'), 'x')
  const { server } = await setup((_b, i) => (i === 0 ? toolCall('read_file', { path: 'f.txt' }) : [chunk({ content: 'The file says x and' }, 'length')]))
  const outcome = await runAgent(req, () => {})
  server.close()
  assert.equal(outcome.error, undefined)
  assert.doesNotMatch(outcome.text, /tool rounds/)
})

test('a sub-agent that fails still counts the tokens it spent', async () => {
  let main = 0
  let sub = 0
  const { server } = await setup((body) => {
    if (isSubagent(body)) {
      return sub++ === 0
        ? [
            JSON.stringify({
              choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 's1', function: { name: 'list_dir', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 1000, completion_tokens: 100 }
            })
          ]
        : { status: 400, body: JSON.stringify({ error: { message: 'bad request' } }) }
    }
    return main++ === 0 ? toolCall('spawn_agents', { agents: [{ role: 'scout', task: 'look around' }] }) : say('ok')
  })
  const events: StreamEvent[] = []
  await runAgent(request({ work: { swarm: true, plan: false } }), (e) => events.push(e))
  server.close()
  const failed = events.find((e) => e.type === 'subagent' && e.run.status === 'error')
  assert.ok(failed, 'the sub-agent failed')
  const last = events.filter((e) => e.type === 'usage').at(-1) as Extract<StreamEvent, { type: 'usage' }>
  assert.ok(last.usage.input >= 1000, `input ${last.usage.input}`)
})

test('the compaction request counts toward the turn\'s usage', async () => {
  const { server, requests, url } = await setup((_b, i) => [
    JSON.stringify({ choices: [{ index: 0, delta: { content: i === 0 ? 'SUMMARY' : 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: i === 0 ? 700 : 50, completion_tokens: 5 } })
  ])
  store.saveProviderConfig({
    fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake', contextWindow: 2000 }] }
  })
  const long = 'word '.repeat(400)
  const history = [1, 2, 3, 4].flatMap((n) => [
    { id: `u${n}`, role: 'user' as const, createdAt: 0, parts: [{ type: 'text' as const, text: `${n} ${long}` }] },
    { id: `a${n}`, role: 'assistant' as const, createdAt: 0, parts: [{ type: 'text' as const, text: `reply ${n}` }] }
  ])
  history.push({ id: 'u5', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'and now?' }] })
  const events: StreamEvent[] = []
  await runAgent(request({ mode: 'chat', history }), (e) => events.push(e))
  server.close()
  assert.equal(requests.length, 2, 'summary, then the answer')
  assert.ok(events.some((e) => e.type === 'compacted'))
  const last = events.filter((e) => e.type === 'usage').at(-1) as Extract<StreamEvent, { type: 'usage' }>
  assert.equal(last.usage.input, 750)
})

test('a repeated call id is made unique, so each result lands on its own call', async () => {
  // Several local runtimes number calls per response ("call_0") or derive
  // the id from the call itself, so the same call made twice repeats its id.
  const req = request()
  writeFileSync(join(req.cwd!, 'f.txt'), 'x')
  const { server, requests } = await setup((_b, i) => (i < 2 ? toolCall('read_file', { path: 'f.txt' }, 'call_0') : say('done')))
  const events: StreamEvent[] = []
  await runAgent(req, (e) => events.push(e))
  server.close()
  const calls = events.filter((e) => e.type === 'tool-call') as Extract<StreamEvent, { type: 'tool-call' }>[]
  const results = events.filter((e) => e.type === 'tool-result') as Extract<StreamEvent, { type: 'tool-result' }>[]
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].toolId, calls[1].toolId)
  assert.deepEqual(results.map((r) => r.toolId), calls.map((c) => c.toolId))
  // What goes back to the provider pairs up the same way.
  const sent = (requests[2] as unknown as { messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[] }).messages
  const callIds = sent.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? [])
  const resultIds = sent.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
  assert.equal(new Set(callIds).size, 2)
  assert.deepEqual(resultIds, callIds)
})

/* Stands in for the plugins source (no MCP server is connected in these tests). */
let pluginCalls = 0
registerToolSource({
  id: 'plugins',
  tools: (query) =>
    query.request.chatId === 'plugin-policy'
      ? [
          {
            name: 'crm__create_lead',
            description: 'Create a lead',
            inputSchema: { type: 'object', properties: {} },
            mutating: () => true,
            risky: () => true,
            run: async () => {
              pluginCalls++
              return 'Lead created.'
            }
          }
        ]
      : query.request.chatId === 'plugin-broker'
        ? [
            {
              name: 'broker__place_order',
              description: 'A real-money order (catastrophic, as pluginTools marks broker writes)',
              inputSchema: { type: 'object', properties: {} },
              mutating: () => true,
              risky: () => true,
              catastrophic: () => true,
              run: async () => {
                pluginCalls++
                return 'Order placed.'
              }
            }
          ]
        : []
})

test('"Allow all MCP tool permissions" skips the prompt for plugin calls, but not plan mode or scheduled runs', async () => {
  const run = async (overrides: Partial<StreamRequest>, options: Parameters<typeof runAgent>[2] = {}) => {
    const { server } = await setup((_b, i) => (i === 0 ? toolCall('crm__create_lead', {}) : say('ok')))
    const asked: string[] = []
    const events: StreamEvent[] = []
    await runAgent(request({ chatId: 'plugin-policy', ...overrides }), (e) => events.push(e), { approver: async (tool) => (asked.push(tool), false), ...options })
    server.close()
    const result = events.find((e) => e.type === 'tool-result') as Extract<StreamEvent, { type: 'tool-result' }>
    return { asked, status: result.status }
  }
  try {
    pluginCalls = 0
    assert.deepEqual(await run({}), { asked: ['crm__create_lead'], status: 'denied' }, 'off: the user is asked')
    assert.equal(pluginCalls, 0)

    store.patchSettings({ mcp: { allowAllToolPermissions: true } })
    assert.deepEqual(await run({}), { asked: [], status: 'done' }, 'on: runs without asking')
    assert.equal(pluginCalls, 1)
    assert.deepEqual(await run({ work: { swarm: false, plan: true } }), { asked: [], status: 'denied' }, 'plan mode still refuses')
    assert.deepEqual(await run({}, { unattended: 'read-only' }), { asked: [], status: 'denied' }, 'a read-only scheduled run still refuses')
    // The user approved every plugin call in advance: that holds for a worker
    // or a scheduled run too. (Refusing here is why plugins "didn't work" in
    // Workers.)
    assert.deepEqual(await run({}, { unattended: 'safe' }), { asked: [], status: 'done' }, 'an unattended run honours the pre-approval')
    assert.equal(pluginCalls, 2)
  } finally {
    store.patchSettings({ mcp: { allowAllToolPermissions: false } })
  }
})

/* An autonomous worker's gate: risky runs, catastrophic never — unless approved once. */
const gateCalls: string[] = []
registerToolSource({
  id: 'loop-test-gate',
  tools: (query) =>
    query.request.chatId === 'autonomy-gate'
      ? [
          {
            name: 'deploy',
            description: 'Deploy (risky)',
            inputSchema: { type: 'object', properties: {} },
            mutating: () => true,
            risky: () => true,
            run: async () => (gateCalls.push('deploy'), 'Deployed.')
          },
          {
            name: 'pay',
            description: 'Pay (catastrophic)',
            inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
            mutating: () => true,
            risky: () => true,
            catastrophic: () => true,
            run: async () => (gateCalls.push('pay'), 'Paid.')
          }
        ]
      : []
})

test('autonomous runs risky calls alone, never catastrophic ones — except the one call the user approved', async () => {
  const run = async (tool: string, options: Parameters<typeof runAgent>[2]) => {
    const { server } = await setup((_b, i) => (i === 0 ? toolCall(tool, { amount: 12 }) : say('ok')))
    const events: StreamEvent[] = []
    await runAgent(request({ chatId: 'autonomy-gate' }), (e) => events.push(e), options)
    server.close()
    return events.find((e) => e.type === 'tool-result') as Extract<StreamEvent, { type: 'tool-result' }>
  }
  gateCalls.length = 0
  assert.equal((await run('deploy', { unattended: 'autonomous' })).status, 'done')
  assert.equal((await run('deploy', { unattended: 'safe' })).status, 'denied', 'a Careful worker still refuses risky calls')
  const refused = await run('pay', { unattended: 'autonomous' })
  assert.equal(refused.status, 'denied')
  assert.match(refused.output, /ask_user.*approve_tool/)
  const asked: [string, Record<string, unknown>][] = []
  const approved = await run('pay', { unattended: 'autonomous', allowOnce: (tool, input) => (asked.push([tool, input]), true) })
  assert.equal(approved.status, 'done')
  assert.deepEqual(asked, [['pay', { amount: 12 }]], 'the exact call is what gets checked')
  assert.deepEqual(gateCalls, ['deploy', 'pay'])
})

test('"Allow all MCP tool permissions" never covers a call that can’t be undone, like a real-money order', async () => {
  const run = async (options: Parameters<typeof runAgent>[2]) => {
    const { server } = await setup((_b, i) => (i === 0 ? toolCall('broker__place_order', {}) : say('ok')))
    const asked: string[] = []
    const events: StreamEvent[] = []
    await runAgent(request({ chatId: 'plugin-broker' }), (e) => events.push(e), { approver: async (tool) => (asked.push(tool), false), ...options })
    server.close()
    return { asked, status: (events.find((e) => e.type === 'tool-result') as Extract<StreamEvent, { type: 'tool-result' }>).status }
  }
  store.patchSettings({ mcp: { allowAllToolPermissions: true } })
  try {
    pluginCalls = 0
    assert.deepEqual(await run({}), { asked: ['broker__place_order'], status: 'denied' }, 'a chat still asks')
    store.patchSettings({ approvalMode: 'auto' })
    assert.deepEqual(await run({}), { asked: ['broker__place_order'], status: 'denied' }, '"Approve for me" still asks')
    assert.deepEqual(await run({ unattended: 'safe' }), { asked: [], status: 'denied' }, 'a Careful worker never places it')
    assert.deepEqual(await run({ unattended: 'autonomous' }), { asked: [], status: 'denied' }, 'an autonomous worker needs Approve once')
    assert.deepEqual(await run({ unattended: 'autonomous', allowOnce: () => true }), { asked: [], status: 'done' }, 'and with it, goes ahead')
    assert.equal(pluginCalls, 1)
  } finally {
    store.patchSettings({ mcp: { allowAllToolPermissions: false }, approvalMode: 'ask' })
  }
})

test('"Allow all MCP tool permissions" does not pre-approve tools that are not plugins', async () => {
  store.patchSettings({ mcp: { allowAllToolPermissions: true } })
  try {
    const req = request()
    const { server } = await setup((_b, i) => (i === 0 ? toolCall('write_file', { path: 'w.txt', content: 'x' }) : say('ok')))
    const asked: string[] = []
    await runAgent(req, () => {}, { approver: async (tool) => (asked.push(tool), false) })
    server.close()
    assert.deepEqual(asked, ['write_file'])
    assert.equal(existsSync(join(req.cwd!, 'w.txt')), false)
  } finally {
    store.patchSettings({ mcp: { allowAllToolPermissions: false } })
  }
})
