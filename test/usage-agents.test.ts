import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamEvent, StreamRequest } from '@shared/types'
import type { UsageAccountState, UsageSummary } from '@shared/usage'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import { usageFeature } from '../src/main/features/usage'
import {
  agentRunDays,
  agentRunSource,
  cleanAgentRuns,
  flushAgentRuns,
  MAX_RUN_MS,
  recordAgentRun,
  resetAgentRunsForTests,
  trackAgentRun
} from '../src/main/features/usage/agentRuns'
import { withUsageSource } from '../src/main/features/usage/attribution'
import { agentStats, MAX_AGENT_DAYS, syncAgents } from '../src/main/features/usage/rows'
import { signIn, signOut, toknPageUrl, upload } from '../src/main/features/usage/tokn'
import type { FeatureContext } from '../src/main/features/types'
import { secrets } from '../src/main/secrets'
import { store } from '../src/main/store'
import { chunk, sseServer } from './helpers'

/**
 * Agent runs for Settings → Usage and the Tokn profiles: what counts as one,
 * the local ledger of them, and the `agents` entries a Tokn sync uploads.
 * Tokn is faked at its endpoints; the models are a scripted local server.
 */

process.env.EAON_TOKN_HOST = 'https://tokn.test'
process.env.EAON_TOKNS_HOST = 'https://tokns.test'

function freshLedger(): void {
  resetAgentRunsForTests()
  store.setJson('agent-runs.json', {})
  resetAgentRunsForTests()
}

before(() => {
  store.patchSettings({ approvalMode: 'ask' })
})

/* ------------------------------------------------------------ the ledger */

test('a saved ledger keeps only whole days of totals, and never a run longer than the cap', () => {
  const clean = cleanAgentRuns({
    '2026-10-01': {
      work: { runs: 2, totalMs: 90_000.4, longestMs: 60_000 },
      trading: { runs: 5, totalMs: 1, longestMs: 1 },
      worker: { runs: '3', totalMs: 10, longestMs: 10 },
      chat: { runs: 1, totalMs: 1, longestMs: 3 * MAX_RUN_MS }
    },
    'not-a-day': { work: { runs: 1, totalMs: 1, longestMs: 1 } },
    '2026-10-02': 'junk'
  })
  assert.deepEqual(clean, {
    '2026-10-01': {
      work: { runs: 2, totalMs: 90_000, longestMs: 60_000 },
      chat: { runs: 1, totalMs: MAX_RUN_MS, longestMs: MAX_RUN_MS }
    }
  })
})

test('runs are counted under the day they started, add up, and survive a restart', () => {
  freshLedger()
  const late = new Date(2026, 9, 3, 23, 50)
  const now = new Date(2026, 9, 4, 0, 30)
  recordAgentRun('work', late, 40 * 60_000, now) // runs past midnight, but started on the 3rd
  recordAgentRun('work', new Date(2026, 9, 3, 9), 5 * 60_000, now)
  recordAgentRun('worker', new Date(2026, 9, 3, 10), 2 * 60_000, now)
  recordAgentRun('scheduled', now, Number.NaN, now)
  recordAgentRun('work', new Date(2026, 9, 4, 0, 5), 5 * MAX_RUN_MS, now)
  flushAgentRuns(now)
  resetAgentRunsForTests()
  const days = agentRunDays()
  assert.deepEqual(days['2026-10-03'], {
    work: { runs: 2, totalMs: 45 * 60_000, longestMs: 40 * 60_000 },
    worker: { runs: 1, totalMs: 2 * 60_000, longestMs: 2 * 60_000 }
  })
  assert.deepEqual(days['2026-10-04'], {
    scheduled: { runs: 1, totalMs: 0, longestMs: 0 },
    work: { runs: 1, totalMs: MAX_RUN_MS, longestMs: MAX_RUN_MS }
  })
})

