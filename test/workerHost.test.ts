import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import '../src/main/agent/sources'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { connect, listen, newHostSecret, type LinkServer, type Peer } from '../src/main/workerHost/channel'
import { inside, listFolder, readSnapshot, relocate, rewritePaths, writeSnapshot } from '../src/main/workerHost/move'
import { installOutput, installOverSsh, pairingScript, remoteInstallCommand, sshProblem, startPairingServer } from '../src/main/workerHost/install'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import type { RunAgent } from '../src/main/features/workers/runner'
import type { FeatureContext } from '../src/main/features/types'
import { createHost } from '../src/host/host'
import { broadcast, ipc, senderFor } from '../src/host/ipc'
import { applySync, pickSettings } from '../src/host/sync'
import { tokenStore } from '../src/main/providers/oauth/shared'
import { createWorkerHost } from '../src/main/features/workerHost'
import { createChannels, type ChannelsHandle } from '../src/main/features/channels'
import type { ChannelLink, ChannelStatus } from '@shared/channels'
import { credentialExpiry, hostServesChannel, signInEntries, WORKER_HOST_PATH } from '@shared/workerHost'
import type { Worker } from '@shared/workers'

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
const scratch = mkdtempSync(join(tmpdir(), 'eaon-worker-host-'))
const quietLocals = { ollama: { enabled: false }, 'lm-studio': { enabled: false }, 'llama-cpp': { enabled: false }, mlx: { enabled: false }, vllm: { enabled: false }, jan: { enabled: false }, 'eaon-gateway': { enabled: false } }

before(() => {
  store.setJson('workers.json', [])
  // Workers' folders go in the scratch folder, never the real home; a model is there for the turn to start.
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: join(scratch, 'work') }, selectedProviderId: 'fake', selectedModelId: 'big-model' })
  store.saveProviderConfig({ ...quietLocals, fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', models: [{ id: 'big-model', label: 'Big', providerId: 'fake' }] } })
  secrets.set('fake', 'key')
})

async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/* ------------------------------------------------------------------ link */

let server: LinkServer | null = null
const peers: Peer[] = []
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close()
  await server?.close()
  server = null
})

async function pair(secret = newHostSecret(), clientSecret = secret): Promise<{ host: Peer; desktop: Peer }> {
  let host: Peer | null = null
  server = await listen({ port: 0, host: '127.0.0.1', secret: () => secret, onPeer: (peer) => (host = peer) })
  const desktop = await connect({ address: '127.0.0.1', port: server.port, secret: clientSecret })
  await until(() => host !== null)
  peers.push(desktop, host!)
  return { host: host!, desktop }
}

test('the link: calls, replies, errors and events go both ways once both sides prove the secret', async () => {
  const { host, desktop } = await pair()
  host.handle((method, params) => {
    if (method === 'add') return (params as { a: number; b: number }).a + (params as { a: number; b: number }).b
    throw new Error(`no ${method}`)
  })
  assert.equal(await desktop.call('add', { a: 2, b: 3 }), 5)
  await assert.rejects(desktop.call('nope'), /no nope/)
  const heard: unknown[] = []
  desktop.onEvent((name, data) => heard.push([name, data]))
  host.emit('ipc', { channel: 'workers:changed', args: [[1]] })
  await until(() => heard.length === 1)
  assert.deepEqual(heard[0], ['ipc', { channel: 'workers:changed', args: [[1]] }])
  // The desktop serves calls too (not used today, but the RPC is symmetrical).
  desktop.handle(() => 'pong')
  assert.equal(await host.call('ping'), 'pong')
})

test('the link refuses a wrong secret, an impostor host and a web page', async () => {
  const secret = newHostSecret()
  server = await listen({ port: 0, host: '127.0.0.1', secret: () => secret, onPeer: () => assert.fail('no peer for a wrong secret') })
  await assert.rejects(connect({ address: '127.0.0.1', port: server.port, secret: newHostSecret() }), /link key doesn’t match/)
  // A page in a browser carries an Origin.
  const page = new WebSocket(`ws://127.0.0.1:${server.port}${WORKER_HOST_PATH}`, { headers: { Origin: 'https://evil.example' } })
  const code = await new Promise<number>((resolve) => page.on('close', (c) => resolve(c)))
  assert.equal(code, 1008)
  await server.close()

  // A host that doesn't hold the secret can't pass itself off as ours, even if it accepts anything.
  const impostor = new (await import('ws')).WebSocketServer({ port: 0, host: '127.0.0.1', path: WORKER_HOST_PATH })
  impostor.on('connection', (socket) => {
    socket.send(JSON.stringify({ t: 'hello', v: 'eaon-host-1', nonce: Buffer.alloc(32, 7).toString('base64') }))
    socket.once('message', () => socket.send(JSON.stringify({ t: 'ok', mac: Buffer.alloc(32).toString('base64') })))
  })
  await new Promise((r) => impostor.once('listening', r))
  const port = (impostor.address() as { port: number }).port
  await assert.rejects(connect({ address: '127.0.0.1', port, secret }), /isn’t the worker computer/)
  await new Promise((r) => impostor.close(r))
  server = null
})

