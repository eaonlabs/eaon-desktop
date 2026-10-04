import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secrets } from '../src/main/secrets'
import { store } from '../src/main/store'
import type { Chat } from '@shared/types'
import { cbcKey, decryptCbc, decryptForeign, decryptGcm, encryptCbc, LINUX_ROUNDS, MAC_ROUNDS } from '../cli/src/runtime/osCrypt'
import {
  continueDesktopChat,
  declineFirstRunImport,
  desktopChats,
  desktopTradingSnapshot,
  findDesktop,
  firstRunImportState,
  importFromDesktop,
  planImport
} from '../cli/src/core/desktop'
import { chatStore } from '../cli/src/core/chats'

/**
 * The CLI's desktop import, against a fixture desktop folder. The CLI side
 * writes into the test stub's userData (electron is aliased to
 * test/stubs/electron.ts), and `EAON_DESKTOP_DATA` points the desktop side at
 * the fixture — nothing touches the real app or the real CLI profile.
 */

const root = mkdtempSync(join(tmpdir(), 'eaon-cli-desktop-'))
const desktop = join(root, 'Eaon')
const desktopStore = join(desktop, 'store')
const writeDesktop = (name: string, value: unknown): void => writeFileSync(join(desktopStore, name), JSON.stringify(value))

const chat = (id: string, title: string, updatedAt: number, archived = false): Chat => ({
  id,
  workspaceId: 'work',
  projectId: 'p1',
  title,
  messages: [{ id: `${id}-m1`, role: 'user', parts: [{ type: 'text', text: 'hello' }], createdAt: updatedAt }],
  createdAt: updatedAt,
  updatedAt,
  archived,
  pinned: false,
  unread: true,
  modelId: 'gpt-x',
  effort: 'medium'
})

function buildFixture(): void {
  rmSync(desktop, { recursive: true, force: true })
  mkdirSync(desktopStore, { recursive: true })
  // A plaintext vault: what the desktop writes while no keychain is available.
  writeFileSync(
    join(desktop, 'keys.dat'),
    JSON.stringify({ openai: 'sk-desktop-openai', anthropic: 'sk-desktop-anthropic', 'trading:alpaca-paper:key': 'PK123', 'mcp-oauth:notion': '{"t":1}', empty: '' })
  )
  writeDesktop('providers.json', { openai: { enabled: true, baseUrl: 'https://desktop.example/v1' }, 'my-endpoint': { name: 'Mine', baseUrl: 'http://localhost:9000/v1' } })
  writeDesktop('settings.json', {
    selectedModelId: 'claude-desktop',
    selectedProviderId: 'anthropic',
    effort: 'high',
    approvalMode: 'auto',
    favoriteModels: ['claude-desktop'],
    appearance: { mode: 'light' },
    shortcuts: { 'new-chat': 'X' }
  })
  writeDesktop('mcp.json', [
    { id: 'filesystem', name: 'Filesystem', transport: 'stdio', command: 'npx', args: [], env: {}, url: '', enabled: true, official: true },
    { id: 'github', name: 'GitHub', transport: 'http', command: '', args: [], env: {}, url: 'https://mcp.github.example', enabled: true, official: false }
  ])
  writeDesktop('chats.json', [chat('c-old', 'Older chat', 1000), chat('c-new', 'Newer chat', 5000), chat('c-gone', 'Archived', 9000, true)])
  writeDesktop('trading-config.json', {
    broker: 'simulator',
    limits: { maxOrderUsd: 1500, maxPositionPct: 25, maxDailyLossPct: 3, maxOrdersPerDay: 10, maxInvestedPct: 70, allowedSymbols: [] },
    simulatorCash: 50000,
    simulatorAnytime: true,
    liveConfirmedAt: 1_700_000_000_000,
    model: null,
    halted: false
  })
  writeDesktop('trading-schedules.json', [
    { id: 's1', name: 'Mornings', days: [1, 2, 3, 4, 5], start: '09:30', end: '11:00', strategy: 'Momentum on QQQ', everyMinutes: 15, flattenAtEnd: true, enabled: true, createdAt: 1 },
    { id: 's2', name: 'Off one', days: [1], start: '13:00', end: '14:00', strategy: 'Mean reversion', everyMinutes: 30, flattenAtEnd: false, enabled: false, createdAt: 2 }
  ])
  writeDesktop('trading-orders.json', [
    {
      id: 'o2',
      broker: 'simulator',
      symbol: 'AAPL',
      side: 'sell',
      type: 'market',
      qty: 5,
      status: 'filled',
      filledQty: 5,
      filledAvgPrice: 210,
      submittedAt: 2000,
      filledAt: 2000,
      realizedPl: 50,
      source: 'session',
      reason: 'Took profit'
    },
    {
      id: 'o1',
      broker: 'simulator',
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      qty: 5,
      status: 'filled',
      filledQty: 5,
      filledAvgPrice: 200,
      submittedAt: 1000,
      filledAt: 1000,
      realizedPl: null,
      source: 'agent',
      reason: 'Breakout'
    }
  ])
  writeDesktop('trading-equity.json', { simulator: { start: 50000, points: [{ at: 1000, equity: 50000 }, { at: 2000, equity: 50050 }] } })
}