test('days older than about 400 are pruned when the ledger is saved', () => {
  freshLedger()
  const now = new Date(2026, 9, 4, 12)
  recordAgentRun('work', new Date(2025, 0, 1, 12), 1000, now)
  recordAgentRun('work', new Date(2026, 9, 1, 12), 1000, now)
  flushAgentRuns(now)
  resetAgentRunsForTests()
  assert.deepEqual(Object.keys(agentRunDays()), ['2026-10-01'])
})

/* ------------------------------------------------------- what is a run */

test('what counts as an agent run, by mode, engine and what started it', () => {
  assert.equal(agentRunSource('work', false, 'chat'), 'work')
  assert.equal(agentRunSource('chat', false, 'chat'), null, 'a plain Chat reply is not an agent')
  assert.equal(agentRunSource('chat', true, 'chat'), 'chat', 'Chat on an agent engine is')
  assert.equal(agentRunSource('work', false, 'worker'), 'worker')
  assert.equal(agentRunSource('work', false, 'schedule'), 'scheduled')
  assert.equal(agentRunSource('chat', false, 'schedule'), null)
  assert.equal(agentRunSource('work', false, 'trading'), null)
  assert.equal(agentRunSource('work', false, 'gateway'), null)
})

test('a run is counted when it ends, and only if it called a tool', () => {
  freshLedger()
  const seen: StreamEvent[] = []
  const pass = (e: StreamEvent): void => void seen.push(e)

  const reply = trackAgentRun('work', pass)
  reply.emit({ type: 'delta', messageId: 'm', text: 'hi' })
  reply.finish()
  assert.deepEqual(agentRunDays(), {}, 'no tool, no agent')

  const run = trackAgentRun('work', pass)
  run.emit({ type: 'tool-call', messageId: 'm', toolId: 't', name: 'read_file', input: {} })
  assert.deepEqual(agentRunDays(), {}, 'not counted while still running')
  run.finish()
  run.finish()
  const today = Object.values(agentRunDays())[0]
  assert.equal(today?.work?.runs, 1, 'counted once')

  const none = trackAgentRun(null, pass)
  none.emit({ type: 'tool-call', messageId: 'm', toolId: 't2', name: 'read_file', input: {} })
  none.finish()
  assert.equal(Object.values(agentRunDays())[0]?.work?.runs, 1)
  assert.equal(seen.length, 3, 'every event is passed on')
})

/* -------------------------------------------- runAgent, against a fake model */

const toolCall = (name: string, args: Record<string, unknown>): string[] => [
  chunk({ tool_calls: [{ index: 0, id: `c_${name}`, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
]
const say = (text: string): string[] => [chunk({ content: text }, 'stop')]

function request(cwd: string, overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    chatId: 'c-agents',
    messageId: `m${Math.random()}`,
    providerId: 'fake-agents',
    modelId: 'fake-model',
    effort: 'medium',
    mode: 'work',
    history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'read the notes' }] }],
    summary: null,
    projectInstructions: '',
    cwd,
    work: { swarm: false, plan: false },
    goal: null,
    ...overrides
  }
}

