import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { store } from '../src/main/store'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import type { RunAgent } from '../src/main/features/workers/runner'
import type { FeatureContext } from '../src/main/features/types'
import { ChannelsService } from '../src/main/features/channels/service'
import { MatrixConnector, verifyMatrixCredentials } from '../src/main/features/channels/matrix'
import { MattermostConnector, verifyMattermostCredentials } from '../src/main/features/channels/mattermost'
import type { ConnectorEvents } from '../src/main/features/channels/types'
import type { ChannelLink } from '@shared/channels'
import type { StreamRequest } from '@shared/types'

/**
 * Matrix and Mattermost against real servers: the chat apps service and a
 * worker (with a faked model) on one side, people using the server's own
 * client API on the other. Off unless a server is given:
 *
 *   EAON_LIVE_MATRIX=http://127.0.0.1:8008   Synapse with users nova, ana and ben
 *                                             (passwords nova-pass-123 and so on)
 *   EAON_LIVE_MATTERMOST=http://127.0.0.1:8065 with EAON_LIVE_MATTERMOST_TOKEN (bot
 *                                             "nova"), users ana and ben (Ana-pass-1234,
 *                                             Ben-pass-1234), and EAON_LIVE_MATTERMOST_CHANNEL
 *                                             (a channel all three are in)
 */

const MATRIX = process.env.EAON_LIVE_MATRIX
const MATTERMOST = process.env.EAON_LIVE_MATTERMOST
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }

async function until<T>(check: () => T | Promise<T>, timeout = 20_000, what = 'a condition'): Promise<NonNullable<T>> {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value as NonNullable<T>
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

let workers: WorkersService | null = null
let channels: ChannelsService | null = null
const requests: StreamRequest[] = []
const textOf = (request: StreamRequest): string => JSON.stringify(request.history[request.history.length - 1])

before(() => {
  store.setJson('workers.json', [])
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: mkdtempSync(join(tmpdir(), 'eaon-live-chat-')) } })
})

after(async () => {
  await channels?.stop()
  workers?.stop()
  await workers?.engine.whenIdle()
  await store.flushWrites()
})

/** A worker whose model answers "Hi from Nova", and the chat apps service with real connectors. */
function setup(createConnector: (link: ChannelLink, token: string | null, events: ConnectorEvents) => MatrixConnector | MattermostConnector) {
  store.setJson('workers.json', [])
  const runAgent: RunAgent = async (request, emit) => {
    requests.push(structuredClone(request))
    const text = textOf(request).includes('the group') ? 'Hello, group, from Nova' : 'Hi from **Nova**'
    emit({ type: 'delta', messageId: request.messageId, text })
    emit({ type: 'done', messageId: request.messageId })
    return { text, usage }
  }
  workers = createWorkersService({ ipcMain: { handle: () => {} }, getWindow: () => null, send: () => {}, emitStream: () => {} } as unknown as FeatureContext, {
    runAgent,
    startDelayMs: 60_000
  })
  workers.start()
  workers.engine.start()
  const tokens = new Map<string, string>()
  let saved: ChannelLink[] = []
  channels = new ChannelsService({
    engine: workers.engine,
    loadLinks: () => saved,
    saveLinks: (links) => (saved = structuredClone(links)),
    getToken: (id) => tokens.get(id),
    setToken: (id, token) => (token ? tokens.set(id, token) : tokens.delete(id)),
    verifyToken: async (kind, token) => (kind === 'matrix' ? verifyMatrixCredentials(token) : verifyMattermostCredentials(token)),
    createConnector
  })
  channels.load()
  channels.start()
  const nova = workers.engine.save({ name: 'Nova', color: '#3E86C6', personality: '', purpose: 'help', model: { providerId: 'ollama', modelId: 'm' } })
  return { nova, tokens, link: () => channels!.list()[0], status: (id: string) => channels!.statusList().find((s) => s.linkId === id) }
}

async function teardown(): Promise<void> {
  await channels?.stop()
  channels = null
  workers?.stop()
  await workers?.engine.whenIdle()
  workers = null
  requests.length = 0
}

/* ------------------------------------------------------------------ Matrix */

