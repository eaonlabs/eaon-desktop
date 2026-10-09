import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import '../src/main/features/computerUse'
import '../src/main/features/simulator'
import '../src/main/features/skills'
import '../src/main/features/images/tool'
import { runAgent } from '../src/main/agent/loop'
import { callFacts, decide, SPENDING_REFUSAL, UNATTENDED_CATASTROPHIC, type RunPolicy } from '../src/main/agent/policy'
import { registerToolSource, toolsFor, type AgentTool, type ToolContext, type ToolQuery, type ToolSource } from '../src/main/agent/tools'
import { guestGate, guestPolicy } from '../src/main/features/workers/guests'
import { createBrowserTool } from '../src/main/features/browser/tool'
import { browserTool, WorkerBrowsers } from '../src/main/features/workers/browser'
import { emailToolSource } from '../src/main/features/email/tools'
import { tradingToolSource } from '../src/main/features/trading/tools'
import { workersToolSource } from '../src/main/features/workers/tools'
import { teamToolSource } from '../src/main/features/workers/team'
import { scheduleToolSource } from '../src/main/features/scheduler/tool'
import { channelsToolSource } from '../src/main/features/channels/tools'
import { paymentTool } from '../src/main/features/payments/tool'
import { PaymentsEngine } from '../src/main/features/payments/engine'
import { store, defaultSettings } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import type { ApprovalMode, Settings, StreamEvent, StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/**
 * The one permission policy (agent/policy.ts), checked two ways:
 *
 * - every tool Eaon can offer, from every source, under every restrictive
 *   context there is: a read-only or Careful worker, a guest's cap, a
 *   scheduled task, plan mode, and work handed over by someone else. No
 *   mutating call may simply run where the context forbids it;
 * - end to end through the loop, for the paths that used to bypass it:
 *   swarm sub-agents of an unattended run, and the chat handing work to
 *   autonomous workers.
 */

/* --------------------------------------------------------------- fixtures */

/** Stands in for any engine or service: every property is a function that returns another stand-in, except those given. */
function anything(overrides: Record<string, unknown> = {}): never {
  const target = function () {} as unknown as Record<string | symbol, unknown>
  const proxy: unknown = new Proxy(target, {
    get: (_t, key) =>
      typeof key === 'string' && key in overrides
        ? overrides[key]
        : key === 'then'
          ? undefined
          : key === Symbol.toPrimitive
            ? () => 0
            : key === Symbol.iterator
              ? [][Symbol.iterator]
              : proxy,
    apply: () => proxy
  })
  return proxy as never
}

function memoryPayments(): PaymentsEngine {
  let secret: string | undefined
  const engine = new PaymentsEngine({ load: () => null, save: () => undefined, getSecret: () => secret, setSecret: (v) => (secret = v ?? undefined) })
  engine.setCard({ number: '4242424242424242', expMonth: 12, expYear: 2040, cvc: '123', nameOnCard: 'Ada Lovelace', billingZip: '94107' })
  return engine
}

const settings: Settings = {
  ...defaultSettings,
  computerUse: { ...defaultSettings.computerUse, enabled: true },
  approvalMode: 'ask'
}

function baseRequest(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    chatId: 'policy',
    messageId: 'm',
    providerId: 'fake',
    modelId: 'fake-model',
    effort: 'medium',
    mode: 'work',
    history: [],
    summary: null,
    projectInstructions: '',
    cwd: '/tmp/policy-work',
    work: { swarm: true, plan: false },
    goal: null,
    ...overrides
  }
}