test('runAgent: a Work task that used a tool is one agent run; a plain reply is none', async () => {
  freshLedger()
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-agents-'))
  writeFileSync(join(cwd, 'notes.txt'), 'hello')
  let index = 0
  // Each task: read a file, then answer. The plain replies just answer.
  const script = [toolCall('read_file', { path: 'notes.txt' }), say('Done.'), say('Hi there.'), toolCall('read_file', { path: 'notes.txt' }), say('Done.'), say('Hello.')]
  const { server, url } = await sseServer(() => script[index++] ?? say('…'))
  store.saveProviderConfig({
    'fake-agents': { name: 'Fake', kind: 'openai-compatible', baseUrl: url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake-agents' }] }
  })
  secrets.set('fake-agents', 'key')
  try {
    const work = await runAgent(request(cwd), () => {})
    assert.equal(work.error, undefined)
    await runAgent(request(cwd), () => {}) // answers without a tool
    await withUsageSource('worker', () => runAgent(request(cwd), () => {}))
    await runAgent(request(cwd, { mode: 'chat' }), () => {})
  } finally {
    server.close()
  }
  const days = Object.values(agentRunDays())
  assert.equal(days.length, 1)
  assert.equal(days[0].work?.runs, 1)
  assert.equal(days[0].worker?.runs, 1)
  assert.equal(days[0].chat, undefined)
})

/* ------------------------------------------------------------- the upload */

test('agents entries: one per day, every source together, the longest run kept', () => {
  const entries = syncAgents({
    '2026-10-02': { work: { runs: 2, totalMs: 1500, longestMs: 1000 }, worker: { runs: 3, totalMs: 9000, longestMs: 4000 } },
    '2026-10-01': { scheduled: { runs: 1, totalMs: 700, longestMs: 700 } },
    '2026-10-03': {}
  })
  assert.deepEqual(entries, [
    { day: '2026-10-01', tool: 'eaon', runs: 1, totalMs: 700, longestMs: 700 },
    { day: '2026-10-02', tool: 'eaon', runs: 5, totalMs: 10_500, longestMs: 4000 }
  ])
})

test('agents entries stop at Tokn’s limit, keeping the newest days', () => {
  const days: Record<string, { work: { runs: number; totalMs: number; longestMs: number } }> = {}
  for (let i = 0; i < MAX_AGENT_DAYS + 10; i++) {
    const day = new Date(2000, 0, 1 + i, 12)
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    days[key] = { work: { runs: 1, totalMs: 1, longestMs: 1 } }
  }
  const entries = syncAgents(days)
  assert.equal(entries.length, MAX_AGENT_DAYS)
  assert.equal(entries.at(-1)!.day, Object.keys(days).sort().at(-1))
})

test('Settings → Usage: Agents counts every run, and Longest agent the longest and its day', () => {
  const stats = agentStats(
    {
      '2026-08-01': { work: { runs: 4, totalMs: 4_000_000, longestMs: 3_000_000 } },
      '2026-10-02': { work: { runs: 2, totalMs: 120_000, longestMs: 100_000 }, worker: { runs: 1, totalMs: 50_000, longestMs: 50_000 } }
    },
    7,
    new Date(2026, 9, 3, 15)
  )
  assert.deepEqual(stats, { runs: 7, runsInRange: 3, totalMs: 4_170_000, longestMs: 3_000_000, longestDay: '2026-08-01' })
  assert.deepEqual(agentStats({}, 30), { runs: 0, runsInRange: 0, totalMs: 0, longestMs: 0, longestDay: null })
})

const realFetch = globalThis.fetch
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

function withFetch(fake: (url: string, init: RequestInit | undefined) => Response | undefined): () => void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return fake(url, init) ?? realFetch(input, init)
  }) as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

/** Plays the browser: approves on Tokn's page by following the redirect with a code. */
function approve(code: string): (url: string) => void {
  return (url) => {
    const authorize = new URL(url)
    const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', authorize.searchParams.get('state')!)
    setTimeout(() => void realFetch(redirect), 10)
  }
}

test('the upload carries agents only when there are some', async () => {
  await signOut()
  const bodies: Record<string, unknown>[] = []
  const restore = withFetch((url, init) => {
    if (url === 'https://tokn.test/api/oauth/token') return json({ access_token: 'tok_agents', user: { id: 'u_9', handle: 'alex' } })
    if (url === 'https://tokn.test/api/cli/sync') {
      bodies.push(JSON.parse(String(init?.body)))
      return json({ accepted: 0 })
    }
    return undefined
  })
  try {
    await signIn(approve('c-agents'), new AbortController().signal)
    await upload([], 'UTC')
    await upload([], 'UTC', [{ day: '2026-10-01', tool: 'eaon', runs: 1, totalMs: 5, longestMs: 5 }])
    assert.equal('agents' in bodies[0], false)
    assert.deepEqual(bodies[1].agents, [{ day: '2026-10-01', tool: 'eaon', runs: 1, totalMs: 5, longestMs: 5 }])
  } finally {
    restore()
    await signOut()
  }
})

