/**
 * The whole worker computer, end to end on this machine: the real host app
 * (out/host/eaon-host.tgz, built by `npm run build:host`) runs as its own
 * process under Node with its own home folder, and the desktop's feature
 * links to it, moves a worker there with its folder, talks to it through
 * the Workers tab's IPC while it thinks with a model this test serves, rides
 * out the host going away and coming back, and brings the worker home. Its
 * chat apps go there and come back with it.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import '../src/main/agent/sources'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { newHostSecret } from '../src/main/workerHost/channel'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import { createWorkerHost } from '../src/main/features/workerHost'
import { createChannels, type ChannelsHandle } from '../src/main/features/channels'
import { readAuthFiles, writeAuthFiles } from '../src/main/features/channels/whatsapp'
import type { ChannelLink } from '@shared/channels'
import type { FeatureContext } from '../src/main/features/types'
import type { WorkerHostState } from '@shared/workerHost'
import type { Worker, WorkerThread } from '@shared/workers'
import { chunk, sseServer } from './helpers'

const root = resolve(import.meta.dirname, '..', '..')
const packageDir = join(root, 'out', 'host')
const built = existsSync(join(packageDir, 'eaon-host.tgz'))
const scratch = mkdtempSync(join(tmpdir(), 'eaon-host-e2e-'))
const hostHome = join(scratch, 'host-user')
const hostAppHome = join(hostHome, '.eaon-host')
const quietLocals = { ollama: { enabled: false }, 'lm-studio': { enabled: false }, 'llama-cpp': { enabled: false }, mlx: { enabled: false }, vllm: { enabled: false }, jan: { enabled: false }, 'eaon-gateway': { enabled: false } }

async function until(check: () => boolean | Promise<boolean>, timeout = 20_000, what = 'condition'): Promise<void> {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

let host: ChildProcess | null = null
let hostLog = ''
function startHostProcess(): Promise<void> {
  host = spawn(process.execPath, [join(scratch, 'pkg', 'eaon-host', 'eaon-host-node.mjs')], {
    env: { ...process.env, HOME: hostHome, EAON_HOST_HOME: hostAppHome },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  host.stdout!.setEncoding('utf8').on('data', (c: string) => (hostLog += c))
  host.stderr!.setEncoding('utf8').on('data', (c: string) => (hostLog += c))
  return until(() => /EAON_HOST_READY/.test(hostLog), 30_000, `the host to start:\n${hostLog}`)
}
function stopHostProcess(): Promise<void> {
  const child = host
  host = null
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise((r) => {
    child.once('exit', () => r())
    child.kill('SIGTERM')
  })
}

/* The desktop: its workers service and the feature, with IPC as a map. */
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const sent: { channel: string; args: unknown[] }[] = []
const ctx = {
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  getWindow: () => null,
  getWindows: () => [],
  send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  emitStream: () => {}
} as unknown as FeatureContext
const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`nothing handles ${channel}`)
  return (await handler({ sender: { id: 1 } }, ...args)) as T
}

let service: WorkersService
let chats: ChannelsHandle
let feature: ReturnType<typeof createWorkerHost>
let model: Awaited<ReturnType<typeof sseServer>>
const desktopWork = join(scratch, 'desktop-work')

before(async () => {
  if (!built) return
  mkdirSync(join(scratch, 'pkg'), { recursive: true })
  execFileSync('tar', ['-xzf', join(packageDir, 'eaon-host.tgz'), '-C', join(scratch, 'pkg')])
  const port = await freePort()
  const secret = newHostSecret()
  mkdirSync(hostAppHome, { recursive: true })
  writeFileSync(join(hostAppHome, 'host.json'), JSON.stringify({ port, secret, name: 'Test Pi' }))
  await startHostProcess()

  // A model that answers like an OpenAI-compatible server, for both computers.
  model = await sseServer((body) => {
    const last = JSON.stringify((body.messages as unknown[]).slice(-1))
    return [chunk({ content: last.includes('notes.txt') ? 'I read your note on the Pi.' : 'Hello from the Pi.' }, 'stop')]
  })
  store.saveProviderConfig({ ...quietLocals, fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: model.url, models: [{ id: 'm1', label: 'M1', providerId: 'fake' }] } })
  secrets.set('fake', 'sk-fake-key')
  store.patchSettings({ selectedProviderId: 'fake', selectedModelId: 'm1', work: { ...store.getSettings().work, defaultFolder: desktopWork } })
  store.setJson('workers.json', [])

  service = createWorkersService(ctx, { startDelayMs: 60_000 })
  service.start()
  service.registerIpc()
  service.engine.start()
  chats = createChannels(ctx, service)
  chats.registerIpc()
  chats.start()

  // Linked earlier (as an install would leave it).
  secrets.set('worker-host:secret', secret)
  store.setJson('worker-host.json', {
    host: { id: 'h1', name: 'Test Pi', address: '127.0.0.1', port, platform: process.platform, arch: process.arch, linkedAt: Date.now(), via: 'ssh' },
    enabled: false,
    origins: {},
    backupAt: null,
    skillsHash: null
  })
  process.env.EAON_HOST_PACKAGE_DIR = packageDir
  feature = createWorkerHost(ctx, service, chats)
})