before(() => {
  process.env.EAON_DESKTOP_DATA = desktop
})

beforeEach(() => buildFixture())

after(() => {
  rmSync(root, { recursive: true, force: true })
})

/* --------------------------------------------------------------- osCrypt */

test('CBC values round-trip with the Linux and macOS key derivations', () => {
  for (const [password, rounds] of [
    ['peanuts', LINUX_ROUNDS],
    ['a-keychain-password', MAC_ROUNDS]
  ] as const) {
    const key = cbcKey(password, rounds)
    const sealed = encryptCbc('{"openai":"sk-1"}', key)
    assert.equal(sealed.subarray(0, 3).toString(), 'v10')
    assert.equal(decryptCbc(sealed, key), '{"openai":"sk-1"}')
    assert.throws(() => decryptCbc(sealed, cbcKey('wrong', rounds)))
  }
})

test('GCM values decrypt the way Windows Chromium writes them', () => {
  const key = randomBytes(32)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update('{"anthropic":"sk-2"}', 'utf8'), cipher.final()])
  const sealed = Buffer.concat([Buffer.from('v10'), nonce, body, cipher.getAuthTag()])
  assert.equal(decryptGcm(sealed, key), '{"anthropic":"sk-2"}')
  assert.throws(() => decryptGcm(sealed, randomBytes(32)))
})

test('decryptForeign passes a plaintext vault through unchanged', async () => {
  assert.equal(await decryptForeign(Buffer.from('{"a":"b"}'), 'Eaon', desktop), '{"a":"b"}')
})

/* ------------------------------------------------------------ finding it */

test('findDesktop is null without a store folder, and lists the store otherwise', () => {
  process.env.EAON_DESKTOP_DATA = join(root, 'nowhere')
  try {
    assert.equal(findDesktop(), null)
  } finally {
    process.env.EAON_DESKTOP_DATA = desktop
  }
  const info = findDesktop()
  assert.ok(info)
  assert.equal(info.home, desktop)
  assert.equal(info.hasKeys, true)
  assert.ok(info.files.includes('settings.json'))
  assert.ok(info.files.includes('trading-orders.json'))
  assert.equal(info.running, false)
})

test('the SingletonLock counts as running only while its pid is alive', { skip: process.platform === 'win32' }, () => {
  const lock = join(desktop, 'SingletonLock')
  symlinkSync(`somehost.local-${process.pid}`, lock)
  assert.equal(findDesktop()?.running, true)
  rmSync(lock)
  // A pid that cannot exist: a lock left behind by a crash.
  symlinkSync('somehost.local-2147483646', lock)
  assert.equal(findDesktop()?.running, false)
  rmSync(lock)
})

/* -------------------------------------------------------------- reading it */

test('planImport counts what would come over without decrypting', () => {
  const plan = planImport()
  assert.equal(plan.keys, 4)
  assert.equal(plan.providers, 2)
  assert.equal(plan.mcpServers, 1)
  assert.equal(plan.settings, true)
  assert.deepEqual(plan.trading, { config: true, schedules: 2 })
})

test('planImport reports an encrypted vault as an unknown count', () => {
  writeFileSync(join(desktop, 'keys.dat'), Buffer.concat([Buffer.from('v10'), randomBytes(32)]))
  assert.equal(planImport().keys, null)
})

test('desktopChats leaves archived chats out and puts the newest first', () => {
  assert.deepEqual(
    desktopChats().map((c) => c.id),
    ['c-new', 'c-old']
  )
})