test('the link turns an address away after ten wrong secrets, even with the right one', async () => {
  const secret = newHostSecret()
  server = await listen({ port: 0, host: '127.0.0.1', secret: () => secret, onPeer: (peer) => peers.push(peer) })
  for (let i = 0; i < 10; i++) await assert.rejects(connect({ address: '127.0.0.1', port: server.port, secret: newHostSecret() }))
  await assert.rejects(connect({ address: '127.0.0.1', port: server.port, secret }))
})

test('a port that never answers (a firewall dropping it) says so, and how to open it', async () => {
  // Takes the connection and says nothing, as far as the desktop can tell like a dropped one.
  const sockets: import('node:net').Socket[] = []
  const silent = (await import('node:net')).createServer((socket) => sockets.push(socket))
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()))
  const port = (silent.address() as { port: number }).port
  try {
    await assert.rejects(connect({ address: '127.0.0.1', port, secret: newHostSecret(), timeoutMs: 500 }), (error: Error) => {
      assert.match(error.message, new RegExp(`Nothing answered on port ${port}`))
      assert.match(error.message, new RegExp(`sudo ufw allow ${port}/tcp`))
      return true
    })
  } finally {
    for (const socket of sockets) socket.destroy()
    silent.close()
  }
})

test('a frame that was changed, replayed or not sealed ends the link', async () => {
  const { host, desktop } = await pair()
  host.handle(() => 'fine')
  assert.equal(await desktop.call('x'), 'fine')
  const closed = new Promise<string>((resolve) => host.onClose(resolve))
  // Straight onto the socket, as someone on the network could.
  ;(desktop as unknown as { socket: WebSocket }).socket.send(Buffer.alloc(64, 1))
  assert.match(await closed, /failed to open/)
})

test('nothing secret crosses the wire: the secret and the payload are not in the bytes', async () => {
  const secret = newHostSecret()
  const seen: Buffer[] = []
  const realSend = WebSocket.prototype.send
  WebSocket.prototype.send = function (this: WebSocket, data: unknown, ...rest: unknown[]) {
    seen.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
    return (realSend as (...a: unknown[]) => void).call(this, data, ...rest)
  } as typeof WebSocket.prototype.send
  try {
    const { host, desktop } = await pair(secret)
    host.handle((_m, params) => params)
    await desktop.call('sync', { secrets: { anthropic: 'sk-ant-SUPERSECRETKEY' } })
  } finally {
    WebSocket.prototype.send = realSend
  }
  const all = Buffer.concat(seen).toString('latin1')
  assert.ok(seen.length >= 4)
  assert.ok(!all.includes('SUPERSECRETKEY'))
  assert.ok(!all.includes(secret))
  assert.ok(!all.includes(Buffer.from(secret, 'base64url').toString('base64')))
})

/* ----------------------------------------------------------------- moving */

test('rewritePaths and relocate move each worker’s folder and every path into it', () => {
  const snapshot = {
    workers: [
      { id: 'a', name: 'Nova', folder: '/Users/me/Eaon/Workers/Nova', jobs: [{ log: '/Users/me/Eaon/Workers/Nova/.jobs/x.log' }] },
      { id: 'b', name: 'Nova two', folder: '/Users/me/Elsewhere/Nova' },
      { id: 'c', name: 'Bare', folder: '' }
    ],
    threads: { a: { messages: [{ text: 'saved /Users/me/Eaon/Workers/Nova/notes.md' }] } },
    rooms: { rooms: [], posts: { r: [{ text: 'see /Users/me/Eaon/Workers/Nova/a.txt' }] }, seen: {} }
  }
  const { snapshot: moved, moves } = relocate(snapshot, '/home/pi/Eaon/Workers', {}, '/')
  assert.deepEqual(
    moves.map((m) => m.to),
    ['/home/pi/Eaon/Workers/Nova', '/home/pi/Eaon/Workers/Nova-2', '/home/pi/Eaon/Workers/c']
  )
  const [a, b, c] = moved.workers as { folder: string; jobs?: { log: string }[] }[]
  assert.equal(a.folder, '/home/pi/Eaon/Workers/Nova')
  assert.equal(a.jobs![0].log, '/home/pi/Eaon/Workers/Nova/.jobs/x.log')
  assert.equal(b.folder, '/home/pi/Eaon/Workers/Nova-2')
  assert.equal(c.folder, '/home/pi/Eaon/Workers/c')
  assert.match(JSON.stringify(moved.threads.a), /\/home\/pi\/Eaon\/Workers\/Nova\/notes.md/)
  assert.match(JSON.stringify(moved.rooms), /\/home\/pi\/Eaon\/Workers\/Nova\/a.txt/)
  // Coming back, a worker returns to where it came from.
  const back = relocate(moved, '/Users/me/Eaon/Workers', { b: '/Users/me/Elsewhere/Nova' }, '/')
  assert.equal((back.snapshot.workers[1] as { folder: string }).folder, '/Users/me/Elsewhere/Nova')
  assert.deepEqual(rewritePaths({ x: ['/a/b/c', 3, null] }, '/a/b', '/z'), { x: ['/z/c', 3, null] })
})