test('profile links: Tokn, the Eaon profile and the Eaon leaderboard', () => {
  const account = { id: 'u_9', handle: 'alex', profileUrl: 'https://tokn.test/profile/alex' }
  assert.equal(toknPageUrl('profile', account), 'https://tokn.test/profile/alex')
  assert.equal(toknPageUrl('eaon-profile', account), 'https://tokns.test/@alex')
  assert.equal(toknPageUrl('leaderboard', account), 'https://tokns.test/')
  assert.equal(toknPageUrl('profile', null), 'https://tokn.test')
  assert.equal(toknPageUrl('eaon-profile', null), 'https://tokns.test/')
})

test('the account entry and Sync now: signed in, a sync sends the day’s agents with the rows', async () => {
  await signOut()
  freshLedger()
  store.setJson('usage-ledger.json', {})
  store.setJson('tokn-pricing.json', { fetchedAt: Date.now(), models: { 'claude-opus-5': { input: 5, output: 25 } } })
  recordAgentRun('work', new Date(), 90_000)

  const uploads: { rows: unknown[]; agents?: { runs: number; longestMs: number; tool: string }[] }[] = []
  const opened: string[] = []
  const restore = withFetch((url, init) => {
    if (url === 'https://tokn.test/api/oauth/token') return json({ access_token: 'tok_entry', user: { id: 'u_8', handle: 'alex', name: 'Alex' } })
    if (url === 'https://tokn.test/api/cli/sync') {
      uploads.push(JSON.parse(String(init?.body)))
      return json({ accepted: 0 })
    }
    if (url === 'https://tokn.test/api/cli/me') return json({ user: { id: 'u_8', handle: 'alex', name: 'Alex' } })
    if (url === 'https://tokn.test/api/cli/pricing') return json({ models: {} })
    return undefined
  })
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const hooks = globalThis as { __eaonOpenExternal?: (url: string) => void }
  const browser = approve('c-entry')
  hooks.__eaonOpenExternal = (url) => (url.includes('/oauth/authorize') ? browser(url) : void opened.push(url))
  usageFeature.register({
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
    getWindow: () => null,
    getWindows: () => [],
    send: () => {},
    emitStream: () => {}
  } as unknown as FeatureContext)
  try {
    assert.equal(((await handlers.get('usage:account')!()) as UsageAccountState).account, null)
    await handlers.get('usage:sign-in')!()
    const state = (await handlers.get('usage:account')!()) as UsageAccountState
    assert.equal(state.account?.handle, 'alex')
    assert.equal(state.account?.name, 'Alex')

    await handlers.get('usage:sync')!()
    const last = uploads.at(-1)!
    assert.deepEqual(last.rows, [], 'no model use counted, but the agents still go up')
    assert.equal(last.agents?.length, 1)
    assert.deepEqual({ ...last.agents![0], day: undefined }, { day: undefined, tool: 'eaon', runs: 1, totalMs: 90_000, longestMs: 90_000 })

    const summary = (await handlers.get('usage:summary')!(null, 7)) as UsageSummary
    assert.equal(summary.agents.runs, 1)
    assert.equal(summary.agents.longestMs, 90_000)

    await handlers.get('usage:open-profile')!(null, 'eaon-profile')
    await handlers.get('usage:open-profile')!(null, 'leaderboard')
    await handlers.get('usage:open-profile')!(null)
    assert.deepEqual(opened, ['https://tokns.test/@alex', 'https://tokns.test/', 'https://tokn.test/profile/alex'])
  } finally {
    restore()
    delete hooks.__eaonOpenExternal
    await handlers.get('usage:sign-out')?.()
    usageFeature.dispose?.()
  }
})