test('desktopTradingSnapshot reads the ledger without touching the network', () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => {
    throw new Error('no network in this test')
  }) as typeof fetch
  try {
    const snapshot = desktopTradingSnapshot()
    assert.ok(snapshot)
    assert.equal(snapshot.config.broker, 'simulator')
    assert.equal(snapshot.orders.length, 2)
    assert.equal(snapshot.orders[0].reason, 'Took profit')
    assert.equal(snapshot.account, null)
    assert.equal(snapshot.stats.trades, 1)
    assert.equal(snapshot.equity.length, 2)
    assert.equal(snapshot.schedules.length, 2)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('desktopTradingSnapshot is null with no trading files', () => {
  for (const name of ['trading-config.json', 'trading-schedules.json', 'trading-orders.json', 'trading-equity.json']) rmSync(join(desktopStore, name))
  assert.equal(desktopTradingSnapshot(), null)
})

test('continueDesktopChat copies a chat into the CLI store under a new id', async () => {
  const copy = continueDesktopChat('c-new')
  assert.ok(copy)
  assert.notEqual(copy.id, 'c-new')
  assert.equal(copy.title, 'Newer chat')
  assert.equal(copy.workspaceId, 'work')
  assert.equal(copy.projectId, null)
  assert.equal(copy.origin, 'desktop')
  await chatStore.flush()
  const saved = chatStore.load(copy.id)
  assert.equal(saved?.messages.length, 1)
  assert.ok(chatStore.list().some((c) => c.id === copy.id && c.origin === 'desktop'))
  assert.equal(continueDesktopChat('no-such-chat'), null)
})

/* ------------------------------------------------------------ importing */

test('importFromDesktop brings keys, providers, settings, MCP servers and trading across', async () => {
  secrets.set('openai', 'sk-cli-old')
  secrets.set('cli-only', 'keep-me')
  store.saveProviderConfig({ openai: { baseUrl: 'https://cli.example/v1' }, groq: { enabled: false } })
  store.saveMcpServers([{ id: 'github', name: 'Old GitHub', transport: 'http', command: '', args: [], env: {}, url: 'https://old.example', enabled: false, official: false }])
  store.patchSettings({ appearance: { ...store.getSettings().appearance, mode: 'dark' } })

  const statuses: string[] = []
  const report = await importFromDesktop({ keys: true, providers: true, settings: true, mcp: true, trading: true }, { onStatus: (line) => statuses.push(line) })
  assert.deepEqual(report.errors, [])

  // Keys: the desktop wins, CLI-only keys stay, empties are skipped, and the report holds counts only.
  assert.deepEqual(report.keys, { added: 3, updated: 1 })
  assert.equal(secrets.get('openai'), 'sk-desktop-openai')
  assert.equal(secrets.get('anthropic'), 'sk-desktop-anthropic')
  assert.equal(secrets.get('trading:alpaca-paper:key'), 'PK123')
  assert.equal(secrets.get('cli-only'), 'keep-me')
  assert.equal(secrets.get('empty'), undefined)
  assert.ok(!JSON.stringify(report).includes('sk-desktop'))
  assert.ok(!statuses.join('\n').includes('sk-desktop'))

  // Providers: merged per id, desktop wins.
  assert.equal(report.providers, 2)
  const providers = store.getProviderConfig()
  assert.equal(providers.openai.baseUrl, 'https://desktop.example/v1')
  assert.equal(providers['my-endpoint'].name, 'Mine')
  assert.equal(providers.groq.enabled, false)

  // Settings: model and agent choices only.
  assert.equal(report.settings, true)
  const settings = store.getSettings()
  assert.equal(settings.selectedModelId, 'claude-desktop')
  assert.equal(settings.effort, 'high')
  assert.equal(settings.approvalMode, 'auto')
  assert.equal(settings.appearance.mode, 'dark')
  assert.notEqual(settings.shortcuts['new-chat'], 'X')

  // MCP: the bundled server is skipped, a user's server replaces the CLI's copy.
  assert.equal(report.mcpServers, 1)
  const github = store.getMcpServers().find((s) => s.id === 'github')
  assert.equal(github?.url, 'https://mcp.github.example')

  // Trading: real money has to be confirmed again, and every schedule starts off.
  assert.deepEqual(report.trading, { config: true, schedules: 2, disabled: 1 })
  const config = store.getJson<{ liveConfirmedAt: number | null; simulatorCash: number }>('trading-config.json', { liveConfirmedAt: 1, simulatorCash: 0 })
  assert.equal(config.liveConfirmedAt, null)
  assert.equal(config.simulatorCash, 50000)
  const schedules = store.getJson<{ id: string; enabled: boolean }[]>('trading-schedules.json', [])
  assert.equal(schedules.length, 2)
  assert.ok(schedules.every((s) => s.enabled === false))
  // The ledger stays the desktop's.
  assert.equal(store.getJson('trading-orders.json', null), null)

  assert.equal(firstRunImportState(), 'done')

  // Importing again changes nothing and doesn't duplicate schedules.
  const again = await importFromDesktop({ keys: true, providers: false, settings: false, mcp: false, trading: true })
  assert.deepEqual(again.keys, { added: 0, updated: 0 })
  assert.equal(store.getJson<unknown[]>('trading-schedules.json', []).length, 2)
})

test('a part that fails is reported and the others still import', async () => {
  writeFileSync(join(desktop, 'keys.dat'), 'not json at all')
  const report = await importFromDesktop({ keys: true, providers: true, settings: false, mcp: false, trading: false })
  assert.equal(report.errors.length, 1)
  assert.match(report.errors[0], /^Keys: /)
  assert.ok(report.keys?.error)
  assert.equal(report.providers, 2)
})

test('first-run state follows the marker and whether the desktop exists', () => {
  store.setJson('desktop-import.json', null)
  assert.equal(firstRunImportState(), 'ask')
  declineFirstRunImport()
  assert.equal(firstRunImportState(), 'declined')
  store.setJson('desktop-import.json', null)
  process.env.EAON_DESKTOP_DATA = join(root, 'nowhere')
  try {
    assert.equal(firstRunImportState(), 'no-desktop')
  } finally {
    process.env.EAON_DESKTOP_DATA = desktop
  }
})