test('listFolder skips links and rebuildable folders, and keeps under the cap', () => {
  const dir = join(scratch, 'list')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(dir, 'a.txt'), 'aaaa')
  writeFileSync(join(dir, 'sub', 'b.txt'), 'bb')
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(1000))
  writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), 'x')
  execFileSync('ln', ['-s', '/etc/hosts', join(dir, 'link')])
  const { files, skipped } = listFolder(dir, 100)
  assert.deepEqual(files.map((f) => f.path).sort(), ['a.txt', 'sub/b.txt'])
  assert.equal(skipped, 2) // node_modules, and big.bin over the cap
  assert.throws(() => inside(dir, '../outside.txt'), /outside the folder/)
  assert.equal(inside(dir, 'sub/b.txt'), join(dir, 'sub', 'b.txt'))
})

/* ------------------------------------------------------------------- host */

function hostContext(): FeatureContext {
  return { ipcMain: ipc, getWindow: () => null, getWindows: () => [], send: (channel: string, ...args: unknown[]) => broadcast(channel, ...args), emitStream: () => {} } as unknown as FeatureContext
}

let service: WorkersService | null = null
let chats: ChannelsHandle | null = null
let replies: string[] = []
const runAgent: RunAgent = async (request, emit) => {
  const text = replies.shift() ?? `Done in ${request.cwd}`
  emit({ type: 'delta', messageId: request.messageId, text })
  emit({ type: 'done', messageId: request.messageId })
  return { text, usage }
}

async function startHost(): Promise<{ desktop: Peer; workRoot: string; home: string; updates: string[]; uninstalled: () => boolean }> {
  const home = mkdtempSync(join(scratch, 'host-'))
  const workRoot = join(home, 'Eaon', 'Workers')
  mkdirSync(workRoot, { recursive: true })
  store.setJson('workers.json', [])
  service = createWorkersService(hostContext(), {
    runAgent,
    startDelayMs: 60_000,
    notifier: {
      notify: (worker, outcome) => broadcast('host:notify', { workerId: worker.id, title: worker.name, body: outcome.text, reachOut: false }),
      reachOut: (worker, message) => broadcast('host:notify', { workerId: worker.id, ...message, reachOut: true })
    }
  })
  service.start()
  service.registerIpc()
  service.engine.start()
  chats = createChannels(hostContext(), service)
  chats.registerIpc()
  const updates: string[] = []
  let removed = false
  const host = createHost({
    home,
    workRoot: () => workRoot,
    skillsDir: join(home, 'skills'),
    runtime: 'node',
    browserNote: 'no browser in tests',
    build: 'test-build',
    appVersion: '0.0.0-test',
    name: () => 'Test Pi',
    store,
    service: () => service!,
    channels: chats,
    applySync: async (payload) => applySync(payload),
    applyUpdate: async (file) => void updates.push(readFileSync(file, 'utf8')),
    uninstall: async () => void (removed = true)
  })
  const secret = newHostSecret()
  server = await listen({ port: 0, host: '127.0.0.1', secret: () => secret, onPeer: (peer) => host.attach(peer) })
  const desktop = await connect({ address: '127.0.0.1', port: server.port, secret })
  peers.push(desktop)
  return { desktop, workRoot, home, updates, uninstalled: () => removed }
}

afterEach(async () => {
  await chats?.stop()
  chats = null
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  await store.flushWrites()
})

const ipcCall = <T>(desktop: Peer, channel: string, ...args: unknown[]): Promise<T> => desktop.call<T>('ipc', { channel, args })

test('the host runs workers for the desktop: its Workers tab IPC, events and notifications', async () => {
  const { desktop } = await startHost()
  const hello = await desktop.call<{ name: string; runtime: string; workers: number; build: string; synced: boolean }>('hello')
  assert.equal(hello.name, 'Test Pi')
  assert.equal(hello.runtime, 'node')
  assert.equal(hello.build, 'test-build')
  assert.equal(hello.workers, 0)

  const events: { channel: string; args: unknown[] }[] = []
  desktop.onEvent((name, data) => name === 'ipc' && events.push(data as { channel: string; args: unknown[] }))
  const worker = await ipcCall<Worker>(desktop, 'workers:save', { name: 'Pip', purpose: 'Watch the garden', personality: '', model: null, access: 'safe' })
  assert.equal(worker.name, 'Pip')
  assert.equal((await ipcCall<Worker[]>(desktop, 'workers:list')).length, 1)
  await until(() => events.some((e) => e.channel === 'workers:changed'))

  replies = ['The garden is fine.']
  await ipcCall(desktop, 'workers:send', worker.id, 'How is the garden?', [], {})
  await until(() => events.some((e) => e.channel === 'workers:message' && JSON.stringify(e.args).includes('The garden is fine.')))
  assert.ok(events.some((e) => e.channel === 'workers:event'))
  await until(() => events.some((e) => e.channel === 'host:notify'))
  const thread = await ipcCall<{ messages: { role: string }[] }>(desktop, 'workers:thread', worker.id)
  assert.deepEqual(
    thread.messages.map((m) => m.role),
    ['user', 'assistant']
  )

  // Only the Workers tab's channels, and only workers' browsers.
  await assert.rejects(ipcCall(desktop, 'trading:snapshot'), /isn’t served/)
  await assert.rejects(ipcCall(desktop, 'agent-browser:watch', true, 'agent'), /isn’t served/)
  assert.equal(hostServesChannel('agent-browser:input', [{ type: 'text', text: 'x' }, 'worker:abc']), true)
})