after(async () => {
  feature?.dispose()
  await chats?.stop()
  service?.stop()
  await stopHostProcess()
  model?.server.close()
  await store.flushWrites()
})

const state = (): Promise<WorkerHostState> => call<WorkerHostState>('worker-host:state')

test('a worker moves to the worker computer, works there, survives the host restarting, and comes home', { skip: !built && 'run npm run build:host first', timeout: 120_000 }, async () => {
  await until(async () => (await state()).connection === 'connected', 20_000, 'the link')
  const first = await state()
  assert.equal(first.hello?.name, 'Test Pi')
  assert.equal(first.hello?.runtime, 'node')
  // The keys went over: the host has the desktop's, but never the link's own secret.
  await until(async () => (await state()).hello?.synced === true, 10_000, 'the sync')
  const hostVault = JSON.parse(readFileSync(join(hostAppHome, 'data', 'keys.dat'), 'utf8')) as Record<string, string>
  assert.equal(hostVault.fake, 'sk-fake-key')
  assert.equal(hostVault['worker-host:secret'], undefined)

  // A worker here, with something in its folder.
  const nova = await call<Worker>('workers:save', { name: 'Nova', purpose: 'Research', personality: '', model: null, access: 'safe' })
  assert.ok(nova.folder.startsWith(desktopWork))
  writeFileSync(join(nova.folder, 'plan.md'), '# The plan')
  // And its chat apps: a Telegram bot and a WhatsApp number (off, so nothing here talks to either).
  const telegram = await call<ChannelLink>('channels:create', 'telegram', nova.id)
  secrets.set(`channel:${telegram.id}`, '123:telegram-token')
  store.setJson('channels.json', [...store.getJson<unknown[]>('channels.json', []), { id: 'l-wa', kind: 'whatsapp', workerId: nova.id, enabled: false }])
  chats.service.load()
  const userData = process.env.EAON_TEST_USERDATA!
  await writeAuthFiles(join(userData, 'channels', 'whatsapp-l-wa'), { 'creds.dat': '{"me":"nova"}' })

  // Move it.
  const moved = await call<WorkerHostState>('worker-host:set-enabled', true)
  assert.equal(moved.enabled, true)
  assert.deepEqual(store.getJson('workers.json', null), [])
  const there = await call<Worker[]>('workers:list')
  assert.equal(there.length, 1)
  assert.equal(there[0].folder, join(hostHome, 'Eaon', 'Workers', 'Nova'))
  assert.equal(readFileSync(join(there[0].folder, 'plan.md'), 'utf8'), '# The plan')

  // Its chat apps went too: none run here, Chat apps is answered there, and the host has the bot's token and the session.
  assert.equal(chats.suspended, true)
  const theirApps = await call<{ links: ChannelLink[] }>('channels:list')
  assert.deepEqual(
    theirApps.links.map((l) => [l.id, l.workerId]),
    [
      [telegram.id, nova.id],
      ['l-wa', nova.id]
    ]
  )
  const hostKeys = (): Record<string, string> => JSON.parse(readFileSync(join(hostAppHome, 'data', 'keys.dat'), 'utf8')) as Record<string, string>
  assert.equal(hostKeys()[`channel:${telegram.id}`], '123:telegram-token')
  assert.ok(existsSync(join(hostAppHome, 'data', 'channels', 'whatsapp-l-wa', 'creds.dat')))
  // What Settings → Chat apps refused before ("That worker no longer exists"): connecting a worker that lives there.
  sent.length = 0
  const discord = await call<ChannelLink>('channels:create', 'discord', nova.id)
  assert.equal(discord.workerId, nova.id)
  await until(() => sent.some((e) => e.channel === 'channels:changed'), 10_000, 'the host to tell the page')
  await call('channels:remove', discord.id)
  // A sync sends this computer's vault, which has its own copy of the token; the host keeps its own.
  await call('worker-host:sync')
  assert.equal(hostKeys()[`channel:${telegram.id}`], '123:telegram-token')

  // Talk to it, with a file from this computer: it thinks on the host with the synced model.
  const note = join(scratch, 'notes.txt')
  writeFileSync(note, 'buy milk')
  sent.length = 0
  await call('workers:send', nova.id, 'Read my note', [note], {})
  await until(() => sent.some((e) => e.channel === 'workers:message' && JSON.stringify(e.args).includes('I read your note on the Pi.')), 20_000, 'the reply')
  assert.ok(sent.some((e) => e.channel === 'workers:event'))
  const asked = JSON.stringify(model.requests[model.requests.length - 1])
  assert.ok(asked.includes(join(hostAppHome, 'uploads')), 'the file was uploaded and mailed at its path on the host')
  const thread = await call<WorkerThread>('workers:thread', nova.id)
  assert.equal(thread.messages.length, 2)

  // The host goes away: the tab shows what it last saw, and won't take changes.
  await stopHostProcess()
  await until(async () => (await state()).connection !== 'connected', 10_000, 'offline')
  assert.equal((await call<Worker[]>('workers:list'))[0].name, 'Nova')
  await assert.rejects(call('workers:send', nova.id, 'hello?', [], {}), /can’t be reached/)

  // It comes back by itself.
  hostLog = ''
  await startHostProcess()
  await until(async () => (await state()).connection === 'connected', 30_000, 'the link to come back')
  assert.equal((await call<Worker[]>('workers:list'))[0].id, nova.id)

  // Something the worker made there.
  writeFileSync(join(there[0].folder, 'report.md'), 'made on the Pi')

  // Home again: back in its own folder, with its thread and the new file.
  const home = await call<WorkerHostState>('worker-host:set-enabled', false)
  assert.equal(home.enabled, false)
  const back = await call<Worker[]>('workers:list')
  assert.equal(back[0].folder, nova.folder)
  assert.equal(readFileSync(join(nova.folder, 'report.md'), 'utf8'), 'made on the Pi')
  const backThread = await call<WorkerThread>('workers:thread', nova.id)
  assert.equal(backThread.messages.length, 2)
  assert.equal(service.suspended, false)
  // Its chat apps too, answering from here again; the host keeps no bot of theirs.
  assert.equal(chats.suspended, false)
  assert.deepEqual(
    (await call<{ links: ChannelLink[] }>('channels:list')).links.map((l) => l.id),
    [telegram.id, 'l-wa']
  )
  assert.equal(secrets.get(`channel:${telegram.id}`), '123:telegram-token')
  assert.deepEqual(await readAuthFiles(join(userData, 'channels', 'whatsapp-l-wa')), { 'creds.dat': '{"me":"nova"}' })
  assert.equal(hostKeys()[`channel:${telegram.id}`], undefined)
  assert.equal(existsSync(join(hostAppHome, 'data', 'channels', 'whatsapp-l-wa')), false)
  // And the host runs none.
  await until(async () => (await state()).hello?.workers === 0 || ((await feature.link.call<{ workers: number }>('hello')).workers === 0), 10_000, 'the host to let go')

  // A sign-in the host refreshed while this computer was away: this one's copy is spent, so it takes the host's.
  const signIn = (refresh: string, expires: number): string => JSON.stringify({ access: `a-${refresh}`, refresh, expires })
  secrets.set('oauth::openai-codex', signIn('r1', 1000))
  await call('worker-host:sync')
  const vaultFile = join(hostAppHome, 'data', 'keys.dat')
  const hostVault2 = JSON.parse(readFileSync(vaultFile, 'utf8')) as Record<string, string>
  assert.equal(JSON.parse(hostVault2['oauth::openai-codex']).refresh, 'r1')
  writeFileSync(vaultFile, JSON.stringify({ ...hostVault2, 'oauth::openai-codex': signIn('r2', 2000) }))
  await call('worker-host:sync')
  assert.equal(JSON.parse(secrets.get('oauth::openai-codex')!).refresh, 'r2')
  // And the host kept its own rather than taking back the spent one.
  assert.equal(JSON.parse((JSON.parse(readFileSync(vaultFile, 'utf8')) as Record<string, string>)['oauth::openai-codex']).refresh, 'r2')
  secrets.clear('oauth::openai-codex')

  const unlinked = await call<WorkerHostState>('worker-host:unlink', { removeApp: false })
  assert.equal(unlinked.host, null)
  assert.equal(secrets.get('worker-host:secret'), undefined)
})