test('Matrix, live: sign in, pair over a direct chat, answer, let a room in, read files, refuse what it can’t read', { skip: !MATRIX && 'set EAON_LIVE_MATRIX' }, async () => {
  const server = MATRIX!
  const api = async <T>(token: string, method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${server}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' || body instanceof Buffer ? (body as BodyInit) : JSON.stringify(body)
    })
    const data = (await response.json()) as T & { error?: string }
    if (!response.ok) throw new Error(`${method} ${path}: ${data.error}`)
    return data
  }
  const login = async (user: string): Promise<string> =>
    (await (await fetch(`${server}/_matrix/client/v3/login`, { method: 'POST', body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: `${user}-pass-123` }) })).json()).access_token as string
  const ana = await login('ana')
  const ben = await login('ben')
  const say = (token: string, room: string, content: Record<string, unknown>, type = 'm.room.message') =>
    api(token, 'PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/${type}/${Math.random().toString(36).slice(2)}`, content)
  const novaSaid = async (token: string, room: string): Promise<{ body: string; formatted?: string; msgtype: string; replyTo?: string }[]> => {
    const { chunk } = await api<{ chunk: { sender: string; type: string; content: Record<string, unknown> }[] }>(token, 'GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=50`)
    return chunk
      .filter((e) => e.sender === '@nova:localhost' && e.type === 'm.room.message')
      .reverse()
      .map((e) => ({
        body: String(e.content.body),
        formatted: e.content.formatted_body as string | undefined,
        msgtype: String(e.content.msgtype),
        replyTo: (e.content['m.relates_to'] as { 'm.in_reply_to'?: { event_id?: string } } | undefined)?.['m.in_reply_to']?.event_id
      }))
  }
  const joined = (token: string, room: string, user: string) =>
    until(async () => Object.keys((await api<{ joined: Record<string, unknown> }>(token, 'GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/joined_members`)).joined).includes(user), 20_000, `${user} to join`)

  try {
    await assert.rejects(verifyMatrixCredentials(JSON.stringify({ server, user: 'nova', password: 'wrong' })), /didn’t accept that user name and password/)
    await assert.rejects(verifyMatrixCredentials(JSON.stringify({ server: 'http://127.0.0.1:9', user: 'nova', password: 'x' })), /Couldn’t reach/)

    const env = setup((_link, token, events) => new MatrixConnector(token ?? '', events))
    const link = channels!.create('matrix', env.nova.id)
    await channels!.setToken(link.id, JSON.stringify({ server, user: 'nova', password: 'nova-pass-123' }))
    // The vault keeps a session, never the password.
    const kept = env.tokens.get(link.id)!
    assert.ok(!kept.includes('nova-pass-123'))
    assert.equal(JSON.parse(kept).userId, '@nova:localhost')
    assert.equal(env.link().account, '@nova:localhost')
    await until(() => env.status(link.id)?.state === 'connected', 20_000, 'Matrix to connect')

    // Ana starts a direct chat with the worker's account: it joins, and she pairs.
    const { room_id: dm } = await api<{ room_id: string }>(ana, 'POST', '/_matrix/client/v3/createRoom', { is_direct: true, invite: ['@nova:localhost'], preset: 'trusted_private_chat' })
    await joined(ana, dm, '@nova:localhost')
    await say(ana, dm, { msgtype: 'm.text', body: `!pair ${env.link().pairCode}` })
    await until(() => env.link().owner?.id === '@ana:localhost', 20_000, 'pairing')
    assert.match((await until(async () => (await novaSaid(ana, dm)).find((m) => m.body.startsWith('Paired')), 20_000, 'the paired note')).body, /send !help/)

    await say(ana, dm, { msgtype: 'm.text', body: 'hello Nova' })
    const reply = await until(async () => (await novaSaid(ana, dm)).find((m) => m.body.includes('Hi from Nova')), 20_000, 'the worker’s reply')
    assert.equal(reply.formatted, 'Hi from <b>Nova</b>')

    // A file she sends lands with the worker.
    const upload = await api<{ content_uri: string }>(ana, 'POST', '/_matrix/media/v3/upload?filename=plan.txt', Buffer.from('the plan'))
    await say(ana, dm, { msgtype: 'm.file', body: 'plan.txt', url: upload.content_uri, info: { size: 8 } })
    await until(() => requests.some((r) => textOf(r).includes('plan.txt')), 20_000, 'the file to reach the worker')

    // Encrypted messages can't be read; the worker is told what came.
    await say(ana, dm, { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'AwgA', sender_key: 'k', device_id: 'D', session_id: 's' }, 'm.room.encrypted')
    await until(() => requests.some((r) => textOf(r).includes('end-to-end encrypted')), 20_000, 'the encrypted note')

    // Ben's room: the worker joins, is called on, and the owner is asked.
    const { room_id: group } = await api<{ room_id: string }>(ben, 'POST', '/_matrix/client/v3/createRoom', { name: 'Weekend', invite: ['@nova:localhost', '@ana:localhost'], preset: 'private_chat' })
    await api(ana, 'POST', `/_matrix/client/v3/join/${encodeURIComponent(group)}`, {})
    await joined(ben, group, '@nova:localhost')
    await say(ben, group, { msgtype: 'm.text', body: 'Nova: can you help the group?', 'm.mentions': { user_ids: ['@nova:localhost'] } })
    const request = await until(() => env.link().requests.find((r) => r.kind === 'chat'), 20_000, 'the room’s request')
    assert.equal(request.name, 'Weekend')
    assert.match((await until(async () => (await novaSaid(ana, dm)).find((m) => m.body.includes('wants to talk')), 20_000, 'the owner’s alert')).body, new RegExp(`!allow ${request.code}`))
    await say(ana, dm, { msgtype: 'm.text', body: `!allow ${request.code}` })
    await until(() => env.link().chats.some((c) => c.id === group), 20_000, 'the room to be allowed')
    await say(ben, group, { msgtype: 'm.text', body: '@nova:localhost hello to the group', 'm.mentions': { user_ids: ['@nova:localhost'] } })
    const inGroup = await until(async () => (await novaSaid(ben, group)).find((m) => m.body.includes('Hello, group')), 20_000, 'the answer in the room')
    assert.ok(inGroup.replyTo, 'it answers the message it was called with')

    // Typing, files back, and a direct chat it opens itself.
    const extra = new MatrixConnector(kept, { message: () => {}, status: () => {}, account: () => {} })
    await extra.typing(dm, true)
    const dir = mkdtempSync(join(tmpdir(), 'eaon-matrix-'))
    writeFileSync(join(dir, 'report.txt'), 'report')
    await extra.sendFile(dm, join(dir, 'report.txt'))
    assert.ok((await novaSaid(ana, dm)).some((m) => m.msgtype === 'm.file' && m.body === 'report.txt'))
    const opened = await extra.directChat('@ben:localhost')
    assert.ok(opened.startsWith('!'))
    await extra.stop()
  } finally {
    await teardown()
  }
})

/* -------------------------------------------------------------- Mattermost */

test('Mattermost, live: a bot token, pairing in a DM, answers in channels and threads, and files both ways', { skip: !MATTERMOST && 'set EAON_LIVE_MATTERMOST' }, async () => {
  const server = MATTERMOST!
  const botToken = process.env.EAON_LIVE_MATTERMOST_TOKEN!
  const town = process.env.EAON_LIVE_MATTERMOST_CHANNEL!
  const api = async <T>(token: string, method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${server}/api/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body)
    })
    const data = (await response.json()) as T & { message?: string }
    if (!response.ok) throw new Error(`${method} ${path}: ${data.message}`)
    return data
  }
  const login = async (user: string, password: string): Promise<{ token: string; id: string }> => {
    const response = await fetch(`${server}/api/v4/users/login`, { method: 'POST', body: JSON.stringify({ login_id: user, password }) })
    return { token: response.headers.get('token')!, id: ((await response.json()) as { id: string }).id }
  }
  const ana = await login('ana', 'Ana-pass-1234')
  const ben = await login('ben', 'Ben-pass-1234')
  // Only this run's: a direct channel keeps what earlier runs said.
  const since = Date.now() - 1000
  const novaPosts = async (token: string, channel: string): Promise<{ message: string; root_id: string; file_ids?: string[] }[]> => {
    const { order, posts } = await api<{ order: string[]; posts: Record<string, { user_id: string; message: string; root_id: string; file_ids?: string[]; type: string }> }>(token, 'GET', `/channels/${channel}/posts?per_page=100&since=${since}`)
    const me = await api<{ id: string }>(botToken, 'GET', '/users/me')
    return order
      .map((id) => posts[id])
      .filter((p) => p.user_id === me.id && !p.type)
      .reverse()
  }

  try {
    await assert.rejects(verifyMattermostCredentials(JSON.stringify({ server, token: 'nope' })), /didn’t accept that token/)
    const env = setup((_link, token, events) => new MattermostConnector(token ?? '', events))
    const link = channels!.create('mattermost', env.nova.id)
    await channels!.setToken(link.id, JSON.stringify({ server: server.replace(/^http:\/\//, 'http://'), token: botToken }))
    assert.equal(env.link().account, '@nova')
    await until(() => env.status(link.id)?.state === 'connected', 20_000, 'Mattermost to connect')
    const me = await api<{ id: string }>(botToken, 'GET', '/users/me')

    // Ana writes to the bot directly and pairs.
    const dm = (await api<{ id: string }>(ana.token, 'POST', '/channels/direct', [ana.id, me.id])).id
    await api(ana.token, 'POST', '/posts', { channel_id: dm, message: `!pair ${env.link().pairCode}` })
    await until(() => env.link().owner?.id === ana.id, 20_000, 'pairing')
    await api(ana.token, 'POST', '/posts', { channel_id: dm, message: 'hello Nova' })
    await until(async () => (await novaPosts(ana.token, dm)).some((p) => p.message === 'Hi from **Nova**'), 20_000, 'the worker’s reply')

    // A file she attaches lands with the worker.
    const form = new FormData()
    form.set('channel_id', dm)
    form.set('files', new Blob([Buffer.from('the plan')]), 'plan.txt')
    const { file_infos } = await api<{ file_infos: { id: string }[] }>(ana.token, 'POST', '/files', form)
    await api(ana.token, 'POST', '/posts', { channel_id: dm, message: 'here it is', file_ids: [file_infos[0].id] })
    await until(() => requests.some((r) => textOf(r).includes('plan.txt')), 20_000, 'the file to reach the worker')

    // Ben calls on it in a channel; Ana lets the channel in; it answers in the thread it was called in.
    await api(ben.token, 'POST', '/posts', { channel_id: town, message: '@nova can you help the group?' })
    const request = await until(() => env.link().requests.find((r) => r.kind === 'chat'), 20_000, 'the channel’s request')
    assert.match((await until(async () => (await novaPosts(ana.token, dm)).find((p) => p.message.includes('wants to talk')), 20_000, 'the owner’s alert')).message, new RegExp(`!allow ${request.code}`))
    await api(ana.token, 'POST', '/posts', { channel_id: dm, message: `!allow ${request.code}` })
    await until(() => env.link().chats.some((c) => c.id === town), 20_000, 'the channel to be allowed')
    const root = await api<{ id: string }>(ben.token, 'POST', '/posts', { channel_id: town, message: 'a question for the group' })
    await api(ben.token, 'POST', '/posts', { channel_id: town, root_id: root.id, message: '@nova hello to the group' })
    const answered = await until(async () => (await novaPosts(ben.token, town)).find((p) => p.message.includes('Hello, group')), 20_000, 'the answer in the channel')
    assert.equal(answered.root_id, root.id)

    // Files back, typing, and a DM it opens itself.
    const extra = new MattermostConnector(env.tokens.get(link.id)!, { message: () => {}, status: () => {}, account: () => {} })
    extra.start()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await extra.typing(dm, true)
    const dir = mkdtempSync(join(tmpdir(), 'eaon-mm-'))
    writeFileSync(join(dir, 'report.txt'), 'report')
    await extra.sendFile(dm, join(dir, 'report.txt'), 'The report')
    assert.ok((await novaPosts(ana.token, dm)).some((p) => p.message === 'The report' && p.file_ids?.length === 1))
    assert.equal(await extra.directChat(ben.id), (await api<{ id: string }>(ben.token, 'POST', '/channels/direct', [ben.id, me.id])).id)
    await extra.stop()
  } finally {
    await teardown()
  }
})