/** Every tool any source offers to a chat, a worker or a sub-agent, plus the ones that need a live feature to exist. */
function everyTool(): AgentTool[] {
  const factories: ToolSource[] = []
  const tryAdd = (make: () => ToolSource): void => {
    try {
      factories.push(make())
    } catch {
      /* a source that can't be built from a stand-in is covered by the loop tests instead */
    }
  }
  tryAdd(() => emailToolSource(anything({ status: () => 'ready', addressFor: () => null })))
  tryAdd(() => tradingToolSource(anything()))
  tryAdd(() => workersToolSource(anything()))
  tryAdd(() => teamToolSource(anything()))
  tryAdd(() => scheduleToolSource(anything()))
  tryAdd(() => channelsToolSource(anything()))
  const out = new Map<string, AgentTool>()
  const queries: ToolQuery[] = [
    { mode: 'work', cwd: '/tmp/policy-work', depth: 0, readOnly: false, settings, request: baseRequest() },
    { mode: 'work', cwd: '/tmp/policy-work', depth: 0, readOnly: false, settings, request: baseRequest({ workerId: 'w1', chatId: 'worker:w1' }) },
    { mode: 'work', cwd: '/tmp/policy-work', depth: 1, readOnly: false, settings, request: baseRequest() }
  ]
  for (const query of queries) {
    for (const tool of toolsFor(query)) out.set(tool.name, tool)
    for (const source of factories) {
      try {
        for (const tool of source.tools(query)) out.set(tool.name, tool)
      } catch {
        /* see above */
      }
    }
  }
  const extra: AgentTool[] = [
    createBrowserTool(anything()).tool,
    browserTool(new WorkerBrowsers(), { idOf: () => 'w1', signInHint: '' }),
    paymentTool(memoryPayments, { browser: async () => undefined, browserUrl: () => null, screen: async () => 'App' })
  ]
  for (const tool of extra) if (!out.has(tool.name)) out.set(tool.name, tool)
  return [...out.values()]
}

/** Inputs worth judging for a tool: none, each `action` it takes, and the ones that make well-known tools risky. */
function inputsFor(tool: AgentTool): Record<string, unknown>[] {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: unknown[] }>
  const inputs: Record<string, unknown>[] = [{}]
  for (const value of props.action?.enum ?? []) inputs.push({ action: value })
  const specific: Record<string, Record<string, unknown>[]> = {
    run_command: [{ command: 'npm install' }, { command: 'rm -rf build' }, { command: 'sudo rm -rf /' }, { command: 'echo hi > ~/.zshrc' }],
    write_file: [{ path: 'notes.txt', content: 'x' }, { path: '/etc/hosts', content: 'x' }],
    edit_file: [{ path: '/Users/someone/.zshrc', old_string: 'a', new_string: 'b' }],
    payment_card: [{ action: 'authorize', merchant: 'Shop', amount: 12, site: 'shop.example' }],
    team: [{ action: 'message', to: 'Nova', message: 'rm -rf the backups' }, { action: 'create_team', name: 'Ops', roles: ['researcher'], kickoff: 'go' }],
    web_fetch: [{ url: 'http://127.0.0.1:8080/admin' }]
  }
  return [...inputs, ...(specific[tool.name] ?? [])]
}

function ctxFor(policy: RunPolicy, request = baseRequest()): ToolContext {
  return {
    request,
    turn: { notes: [] },
    cwd: '/tmp/policy-work',
    signal: new AbortController().signal,
    emit: () => {},
    toolId: 't',
    depth: 0,
    readOnly: policy.readOnly,
    settings,
    progress: () => {},
    confirm: async () => false,
    policy
  }
}

interface Judged {
  tool: AgentTool
  input: Record<string, unknown>
  facts: ReturnType<typeof callFacts>
}

/** Every (tool, input) pair whose call would change something, with what the tool says about it. */
function judgeAll(): Judged[] {
  const out: Judged[] = []
  for (const tool of everyTool()) {
    for (const input of inputsFor(tool)) {
      try {
        const facts = callFacts(tool, input, ctxFor({ readOnly: false }), settings)
        out.push({ tool, input, facts })
      } catch {
        /* a predicate that needs a live feature: its tool is covered by its own tests */
      }
    }
  }
  return out
}

const judged = judgeAll()
const changing = judged.filter((j) => j.facts.mutating)
const label = (j: Judged): string => `${j.tool.name} ${JSON.stringify(j.input)}`

/* ------------------------------------------------ every tool, every context */