test('workers move in with their folders, run there, and move out again', async () => {
  const { desktop, workRoot } = await startHost()
  const desktopFolder = '/Users/someone/Eaon/Workers/Nova'
  const snapshot = {
    workers: [
      {
        id: 'w-nova',
        name: 'Nova',
        color: '#3E86C6',
        personality: '',
        purpose: 'Research',
        folder: desktopFolder,
        access: 'safe',
        model: null,
        createdAt: Date.now(),
        createdBy: null,
        paused: false,
        status: 'idle',
        inbox: [],
        unread: 0
      }
    ],
    threads: { 'w-nova': { workerId: 'w-nova', messages: [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: `I keep notes in ${desktopFolder}/notes.md` }], createdAt: 1 }], summary: null } },
    rooms: null
  }
  const { moves } = await desktop.call<{ moves: { id: string; from: string; to: string }[] }>('workers.import', { snapshot })
  assert.deepEqual(moves, [{ id: 'w-nova', from: desktopFolder, to: join(workRoot, 'Nova') }])
  await desktop.call('files.put', { path: `${moves[0].to}/notes.md`, offset: 0, data: Buffer.from('hello ').toString('base64') })
  await desktop.call('files.put', { path: `${moves[0].to}/notes.md`, offset: 6, data: Buffer.from('world').toString('base64') })
  assert.equal(readFileSync(join(workRoot, 'Nova', 'notes.md'), 'utf8'), 'hello world')
  await desktop.call('workers.resume')

  const [nova] = await ipcCall<Worker[]>(desktop, 'workers:list')
  assert.equal(nova.folder, join(workRoot, 'Nova'))
  const thread = await ipcCall<{ messages: { parts: { text: string }[] }[] }>(desktop, 'workers:thread', 'w-nova')
  assert.equal(thread.messages[0].parts[0].text, `I keep notes in ${join(workRoot, 'Nova')}/notes.md`)

  // It works there, in its new folder.
  replies = []
  const events: string[] = []
  desktop.onEvent((name, data) => name === 'ipc' && events.push(JSON.stringify(data)))
  await ipcCall(desktop, 'workers:send', 'w-nova', 'Where are you?', [], {})
  await until(() => events.some((e) => e.includes(`Done in ${join(workRoot, 'Nova')}`)))

  // Mail with a file: uploaded first, then referenced at its path on the host.
  const upload = await desktop.call<string>('files.upload-path', { name: '../../evil name.txt' })
  assert.ok(upload.includes(join('uploads')) && upload.endsWith('evil name.txt') && !upload.includes('..'))
  await desktop.call('files.put', { path: upload, offset: 0, data: Buffer.from('attached').toString('base64') })

  // Nothing outside the workers' folders, uploads and skills.
  await assert.rejects(desktop.call('files.put', { path: '/etc/evil', offset: 0, data: '' }), /isn’t one the worker computer shares/)
  await assert.rejects(desktop.call('files.get', { path: join(workRoot, '..', '..', 'host.json'), offset: 0 }), /isn’t one/)

  // Out again: the snapshot, and what's in each folder.
  await service!.engine.whenIdle()
  const exported = await desktop.call<{ snapshot: { workers: Worker[] }; folders: { id: string; folder: string; files: { path: string; size: number }[] }[] }>('workers.export')
  assert.equal(exported.snapshot.workers[0].id, 'w-nova')
  assert.deepEqual(exported.folders[0].files, [{ path: 'notes.md', size: 11 }])
  const chunk = await desktop.call<{ data: string; size: number }>('files.get', { path: `${exported.folders[0].folder}/notes.md`, offset: 0 })
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'hello world')
  assert.equal(service!.suspended, true)
  await desktop.call('workers.release')
  assert.deepEqual(await ipcCall<Worker[]>(desktop, 'workers:list'), [])
  assert.equal(service!.suspended, false)
})

