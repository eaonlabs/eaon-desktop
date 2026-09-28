import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import { toolsFor } from '../src/main/agent/tools'
import { store } from '../src/main/store'
import { shutdownMcp } from '../src/main/mcp'
import '../src/main/agent/pluginTools'
import { pluginsFeature } from '../src/main/features/plugins'
import type { McpServerStatus } from '@shared/types'
import type { StreamEvent, StreamRequest } from '@shared/types'

/**
 * The release's end-to-end scenarios against a real local model: Chat
 * research with web search only, a Work fix that runs → observes → edits →
 * re-runs, a goal that must end on a passing check, and a swarm. Opt-in
 * (EAON_LIVE=1); each takes minutes on a laptop GPU.
 *
 *   EAON_LIVE_MODEL   Ollama model with tool calling (default qwen3.5:9b)
 */
const MODEL = process.env.EAON_LIVE_MODEL ?? 'qwen3.5:9b'
const live = { skip: !process.env.EAON_LIVE, timeout: 900_000 }

async function ollamaUp(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) })
    const body = (await res.json()) as { models?: { name: string }[] }
    return Boolean(body.models?.some((m) => m.name === MODEL))
  } catch {
    return false
  }
}

function request(text: string, overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    chatId: `live-${Math.random()}`,
    messageId: `m${Date.now()}${Math.random()}`,
    providerId: 'ollama',
    modelId: MODEL,
    effort: 'medium',
    mode: 'work',
    history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text }] }],
    summary: null,
    projectInstructions: '',
    cwd: null,
    work: { swarm: false, plan: false },
    goal: null,
    ...overrides
  }
}

type Call = { name: string; input: Record<string, unknown> }
const callsOf = (events: StreamEvent[]): Call[] =>
  events.filter((e) => e.type === 'tool-call').map((e) => ({ name: (e as Call).name, input: (e as Call).input }))
const describe = (calls: Call[]): string =>
  calls.map((c) => (c.name === 'run_command' ? `run_command(${String(c.input.command).slice(0, 60)})` : c.name)).join(' → ')