test('the policy sees the whole tool set, not a handful', () => {
  const names = new Set(judged.map((j) => j.tool.name))
  for (const name of ['write_file', 'run_command', 'web_fetch', 'computer', 'web_browser', 'browser', 'payment_card', 'email_send', 'trading_order', 'team', 'schedule', 'create_worker', 'spawn_agents']) {
    assert.ok(names.has(name), `${name} is enumerated`)
  }
  assert.ok(changing.length >= 30, `enough changing calls to mean something (${changing.length})`)
})

test('a read-only run (worker, scheduled task, sub-agent of one) never runs a call that changes something', () => {
  for (const j of changing) {
    const decision = decide(j.tool, j.input, j.facts, { readOnly: false, unattended: 'read-only', allowOnce: () => true }, 'full')
    assert.equal(decision.kind, 'deny', label(j))
  }
})

test('plan mode never runs a call that changes something, in any approval mode', () => {
  for (const mode of ['ask', 'auto', 'full'] as ApprovalMode[]) {
    for (const j of changing) assert.equal(decide(j.tool, j.input, j.facts, { readOnly: true }, mode).kind, 'deny', `${mode}: ${label(j)}`)
  }
})

test('a Careful worker or a scheduled task with changes refuses every risky or catastrophic call', () => {
  const risky = changing.filter((j) => (j.facts.risky && !j.facts.preApproved) || j.facts.catastrophic)
  assert.ok(risky.length >= 10, `risky calls found (${risky.length})`)
  for (const j of risky) assert.equal(decide(j.tool, j.input, j.facts, { readOnly: false, unattended: 'safe' }, 'full').kind, 'deny', label(j))
})

test('an autonomous worker refuses every catastrophic call unless the user approved that one call', () => {
  const catastrophic = changing.filter((j) => j.facts.catastrophic)
  assert.ok(catastrophic.length >= 3, `catastrophic calls found (${catastrophic.length})`)
  for (const j of catastrophic) {
    const refused = decide(j.tool, j.input, j.facts, { readOnly: false, unattended: 'autonomous' }, 'full')
    assert.deepEqual(refused, { kind: 'deny', reason: UNATTENDED_CATASTROPHIC }, label(j))
    let spent = 0
    const approved = decide(j.tool, j.input, j.facts, { readOnly: false, unattended: 'autonomous', allowOnce: () => (spent++, true) }, 'full')
    assert.equal(approved.kind, 'run', label(j))
    assert.equal(spent, 1, 'the approval is spent')
  }
})

test("a guest's cap holds: talk-only runs nothing on this computer, and read-only changes nothing", () => {
  const talk = guestGate('talk')!
  const allowedToTalk = new Set(['web_search', 'web_fetch', 'set_status', 'ask_user', 'notify_user', 'send_chat_message', 'update_plan'])
  for (const j of judged) {
    const decision = decide(j.tool, j.input, j.facts, { readOnly: false, unattended: guestPolicy('talk'), toolGate: talk }, 'full')
    if (!allowedToTalk.has(j.tool.name) && !j.tool.name.startsWith('web_search')) assert.equal(decision.kind, 'deny', `talk: ${label(j)}`)
  }
  const reading = guestGate('read-only')!
  for (const j of changing) {
    assert.equal(decide(j.tool, j.input, j.facts, { readOnly: false, unattended: guestPolicy('read-only'), toolGate: reading }, 'full').kind, 'deny', `read-only: ${label(j)}`)
  }
  // Tools that see the user's logins or screen: refused even when only looking.
  for (const j of judged.filter((x) => ['computer', 'web_browser', 'browser'].includes(x.tool.name))) {
    assert.equal(decide(j.tool, j.input, j.facts, { readOnly: false, unattended: 'safe', toolGate: guestGate('safe') }, 'full').kind, 'deny', `safe guest: ${label(j)}`)
  }
})