test('chat apps move in with the workers, answer for them there, keep their tokens through a sync, and move out again', async () => {
  const { desktop } = await startHost()
  const nova = { id: 'w-nova', name: 'Nova', color: '#3E86C6', personality: '', purpose: 'Research', folder: '/Users/someone/Eaon/Workers/Nova', access: 'safe', model: null, createdAt: 1, createdBy: null, paused: false, status: 'idle', inbox: [], unread: 0 }
  await desktop.call('workers.import', { snapshot: { workers: [nova], threads: {}, rooms: null } })
  // Off, so no test talks to Telegram or WhatsApp; what moves is the same either way.
  const data = {
    links: [
      { id: 'l-tg', kind: 'telegram', workerId: 'w-nova', enabled: false, account: 'nova_bot' },
      { id: 'l-wa', kind: 'whatsapp', workerId: 'w-nova', enabled: false },
      { id: '../escape', kind: 'telegram', workerId: 'w-nova', enabled: false }
    ],
    tokens: { 'l-tg': '123:telegram-token' },
    whatsapp: { 'l-wa': { 'creds.dat': '{"me":"nova"}', 'pre-key-1.dat': '{"k":1}', '../../outside.dat': '{}' } }
  }
  await desktop.call('channels.import', { data })
  // Mid-move: they start with the workers.
  assert.equal(chats!.suspended, true)
  await desktop.call('workers.resume')
  assert.equal(chats!.suspended, false)

  const listed = await ipcCall<{ links: ChannelLink[]; statuses: ChannelStatus[] }>(desktop, 'channels:list')
  assert.deepEqual(
    listed.links.map((l) => [l.id, l.workerId]),
    [
      ['l-tg', 'w-nova'],
      ['l-wa', 'w-nova']
    ]
  )
  assert.equal(secrets.get('channel:l-tg'), '123:telegram-token')
  const waDir = join(process.env.EAON_TEST_USERDATA!, 'channels', 'whatsapp-l-wa')
  assert.deepEqual(readdirSync(waDir).sort(), ['creds.dat', 'pre-key-1.dat'])
  // What the desktop's Chat apps page asked for and was refused: a worker that lives here.
  const discord = await ipcCall<ChannelLink>(desktop, 'channels:create', 'discord', 'w-nova')
  assert.equal(discord.workerId, 'w-nova')
  await ipcCall(desktop, 'channels:remove', discord.id)

  // The desktop never sends its copies of the tokens, and a sync doesn't take the host's away.
  applySync({ secrets: { fake: 'key' }, providers: {}, settings: {}, mcpServers: [] })
  assert.equal(secrets.get('channel:l-tg'), '123:telegram-token')
  applySync({ secrets: { fake: 'key', 'channel:l-tg': 'stale' }, providers: {}, settings: {}, mcpServers: [] })
  assert.equal(secrets.get('channel:l-tg'), '123:telegram-token')

  // Out again, everything they need to answer from the desktop.
  await service!.engine.whenIdle()
  await desktop.call('workers.export')
  assert.equal(chats!.suspended, true)
  const out = await desktop.call<{ links: ChannelLink[]; tokens: Record<string, string>; whatsapp: Record<string, Record<string, string>> }>('channels.export')
  assert.deepEqual(
    out.links.map((l) => l.id),
    ['l-tg', 'l-wa']
  )
  assert.deepEqual(out.tokens, { 'l-tg': '123:telegram-token' })
  assert.deepEqual(out.whatsapp, { 'l-wa': { 'creds.dat': '{"me":"nova"}', 'pre-key-1.dat': '{"k":1}' } })
  // Released: no bot of theirs is left here to fight the desktop's.
  await desktop.call('workers.release')
  assert.deepEqual((await ipcCall<{ links: ChannelLink[] }>(desktop, 'channels:list')).links, [])
  assert.equal(secrets.get('channel:l-tg'), undefined)
  assert.equal(existsSync(waDir), false)
})

test('sync brings the desktop’s keys, providers, model and MCP servers, but not its folders', async () => {
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: '/host/own/folder' } })
  secrets.set('stale-provider', 'old-key')
  applySync({
    secrets: { anthropic: 'sk-ant-1', openai: 'sk-2' },
    providers: { fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' } },
    settings: { selectedProviderId: 'fake', selectedModelId: 'm', appearance: { mode: 'light' }, work: { ...store.getSettings().work, defaultFolder: '/Users/desk/Eaon', swarm: true } },
    mcpServers: [{ id: 'mine', name: 'Mine', transport: 'stdio', command: 'x', args: [], env: {}, url: '', enabled: true, official: false }]
  })
  assert.equal(secrets.get('anthropic'), 'sk-ant-1')
  assert.equal(secrets.get('stale-provider'), undefined)
  assert.equal(store.getSettings().selectedProviderId, 'fake')
  assert.equal(store.getSettings().work.defaultFolder, '/host/own/folder')
  assert.equal(store.getSettings().work.swarm, true)
  assert.notEqual(store.getSettings().appearance.mode, 'light')
  const servers = store.getMcpServers()
  assert.ok(servers.some((s) => s.id === 'mine'))
  assert.ok(servers.some((s) => s.id === 'filesystem' && s.official))
  assert.equal(pickSettings({ shortcuts: {}, effort: 'max' }).effort, 'max')
  assert.equal('shortcuts' in pickSettings({ shortcuts: {} }), false)
  // Back to the fake model for the tests after this one.
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: join(scratch, 'work') }, selectedProviderId: 'fake', selectedModelId: 'big-model' })
  store.saveProviderConfig({ ...quietLocals, fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', models: [{ id: 'big-model', label: 'Big', providerId: 'fake' }] } })
  secrets.set('fake', 'key')
})

test('the host takes an update only when it arrives whole', async () => {
  const { desktop, updates, uninstalled } = await startHost()
  const body = Buffer.from('new host app')
  await desktop.call('update.put', { offset: 0, data: body.toString('base64') })
  await assert.rejects(desktop.call('update.apply', { sha256: 'nope' }), /damaged/)
  const { createHash } = await import('node:crypto')
  await desktop.call('update.apply', { sha256: createHash('sha256').update(body).digest('hex') })
  await until(() => updates.length === 1)
  assert.equal(updates[0], 'new host app')
  await desktop.call('uninstall')
  await until(() => uninstalled())
})