/** Runs `node <file>` in `cwd` ourselves: the evidence is the program, not the model's word. */
const nodeRun = (cwd: string, file: string): { ok: boolean; output: string } => {
  try {
    return { ok: true, output: execFileSync(process.execPath, [file], { cwd, encoding: 'utf8', stdio: 'pipe' }) }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

test('A. Chat: research uses web search, and nothing that touches the machine is offered', live, async (t) => {
  if (!(await ollamaUp())) return t.skip(`Ollama or ${MODEL} not available`)
  const req = request('Research the newest local LLM releases. Search the web, then list three with their release month and a source link.', {
    mode: 'chat'
  })
  const offered = toolsFor({ mode: 'chat', cwd: null, depth: 0, readOnly: false, settings: store.getSettings(), request: req }).map((t) => t.name)
  assert.deepEqual(offered, ['web_search'])

  const events: StreamEvent[] = []
  const outcome = await runAgent(req, (e) => events.push(e))
  const calls = callsOf(events)
  console.log('A tools:', describe(calls), '| usage:', JSON.stringify(outcome.usage))
  console.log('A answer:', outcome.text.slice(0, 700))
  assert.equal(outcome.error, undefined)
  assert.ok(calls.length > 0 && calls.every((c) => c.name === 'web_search'), 'searched, and only searched')
  assert.match(outcome.text, /https?:\/\//, 'cites a source')
})

test('B. Work: runs the program, sees the failure, fixes it, re-runs to verify', live, async (t) => {
  if (!(await ollamaUp())) return t.skip(`Ollama or ${MODEL} not available`)
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-e2e-b-'))
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n')
  writeFileSync(
    join(cwd, 'average.js'),
    'export function average(xs) {\n  let sum = 0\n  for (let i = 1; i < xs.length; i++) sum += xs[i]\n  return sum / xs.length\n}\n'
  )
  writeFileSync(
    join(cwd, 'check.js'),
    "import { average } from './average.js'\nconst got = average([2, 4, 6])\nif (got !== 4) { console.error(`FAIL: average([2,4,6]) = ${got}, expected 4`); process.exit(1) }\nconsole.log('PASS')\n"
  )
  assert.equal(nodeRun(cwd, 'check.js').ok, false, 'starts broken')

  const events: StreamEvent[] = []
  const outcome = await runAgent(
    request('This project has a bug. Run `node check.js`, find the bug from what it prints, fix it, then run `node check.js` again to verify it passes.', {
      cwd
    }),
    (e) => events.push(e),
    { approver: async () => true }
  )
  const calls = callsOf(events)
  console.log('B tools:', describe(calls), '| usage:', JSON.stringify(outcome.usage))
  assert.equal(outcome.error, undefined)
  const firstRun = calls.findIndex((c) => c.name === 'run_command' && /check\.js/.test(String(c.input.command)))
  const edit = calls.findIndex((c, i) => i > firstRun && (c.name === 'edit_file' || c.name === 'write_file'))
  const rerun = calls.findIndex((c, i) => i > edit && c.name === 'run_command' && /check\.js/.test(String(c.input.command)))
  assert.ok(firstRun >= 0 && edit > firstRun && rerun > edit, `ran → edited → re-ran (${describe(calls)})`)
  assert.deepEqual(nodeRun(cwd, 'check.js'), { ok: true, output: 'PASS\n' })
  console.log('B fixed file:\n' + readFileSync(join(cwd, 'average.js'), 'utf8'))
})

test('D. Work + plugin: connects a no-account plugin and answers a read-only question with it', live, async (t) => {
  if (!(await ollamaUp())) return t.skip(`Ollama or ${MODEL} not available`)
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  pluginsFeature.register({
    ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn), on: () => {} } as never,
    getWindow: () => null,
    send: () => {},
    emitStream: () => {}
  })
  const statuses = (await handlers.get('plugins:enable')!({}, 'deepwiki')) as McpServerStatus[]
  const status = statuses.find((s) => s.serverId === 'plugin-deepwiki')
  if (status?.state !== 'ready') return t.skip(`DeepWiki unreachable: ${status?.error ?? 'offline'}`)
  try {
    const events: StreamEvent[] = []
    const outcome = await runAgent(
      request('Using the DeepWiki plugin, look up the GitHub repository expressjs/express and tell me in one sentence what it is.'),
      (e) => events.push(e),
      { approver: async () => true }
    )
    const calls = callsOf(events)
    console.log('D tools:', describe(calls), '| usage:', JSON.stringify(outcome.usage))
    console.log('D answer:', outcome.text.slice(0, 400))
    assert.equal(outcome.error, undefined)
    const used = calls.some((c) => /deepwiki|ask_wiki|read_wiki/i.test(c.name) || /deepwiki|ask_wiki|read_wiki/i.test(JSON.stringify(c.input)))
    assert.ok(used, `called a DeepWiki tool (${describe(calls)})`)
    assert.match(outcome.text.toLowerCase(), /web|framework|node|server/)
  } finally {
    await handlers.get('plugins:disconnect')!({}, 'deepwiki')
    await shutdownMcp()
  }
})

test('E. Goal: keeps repairing until the check really passes', live, async (t) => {
  if (!(await ollamaUp())) return t.skip(`Ollama or ${MODEL} not available`)
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-e2e-e-'))
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n')
  // Three independent bugs; the check stops at the first failure, so each
  // run reveals only one of them.
  writeFileSync(
    join(cwd, 'text.js'),
    [
      "export const shout = (s) => s.toLowerCase() + '!'",
      'export const words = (s) => s.split(\' \').length - 1',
      'export const initials = (s) => s.split(\' \').map((w) => w[1]).join(\'\')',
      ''
    ].join('\n')
  )
  writeFileSync(
    join(cwd, 'check.js'),
    [
      "import { shout, words, initials } from './text.js'",
      "const expect = (name, got, want) => { if (got !== want) { console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); process.exit(1) } }",
      "expect('shout', shout('hi'), 'HI!')",
      "expect('words', words('a b c'), 3)",
      "expect('initials', initials('Ada Lovelace'), 'AL')",
      "console.log('ALL PASS')",
      ''
    ].join('\n')
  )
  const goalText = 'Make `node check.js` print ALL PASS by fixing text.js. Do not edit check.js.'
  const events: StreamEvent[] = []
  const outcome = await runAgent(
    request(goalText, { cwd, goal: { text: goalText, status: 'active', iterations: 0 } }),
    (e) => events.push(e),
    { approver: async () => true }
  )
  const calls = callsOf(events)
  const goals = events.filter((e) => e.type === 'goal').map((e) => (e as Extract<StreamEvent, { type: 'goal' }>).goal)
  console.log('E tools:', describe(calls), '| usage:', JSON.stringify(outcome.usage))
  console.log('E goal events:', goals.map((g) => `${g.status}${g.summary ? `(${g.summary.slice(0, 80)})` : ''}`).join(' → '))
  assert.equal(outcome.error, undefined)
  // What goal mode promises: it does not stop at "I changed the code". A
  // capable model may fix all three bugs in one edit, so the number of
  // repair cycles is not the test; the check after the last change is.
  const lastEdit = calls.map((c) => c.name).lastIndexOf('edit_file')
  const lastWrite = calls.map((c) => c.name).lastIndexOf('write_file')
  const lastChange = Math.max(lastEdit, lastWrite)
  const checkedAfter = calls.some((c, i) => i > lastChange && c.name === 'run_command' && /check\.js/.test(String(c.input.command)))
  assert.ok(lastChange >= 0 && checkedAfter, `ran the check after its last change (${describe(calls)})`)
  assert.deepEqual(nodeRun(cwd, 'check.js'), { ok: true, output: 'ALL PASS\n' }, 'the check really passes')
  assert.equal(goals.at(-1)?.status, 'achieved')
  assert.match(readFileSync(join(cwd, 'check.js'), 'utf8'), /ALL PASS/, 'did not rewrite the check')
})

test('F. Swarm: parallel sub-agents on independent parts, reconciled by the lead', live, async (t) => {
  if (!(await ollamaUp())) return t.skip(`Ollama or ${MODEL} not available`)
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-e2e-f-'))
  writeFileSync(join(cwd, 'inventory.js'), 'export const total = (items) => items.reduce((n, i) => n + i.qty, 0) // counts units\n')
  writeFileSync(join(cwd, 'pricing.js'), 'export const price = (qty, unit) => qty * unit * 1.2 // includes 20% tax\n')
  writeFileSync(join(cwd, 'shipping.js'), 'export const shipping = (kg) => (kg > 10 ? 0 : 5) // free over 10 kg\n')
  const events: StreamEvent[] = []
  const outcome = await runAgent(
    request(
      'Three independent modules need documenting: inventory.js, pricing.js and shipping.js. Use sub-agents in parallel, one per module, each reporting in one sentence what its function does. Then combine their reports into a short summary.',
      { cwd, work: { swarm: true, plan: false } }
    ),
    (e) => events.push(e),
    { approver: async () => true }
  )
  const calls = callsOf(events)
  const subagentEvents = events.filter((e) => e.type === 'subagent')
  console.log('F tools:', describe(calls), '| sub-agent events:', subagentEvents.length, '| usage:', JSON.stringify(outcome.usage))
  console.log('F answer:', outcome.text.slice(0, 600))
  assert.equal(outcome.error, undefined)
  const spawn = calls.find((c) => c.name === 'spawn_agents')
  assert.ok(spawn, 'used sub-agents')
  const agents = (spawn!.input.agents ?? spawn!.input.tasks) as unknown[]
  assert.ok(Array.isArray(agents) && agents.length >= 2 && agents.length <= 6, `2–6 sub-agents (${JSON.stringify(spawn!.input).slice(0, 200)})`)
  for (const word of ['inventory', 'pric', 'shipping']) assert.match(outcome.text.toLowerCase(), new RegExp(word), `summary covers ${word}`)
})