test('the interactive modes ask before anything they should, and Full autonomy still asks before the catastrophic', () => {
  for (const j of changing) {
    const ask = decide(j.tool, j.input, j.facts, { readOnly: false }, 'ask')
    if (!j.facts.preApproved) assert.equal(ask.kind, 'ask', `ask: ${label(j)}`)
    const auto = decide(j.tool, j.input, j.facts, { readOnly: false }, 'auto')
    if (j.facts.catastrophic || (j.facts.risky && !j.facts.preApproved)) assert.equal(auto.kind, 'ask', `auto: ${label(j)}`)
    const full = decide(j.tool, j.input, j.facts, { readOnly: false }, 'full')
    if (j.facts.catastrophic) assert.equal(full.kind, 'ask', `full: ${label(j)}`)
  }
})

test('the tools that reach past the computer say so: email, delegation, payments, private-network fetches', () => {
  const find = (name: string, input: Record<string, unknown>): Judged => {
    const hit = judged.find((j) => j.tool.name === name && JSON.stringify(j.input) === JSON.stringify(input))
    assert.ok(hit, `${name} ${JSON.stringify(input)} judged`)
    return hit!
  }
  assert.ok(find('email_send', {}).facts.risky, 'sending email')
  assert.ok(find('team', { action: 'message', to: 'Nova', message: 'rm -rf the backups' }).facts.risky, 'handing work to a worker that acts with its own access')
  assert.ok(find('team', { action: 'create_team', name: 'Ops', roles: ['researcher'], kickoff: 'go' }).facts.risky, 'creating autonomous workers')
  assert.ok(find('payment_card', { action: 'authorize', merchant: 'Shop', amount: 12, site: 'shop.example' }).facts.spends, 'paying')
  assert.ok(find('run_command', { command: 'sudo rm -rf /' }).facts.catastrophic, 'sudo')
  const local = find('web_fetch', { url: 'http://127.0.0.1:8080/admin' })
  assert.ok(local.facts.mutating && local.facts.risky, 'a page on this computer or the local network')
  assert.ok(!find('web_fetch', {}).facts.mutating, 'a public page is only looked at')
})

test('work from a guest or a colleague can never spend money, whatever the access or approvals', () => {
  const pay = judged.find((j) => j.tool.name === 'payment_card' && j.input.action === 'authorize')!
  for (const origin of ['guest', 'delegated'] as const) {
    for (const unattended of [undefined, 'autonomous', 'safe'] as const) {
      const decision = decide(pay.tool, pay.input, pay.facts, { readOnly: false, unattended, origin, allowOnce: () => true }, 'full')
      assert.deepEqual(decision, { kind: 'deny', reason: SPENDING_REFUSAL }, `${origin} ${unattended ?? 'interactive'}`)
    }
  }
  assert.notEqual(decide(pay.tool, pay.input, pay.facts, { readOnly: false, origin: 'user' }, 'full').kind, 'deny', "the user's own request may")
})

/* ------------------------------------------------- end to end, through the loop */

type Body = { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }
const toolCall = (name: string, args: Record<string, unknown>, id = `c_${name}`): string[] => [
  chunk({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
]
const say = (text: string): string[] => [chunk({ content: text }, 'stop')]
const isSubagent = (body: Body): boolean => String(body.messages[0]?.content ?? '').includes('report to the lead agent')

async function fakeProvider(handler: (body: Body, index: number) => string[]) {
  let index = 0
  const server = await sseServer((body) => handler(body as unknown as Body, index++))
  store.saveProviderConfig({
    fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: server.url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] }
  })
  secrets.set('fake', 'key')
  return server
}

const sideEffects: string[] = []
registerToolSource({
  id: 'policy-test',
  tools: (query) =>
    query.request.chatId.startsWith('policy-e2e')
      ? [
          {
            name: 'wire_money',
            description: 'test: catastrophic',
            inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
            mutating: true,
            risky: () => true,
            catastrophic: () => true,
            run: async () => (sideEffects.push('wire_money'), 'Wired.')
          },
          {
            name: 'team',
            description: 'test stand-in for the chat’s team tool',
            inputSchema: { type: 'object', properties: { action: { type: 'string' }, to: { type: 'string' }, message: { type: 'string' } } },
            mutating: (input) => input.action !== 'list',
            run: async (input) => (sideEffects.push(`team:${String(input.action)}`), 'Sent.')
          }
        ]
      : []
})