/* --------------------------------------------------------------- installing */

test('uninstalling the host app deletes the desktop’s keys it had, and keeps the workers’ data', () => {
  const home = mkdtempSync(join(scratch, 'uninstall-'))
  for (const dir of ['app', 'runtime', 'uploads', join('data', 'store')]) mkdirSync(join(home, dir), { recursive: true })
  writeFileSync(join(home, 'host.json'), '{"port": 47820, "secret": "x"}')
  writeFileSync(join(home, 'data', 'keys.dat'), '{"openai":"sk-live"}')
  writeFileSync(join(home, 'data', 'keys.dat.tmp'), '{"openai":"sk-live"}')
  writeFileSync(join(home, 'data', 'keys.dat.broken-1'), 'x')
  writeFileSync(join(home, 'data', 'store', 'workers.json'), '[]')
  // No service file, and a HOME of its own: only files under the scratch folder are touched.
  const out = execFileSync('sh', [join(process.cwd(), 'src/host/install.sh'), '--uninstall'], {
    env: { ...process.env, EAON_HOST_HOME: home, HOME: mkdtempSync(join(scratch, 'uninstall-home-')) },
    encoding: 'utf8'
  })
  assert.match(out, /EAON_HOST_REMOVED/)
  for (const gone of ['app', 'runtime', 'uploads', 'host.json', join('data', 'keys.dat'), join('data', 'keys.dat.tmp'), join('data', 'keys.dat.broken-1')]) assert.equal(existsSync(join(home, gone)), false, gone)
  assert.equal(readFileSync(join(home, 'data', 'store', 'workers.json'), 'utf8'), '[]', 'the workers’ data stays')
})

test('install output is read line by line, however it is split', () => {
  const lines: string[] = []
  const out = installOutput((p) => lines.push(p.line))
  out.push('EAON: Downloading Ele')
  out.push('ctron\nnoise\nEAON: Checking\nEAON_HOST_RE')
  out.push('ADY 3268 linux arm64 electron\n')
  assert.deepEqual(lines, ['Downloading Electron', 'Checking'])
  assert.deepEqual(out.result(), { port: 3268, platform: 'linux', arch: 'arm64', runtime: 'electron' })
  const failed = installOutput(() => undefined)
  failed.push('EAON_ERROR: no space left')
  assert.equal(failed.result(), null)
  assert.equal(failed.error(), 'no space left')
  assert.match(sshProblem('user@pi: Permission denied (publickey,password).', 255), /couldn’t sign in/)
  assert.match(sshProblem('ssh: connect to host pi port 22: Connection refused', 255), /refused SSH/)
})