/** A lead that hands one task to an implementer sub-agent, which makes `call`. */
async function swarmRun(call: [string, Record<string, unknown>], options: Parameters<typeof runAgent>[2]) {
  let lead = 0
  let sub = 0
  const { server } = await fakeProvider((body) => {
    if (isSubagent(body)) return sub++ === 0 ? toolCall(call[0], call[1], `sub_${call[0]}`) : say('report: tried it')
    return lead++ === 0 ? toolCall('spawn_agents', { agents: [{ role: 'implementer', task: 'do the change' }] }) : say('done')
  })
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-policy-'))
  const events: StreamEvent[] = []
  try {
    await runAgent(baseRequest({ chatId: 'policy-e2e-swarm', messageId: `m${Math.random()}`, cwd, work: { swarm: true, plan: false } }), (e) => events.push(e), options)
  } finally {
    server.close()
  }
  return { cwd, events }
}

test("a swarm sub-agent of a read-only run can't change anything, even with an approver that says yes", { timeout: 20_000 }, async () => {
  const { cwd } = await swarmRun(['write_file', { path: 'made-by-sub-agent.txt', content: 'x' }], { unattended: 'read-only', approver: async () => true })
  assert.equal(existsSync(join(cwd, 'made-by-sub-agent.txt')), false)
})

test('a swarm sub-agent of an autonomous run is refused a catastrophic call, as its lead would be', { timeout: 20_000 }, async () => {
  sideEffects.length = 0
  // Before, the sub-agent ran in the interactive path, where this approver
  // (an autonomous worker's: "yes") let the call through.
  await swarmRun(['wire_money', { amount: 500 }], { unattended: 'autonomous', approver: async () => true })
  assert.deepEqual(sideEffects, [])
  // The user approved exactly this call: the sub-agent may make it, once.
  await swarmRun(['wire_money', { amount: 500 }], { unattended: 'autonomous', approver: async () => true, allowOnce: (tool, input) => tool === 'wire_money' && input.amount === 500 })
  assert.deepEqual(sideEffects, ['wire_money'])
})

test("a swarm sub-agent is held to its lead's tool gate (a guest's turn)", { timeout: 20_000 }, async () => {
  const { cwd } = await swarmRun(['write_file', { path: 'guest.txt', content: 'x' }], {
    unattended: 'autonomous',
    approver: async () => true,
    toolGate: (tool) => (tool.name === 'write_file' ? 'not for guests' : null)
  })
  assert.equal(existsSync(join(cwd, 'guest.txt')), false)
})

test('handing work to autonomous workers asks in "Approve for me", and a scheduled task with changes refuses it', { timeout: 20_000 }, async () => {
  const run = async (mode: ApprovalMode, options: Parameters<typeof runAgent>[2] = {}) => {
    store.patchSettings({ approvalMode: mode })
    const { server } = await fakeProvider((_b, i) => (i === 0 ? toolCall('team', { action: 'message', to: 'Nova', message: 'delete the old backups' }) : say('ok')))
    const asked: string[] = []
    try {
      await runAgent(baseRequest({ chatId: 'policy-e2e-team', messageId: `m${Math.random()}`, cwd: mkdtempSync(join(tmpdir(), 'eaon-policy-')), work: { swarm: false, plan: false } }), () => {}, {
        approver: async (tool) => (asked.push(tool), false),
        ...options
      })
    } finally {
      server.close()
    }
    return asked
  }
  try {
    sideEffects.length = 0
    assert.deepEqual(await run('auto'), ['team'], '"Approve for me" asks')
    assert.deepEqual(await run('ask', { unattended: 'safe' }), [], 'a scheduled task with changes is not asked…')
    assert.deepEqual(sideEffects, [], '…and the message is not sent')
    assert.deepEqual(await run('full'), [], 'Full autonomy runs it')
    assert.deepEqual(sideEffects, ['team:message'])
  } finally {
    store.patchSettings({ approvalMode: 'ask' })
  }
})