/** A package whose install.sh only reports what it was given. */
function fakePackage(): string {
  const dir = mkdtempSync(join(scratch, 'pkg-'))
  mkdirSync(join(dir, 'eaon-host'))
  writeFileSync(
    join(dir, 'eaon-host', 'install.sh'),
    '#!/bin/sh\necho "EAON: secret=$EAON_HOST_SECRET sudo=$EAON_SUDO_PASS name=$EAON_HOST_NAME port=${EAON_HOST_PORT:-none}"\necho "EAON_HOST_READY 4321 linux arm64 electron"\n'
  )
  chmodSync(join(dir, 'eaon-host', 'install.sh'), 0o755)
  execFileSync('tar', ['-czf', join(dir, 'p.tgz'), '-C', dir, 'eaon-host'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  return join(dir, 'p.tgz')
}

test('an SSH install sends the secret and password on stdin, never on the command line', async () => {
  const pkg = fakePackage()
  // Stands in for ssh: records its arguments and runs the remote command here.
  const fakeSsh = join(scratch, 'fake-ssh')
  const argsFile = join(scratch, 'ssh-args')
  writeFileSync(fakeSsh, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho "askpass=$( [ -n "$SSH_ASKPASS" ] && "$SSH_ASKPASS")" >&2\nfor last; do :; done\nexec sh -c "$last"\n`)
  chmodSync(fakeSsh, 0o755)
  const lines: string[] = []
  const result = await installOverSsh({
    request: { host: 'raspberrypi.local', user: 'pi', password: "pa ss'word", name: "Pi's den" },
    packagePath: pkg,
    secret: 'SECRET123',
    port: 3268,
    onProgress: (p) => lines.push(p.line),
    ssh: fakeSsh
  })
  assert.deepEqual(result, { port: 4321, platform: 'linux', arch: 'arm64', runtime: 'electron' })
  assert.ok(lines.includes("secret=SECRET123 sudo=pa ss'word name=Pi's den port=none"), lines.join('\n'))
  const args = readFileSync(argsFile, 'utf8')
  assert.ok(!args.includes('SECRET123') && !args.includes('pa ss'))
  assert.match(args, /pi@raspberrypi\.local/)
  assert.match(args, /StrictHostKeyChecking=accept-new/)
  // No password: ssh must never stop to ask.
  await installOverSsh({ request: { host: 'pi', user: 'pi' }, packagePath: pkg, secret: 's', port: 3268, onProgress: () => {}, ssh: fakeSsh })
  assert.match(readFileSync(argsFile, 'utf8'), /BatchMode=yes/)
  await assert.rejects(installOverSsh({ request: { host: 'pi; rm -rf /', user: 'pi' }, packagePath: pkg, secret: 's', port: 1, onProgress: () => {} }), /address/)
  assert.match(remoteInstallCommand("a'b"), /^sh -c '/)
})

test('the one-line install serves the script and package once, and links when the other computer reports back', async () => {
  const pkg = fakePackage()
  let done: { port: number; address: string; name: string; runtime: string } | null = null
  const pairing = await startPairingServer({
    packagePath: pkg,
    address: '127.0.0.1',
    secret: 'PAIRSECRET',
    hostPort: 3268,
    computerName: 'Test Mac',
    onProgress: () => {},
    onDone: (d) => (done = d)
  })
  try {
    assert.match(pairing.command, /^curl -fsSL http:\/\/127\.0\.0\.1:\d+\/eaon-host\/[\w-]+ \| sh$/)
    const wrong = await fetch(pairing.url.replace(/[\w-]+$/, 'guessed'))
    assert.equal(wrong.status, 404)
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('sh', ['-c', pairing.command], { stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''
      child.stdout.on('data', (c) => (text += c))
      child.stderr.on('data', (c) => (text += c))
      child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(text))))
    })
    assert.match(output, /secret=PAIRSECRET/)
    assert.match(output, /port=3268/)
    await until(() => done !== null)
    assert.equal(done!.port, 4321)
    assert.equal(done!.address, '127.0.0.1')
    assert.equal(done!.runtime, 'electron')
    // Used up.
    assert.equal((await fetch(pairing.url)).status, 404)
  } finally {
    await pairing.close()
  }
  assert.match(pairingScript('http://x/y', 'S', 3268, "Bob's `Mac`"), /from Bob's Mac/)
})

/* ------------------------------------------------ the workers' own snapshot */


test('readSnapshot and writeSnapshot round-trip the workers’ files', () => {
  writeSnapshot(store, { workers: [{ id: 'x1', name: 'X', folder: '/f' }], threads: { x1: { workerId: 'x1', messages: [] } }, rooms: null })
  const back = readSnapshot(store)
  assert.deepEqual(back.workers, [{ id: 'x1', name: 'X', folder: '/f' }])
  assert.deepEqual(back.threads.x1, { workerId: 'x1', messages: [] })
  assert.deepEqual(back.rooms, { rooms: [], posts: {}, seen: {} })
  writeSnapshot(store, { workers: [], threads: {}, rooms: null })
})

test('a worker’s side threads move with it, paths and all', () => {
  const worker = { id: 'x2', name: 'Y', folder: '/old/Y', threads: [{ id: 'main' }, { id: 't-a1' }] }
  const threads = { x2: { workerId: 'x2', messages: [] }, 'x2#t-a1': { workerId: 'x2', threadId: 't-a1', messages: ['see /old/Y/plan.md'] } }
  writeSnapshot(store, { workers: [worker], threads, rooms: null })
  const back = readSnapshot(store)
  assert.deepEqual(Object.keys(back.threads).sort(), ['x2', 'x2#t-a1'])
  const { snapshot } = relocate(back, '/new', {}, '/')
  assert.deepEqual((snapshot.threads['x2#t-a1'] as { messages: string[] }).messages, ['see /new/Y/plan.md'])
  writeSnapshot(store, { workers: [], threads: {}, rooms: null })
})

test('a folder’s path is rewritten only where it ends: Nova is not the start of Nova2', () => {
  const from = '/Users/me/Eaon/Workers/Nova (1)'
  const to = '/home/pi/Eaon/Workers/Nova (1)'
  const out = rewritePaths({ a: from, b: `${from}/notes.md`, c: `see ${from}.`, d: `${from}2/x`, e: `${from}-old`, f: `"${from}"` }, from, to)
  assert.deepEqual(out, { a: to, b: `${to}/notes.md`, c: `see ${to}.`, d: `${from}2/x`, e: `${from}-old`, f: `"${to}"` })
})

/* ---------------------------------------------------------------- sign-ins */

const signIn = (refresh: string, expires: number): string => JSON.stringify({ access: `a-${refresh}`, refresh, expires })

test('a sign-in the worker computer refreshed survives a sync from the desktop’s older copy', () => {
  assert.equal(credentialExpiry(signIn('r', 5)), 5)
  assert.equal(credentialExpiry(JSON.stringify({ tokens: {}, expiresAt: 7 })), 7)
  assert.equal(credentialExpiry('sk-plain-key'), null)
  assert.deepEqual(Object.keys(signInEntries({ k: 'sk-1', 'oauth::x': signIn('r', 1) })), ['oauth::x'])

  // The host used the sign-in and got a new refresh token; the desktop still has the spent one.
  secrets.set('oauth::openai-codex', signIn('r2', 2000))
  applySync({ secrets: { fake: 'key', 'oauth::openai-codex': signIn('r1', 1000) }, providers: {}, settings: {}, mcpServers: [] })
  assert.equal(JSON.parse(secrets.get('oauth::openai-codex')!).refresh, 'r2')
  // The desktop signing in again (a later expiry) does reach it.
  applySync({ secrets: { fake: 'key', 'oauth::openai-codex': signIn('r3', 3000) }, providers: {}, settings: {}, mcpServers: [] })
  assert.equal(JSON.parse(secrets.get('oauth::openai-codex')!).refresh, 'r3')
  // Signed out on the desktop: signed out here.
  applySync({ secrets: { fake: 'key' }, providers: {}, settings: {}, mcpServers: [] })
  assert.equal(secrets.get('oauth::openai-codex'), undefined)
})

test('a cached sign-in is read again once the vault changed underneath it', () => {
  const tokens = tokenStore<{ refresh: string }>('worker-host-test')
  tokens.set({ refresh: 'old' })
  assert.equal(tokens.get()?.refresh, 'old')
  // A sync, or the other computer's refresh arriving.
  secrets.set('oauth::worker-host-test', JSON.stringify({ refresh: 'new' }))
  assert.equal(tokens.get()?.refresh, 'new')
  tokens.set(null)
})

test('a desktop’s link closing reads as its window closing, for what was subscribed', async () => {
  const sent: string[] = []
  const event = senderFor(7, (channel) => sent.push(channel))
  let gone = 0
  const fn = (): void => void gone++
  event.sender.once('destroyed', fn)
  event.sender.send('workers:changed')
  event.destroy()
  event.sender.send('workers:changed')
  assert.equal(gone, 1)
  assert.equal(event.sender.isDestroyed(), true)
  assert.deepEqual(sent, ['workers:changed'])
  let late = 0
  event.sender.once('destroyed', () => void late++)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(late, 1)
})

/* ---------------------------------------- the Workers tab, with the host away */

test('with the worker computer away, the tab reads from the cache and only changes fail, at once', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ctx = {
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
        if (handlers.has(channel)) throw new Error(`second handler for ${channel}`)
        handlers.set(channel, handler)
      },
      removeHandler: (channel: string) => handlers.delete(channel)
    },
    getWindow: () => null,
    getWindows: () => [],
    send: () => undefined,
    emitStream: () => {}
  } as unknown as FeatureContext
  const call = (channel: string, ...args: unknown[]): Promise<unknown> => Promise.resolve().then(() => handlers.get(channel)!({ sender: { id: 1 } }, ...args))
  const desk = createWorkersService(ctx, { startDelayMs: 60_000 })
  desk.registerIpc()
  const deskChats = createChannels(ctx, desk)
  deskChats.registerIpc()
  deskChats.start()
  // A port nothing listens on: refused at once.
  const closed = await new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
  const cached: Partial<Worker> = { id: 'w-away', name: 'Away' }
  const cachedLink: Partial<ChannelLink> = { id: 'l-away', kind: 'telegram', workerId: 'w-away', enabled: true }
  store.setJson('worker-host-cache.json', { workers: [cached], rooms: [], links: [cachedLink] })
  store.setJson('worker-host.json', {
    host: { id: 'h', name: 'Garage Pi', address: '127.0.0.1', port: closed, platform: 'linux', arch: 'arm64', linkedAt: 1, via: 'command' },
    enabled: true,
    origins: {},
    backupAt: null,
    skillsHash: null,
    releasePending: false,
    channelsMoved: true
  })
  secrets.set('worker-host:secret', newHostSecret())
  const feature = createWorkerHost(ctx, desk, deskChats)
  try {
    // What the tab only reads or reports: answered, never an error.
    assert.deepEqual(await call('workers:list'), [cached])
    assert.equal(await call('workers:viewing', 'w-away'), undefined)
    assert.deepEqual(await call('workers:executions', 'w-away'), [])
    assert.deepEqual(await call('workers:delegations'), [])
    assert.equal(await call('workers:job-log', 'w-away', 'j'), '')
    assert.equal((await call('workers:thread', 'w-away', 't-side')) && true, true)
    // A change fails, as soon as the link has failed rather than after a long wait.
    const started = Date.now()
    await assert.rejects(call('workers:send', 'w-away', 'hi', [], {}), /Garage Pi can’t be reached/)
    assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`)
    assert.equal(feature.state().enabled, true)

    // Chat apps went with the workers: none run here, and the page shows the host's as last seen.
    assert.equal(deskChats.suspended, true)
    const chatApps = (await call('channels:list')) as { links: ChannelLink[]; statuses: ChannelStatus[] }
    assert.deepEqual(chatApps.links, [cachedLink])
    assert.deepEqual(
      chatApps.statuses.map((s) => [s.linkId, s.state, s.message]),
      [['l-away', 'error', 'Garage Pi can’t be reached right now.']]
    )
    // Connecting one is the host's to do, never this computer's (where no worker is).
    await assert.rejects(call('channels:create', 'telegram', 'w-away'), /Garage Pi can’t be reached/)
  } finally {
    feature.dispose()
    await deskChats.stop()
    desk.stop()
    secrets.clear('worker-host:secret')
    store.setJson('worker-host.json', {})
    store.setJson('worker-host-cache.json', {})
  }
})

after(() => {
  assert.ok(existsSync(scratch))
})
