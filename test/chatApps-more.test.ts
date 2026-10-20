import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage as HttpRequest, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { store } from '../src/main/store'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import type { RunAgent } from '../src/main/features/workers/runner'
import type { FeatureContext } from '../src/main/features/types'
import { ChannelsService } from '../src/main/features/channels/service'
import { parseCommand, toMatrixHtml, toSlackMrkdwn, withCommandPrefix } from '../src/main/features/channels/format'
import { SlackConnector, verifySlackCredentials } from '../src/main/features/channels/slack'
import { ZulipConnector, verifyZulipCredentials, zulipCredentials } from '../src/main/features/channels/zulip'
import type { Connector, ConnectorEvents, IncomingMessage } from '../src/main/features/channels/types'
import { CHANNEL_KINDS, COMMAND_PREFIX, slackManifest, type ChannelKind, type ChannelLink, type ChannelStatus } from '@shared/channels'

/**
 * The chat apps added after Discord, Telegram and WhatsApp: Slack and Zulip
 * against fake servers that speak their documented protocols, `!` commands
 * where an app keeps `/` for itself, and each app's formatting. Matrix and
 * Mattermost are tested against real servers in chatApps-live.test.ts.
 */

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }

async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as { port: number }).port
}

async function readBody(req: HttpRequest): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const json = (res: ServerResponse, value: unknown, status = 200): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function recorder() {
  const messages: IncomingMessage[] = []
  const statuses: Omit<ChannelStatus, 'linkId'>[] = []
  const accounts: { account: string; selfId?: string }[] = []
  const events: ConnectorEvents = {
    message: (m) => messages.push(m),
    status: (s) => statuses.push(s),
    account: (a) => accounts.push(a)
  }
  return { events, messages, statuses, accounts, state: () => statuses[statuses.length - 1]?.state }
}

/* ------------------------------------------------------------- formatting */

test('each new app gets its own formatting, and ! commands work where / is the app’s own', () => {
  assert.equal(toSlackMrkdwn('**Done** & <ok> — see [the doc](https://x.y/a?b=1&c=2)'), '*Done* &amp; &lt;ok&gt; — see <https://x.y/a?b=1&c=2|the doc>')
  assert.equal(toSlackMrkdwn('# Plan\n- one\n*soft*'), '*Plan*\n• one\n_soft_')
  assert.equal(toMatrixHtml('**a**\nb\n```\nx\ny\n```'), '<b>a</b><br>b<br><pre>x\ny</pre>')
  assert.deepEqual(parseCommand('!pair ABC123'), { name: 'pair', args: 'ABC123' })
  assert.deepEqual(parseCommand('/status'), { name: 'status', args: '' })
  assert.equal(parseCommand('hey !help'), null)
  const names = ['allow', 'approve', 'decline', 'answer']
  assert.equal(withCommandPrefix('Send /allow K3XP. Reply /approve AB or /decline AB.', '!', names), 'Send !allow K3XP. Reply !approve AB or !decline AB.')
  assert.equal(withCommandPrefix('Look in /usr/bin and /allowed/x, and http://a.b/allow', '!', names), 'Look in /usr/bin and /allowed/x, and http://a.b/allow')
  assert.equal(withCommandPrefix('Send /allow K3XP.', '/', names), 'Send /allow K3XP.')
  assert.deepEqual(CHANNEL_KINDS.filter((k) => COMMAND_PREFIX[k] === '!'), ['slack', 'matrix', 'mattermost', 'zulip'])
  const manifest = JSON.parse(slackManifest('Nova <the> "great"')) as { settings: { socket_mode_enabled: boolean }; features: { bot_user: { display_name: string } } }
  assert.equal(manifest.settings.socket_mode_enabled, true)
  assert.equal(manifest.features.bot_user.display_name, 'Nova the great')
})

/* ---------------------------------------------- the service, with ! commands */

let workers: WorkersService | null = null
let channels: ChannelsService | null = null

beforeEach(() => {
  store.setJson('workers.json', [])
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: mkdtempSync(join(tmpdir(), 'eaon-chatapps-')) } })
})

afterEach(async () => {
  await channels?.stop()
  channels = null
  workers?.stop()
  await workers?.engine.whenIdle()
  workers = null
  await store.flushWrites()
})

class FakeConnector implements Connector {
  readonly typingEveryMs = 60_000
  sent: { chatId: string; text: string }[] = []
  constructor(
    readonly kind: ChannelKind,
    readonly events: ConnectorEvents
  ) {}
  start(): void {
    this.events.status({ state: 'connected' })
  }
  async stop(): Promise<void> {}
  async send(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text })
  }
  async sendFile(): Promise<void> {}
  async typing(): Promise<void> {}
  async directChat(userId: string): Promise<string> {
    return `dm-${userId}`
  }
}

test('a Slack bot pairs with !pair, and Eaon’s own notices there say !allow, never a worker’s words', async () => {
  const runAgent: RunAgent = async (request, emit) => {
    emit({ type: 'delta', messageId: request.messageId, text: 'Use /allow in Discord, not here.' })
    emit({ type: 'done', messageId: request.messageId })
    return { text: 'Use /allow in Discord, not here.', usage }
  }
  workers = createWorkersService({ ipcMain: { handle: () => {} }, getWindow: () => null, send: () => {}, emitStream: () => {} } as unknown as FeatureContext, {
    runAgent,
    startDelayMs: 60_000
  })
  workers.start()
  workers.engine.start()
  const connectors = new Map<string, FakeConnector>()
  const tokens = new Map<string, string>()
  let saved: ChannelLink[] = []
  channels = new ChannelsService({
    engine: workers.engine,
    loadLinks: () => saved,
    saveLinks: (links) => (saved = structuredClone(links)),
    getToken: (id) => tokens.get(id),
    setToken: (id, token) => (token ? tokens.set(id, token) : tokens.delete(id)),
    // As Matrix does: the stored credential is what verifying returned, not what was typed.
    verifyToken: async () => ({ account: '@nova in Acme', id: 'U_BOT', token: 'kept-session' }),
    createConnector: (link, _token, events) => {
      const connector = new FakeConnector(link.kind, events)
      connectors.set(link.id, connector)
      return connector
    }
  })
  channels.load()
  channels.start()
  const nova = workers.engine.save({ name: 'Nova', color: '#3E86C6', personality: '', purpose: 'help', model: { providerId: 'ollama', modelId: 'm' } })
  const link = channels.create('slack', nova.id)
  await channels.setToken(link.id, JSON.stringify({ bot: 'xoxb-1', app: 'xapp-1' }))
  assert.equal(tokens.get(link.id), 'kept-session')
  const connector = connectors.get(link.id)!
  const code = channels.list()[0].pairCode
  const base = { chatName: 'Direct message', isGroup: false, mentioned: false, files: [] }
  await channels.handle(link.id, { ...base, chatId: 'D1', senderId: 'U_SAM', senderName: 'Sam', messageId: '1', text: `!pair ${code}` })
  assert.equal(channels.list()[0].owner?.id, 'U_SAM')
  assert.match(connector.sent.at(-1)!.text, /send !help/)

  // A stranger asks; the owner hears about it with the command written for Slack.
  await channels.handle(link.id, { ...base, chatId: 'D2', senderId: 'U_ANA', senderName: 'Ana', messageId: '2', text: 'hi Nova' })
  const toOwner = connector.sent.find((s) => s.chatId === 'dm-U_SAM' && s.text.includes('wants to talk'))!
  assert.match(toOwner.text, /Send !allow [A-Z0-9]{4}/)
  const request = channels.list()[0].requests[0]
  await channels.handle(link.id, { ...base, chatId: 'D1', senderId: 'U_SAM', senderName: 'Sam', messageId: '3', text: `!allow ${request.code}` })
  assert.equal(channels.list()[0].people[0]?.id, 'U_ANA')

  // The worker's own words go as written.
  await channels.handle(link.id, { ...base, chatId: 'D1', senderId: 'U_SAM', senderName: 'Sam', messageId: '4', text: 'what should I use?' })
  await until(() => connector.sent.some((s) => s.text.includes('Use /allow in Discord')))
})

/* ------------------------------------------------------------------- Slack */

function fakeSlack() {
  const calls: { method: string; args: Record<string, string>; auth: string }[] = []
  const acks: string[] = []
  const uploads: Buffer[] = []
  const sockets: WebSocket[] = []
  let port = 0
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const body = await readBody(req)
    if (url.pathname === '/upload') {
      uploads.push(body)
      res.end('OK')
      return
    }
    if (url.pathname === '/files/f1') {
      if (req.headers.authorization !== 'Bearer xoxb-good') return void res.writeHead(302, { location: '/signin', 'content-type': 'text/html' }).end()
      res.end('file bytes')
      return
    }
    const method = url.pathname.replace('/api/', '')
    const args = Object.fromEntries(new URLSearchParams(body.toString()))
    const auth = String(req.headers.authorization ?? '')
    calls.push({ method, args, auth })
    const bad = (method === 'apps.connections.open' ? auth !== 'Bearer xapp-good' : auth !== 'Bearer xoxb-good')
    if (bad) return json(res, { ok: false, error: 'invalid_auth' })
    switch (method) {
      case 'auth.test':
        return json(res, { ok: true, user_id: 'U0BOT', user: 'nova', team: 'Acme' })
      case 'apps.connections.open':
        return json(res, { ok: true, url: `ws://127.0.0.1:${port}/socket` })
      case 'users.info':
        return json(res, { ok: true, user: { name: 'ana', profile: { display_name: args.user === 'U0ANA' ? 'Ana' : 'Ben' } } })
      case 'conversations.info':
        return json(res, { ok: true, channel: { name: 'general' } })
      case 'conversations.open':
        return json(res, { ok: true, channel: { id: 'D_NEW' } })
      case 'files.getUploadURLExternal':
        return json(res, { ok: true, upload_url: `http://127.0.0.1:${port}/upload`, file_id: 'F9' })
      default:
        return json(res, { ok: true, ts: '9.9' })
    }
  })
  const wss = new WebSocketServer({ server, path: '/socket' })
  wss.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (data) => acks.push(JSON.parse(String(data)).envelope_id))
    socket.send(JSON.stringify({ type: 'hello' }))
  })
  let envelope = 0
  const push = (event: Record<string, unknown>): string => {
    const id = `env-${++envelope}`
    sockets.at(-1)!.send(JSON.stringify({ envelope_id: id, type: 'events_api', payload: { event } }))
    return id
  }
  return {
    server,
    calls,
    acks,
    uploads,
    sockets,
    push,
    start: async () => {
      port = await listen(server)
      return `http://127.0.0.1:${port}/api`
    },
    close: () => {
      for (const s of sockets) s.terminate()
      wss.close()
      server.close()
    }
  }
}

test('Slack: checks both tokens, answers over Socket Mode, threads in channels, and sends files in three steps', async () => {
  const slack = fakeSlack()
  const api = await slack.start()
  const good = JSON.stringify({ bot: 'xoxb-good', app: 'xapp-good' })
  let connector: SlackConnector | null = null
  try {
    assert.deepEqual(await verifySlackCredentials(good, api), { account: '@nova in Acme', id: 'U0BOT' })
    await assert.rejects(verifySlackCredentials(JSON.stringify({ bot: 'xoxb-bad', app: 'xapp-good' }), api), /bot token/)
    await assert.rejects(verifySlackCredentials(JSON.stringify({ bot: 'xoxb-good', app: 'xapp-bad' }), api), /app-level token/)
    await assert.rejects(verifySlackCredentials(JSON.stringify({ bot: 'nope', app: 'xapp-good' }), api), /starts with xoxb-/)

    const r = recorder()
    connector = new SlackConnector(good, r.events, api)
    connector.start()
    await until(() => r.state() === 'connected')
    assert.deepEqual(r.accounts[0], { account: '@nova in Acme', selfId: 'U0BOT' })

    // A DM: acknowledged, read with Slack's markup undone.
    const first = slack.push({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U0ANA', ts: '1.1', text: 'see &lt;this&gt; <https://a.b|link> &amp; <@U0BEN>' })
    await until(() => r.messages.length === 1)
    assert.ok(slack.acks.includes(first))
    assert.deepEqual(
      { chatId: r.messages[0].chatId, isGroup: r.messages[0].isGroup, sender: r.messages[0].senderName, text: r.messages[0].text },
      { chatId: 'D1', isGroup: false, sender: 'Ana', text: 'see <this> link (https://a.b) & @Ben' }
    )

    // A mention in a channel comes as both `message` and `app_mention`: one message, called on, the mention gone.
    slack.push({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'U0ANA', ts: '2.2', text: '<@U0BOT> what now?' })
    slack.push({ type: 'app_mention', channel: 'C1', user: 'U0ANA', ts: '2.2', text: '<@U0BOT> what now?' })
    // Its own words, edits and other bots are not messages to it.
    slack.push({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'U0BOT', ts: '3.3', text: 'me' })
    slack.push({ type: 'message', subtype: 'message_changed', channel_type: 'channel', channel: 'C1', ts: '4.4' })
    slack.push({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'U0X', bot_id: 'B1', ts: '5.5', text: 'beep' })
    slack.push({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'U0ANA', ts: '6.6', thread_ts: '2.2', text: 'more', files: [{ id: 'f1', name: 'a.txt', size: 10, url_private_download: `${api.replace('/api', '')}/files/f1` }] })
    await until(() => r.messages.length === 3)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(r.messages.length, 3)
    assert.deepEqual({ chat: r.messages[1].chatName, group: r.messages[1].isGroup, mentioned: r.messages[1].mentioned, text: r.messages[1].text }, { chat: '#general', group: true, mentioned: true, text: 'what now?' })
    assert.equal((await r.messages[2].files[0].download()).toString(), 'file bytes')

    // Replies: in a channel, under the message; in a thread, in that thread; in a DM, plainly.
    await connector.send('C1', '**Sure**', '2.2')
    await connector.send('C1', 'and', '6.6')
    await connector.send('D1', 'hi', '1.1')
    const posts = slack.calls.filter((c) => c.method === 'chat.postMessage').map((c) => ({ channel: c.args.channel, text: c.args.text, thread: c.args.thread_ts }))
    assert.deepEqual(posts, [
      { channel: 'C1', text: '*Sure*', thread: '2.2' },
      { channel: 'C1', text: 'and', thread: '2.2' },
      { channel: 'D1', text: 'hi', thread: undefined }
    ])

    const dir = mkdtempSync(join(tmpdir(), 'eaon-slack-'))
    writeFileSync(join(dir, 'report.txt'), 'the report')
    await connector.sendFile('C1', join(dir, 'report.txt'), 'Here')
    assert.equal(slack.uploads[0].toString(), 'the report')
    const complete = slack.calls.find((c) => c.method === 'files.completeUploadExternal')!
    assert.deepEqual(JSON.parse(complete.args.files), [{ id: 'F9', title: 'report.txt' }])
    assert.equal(complete.args.channel_id, 'C1')
    assert.equal(await connector.directChat('U0ANA'), 'D_NEW')

    // Slack rotates connections: a disconnect is followed by a new one at once.
    const opened = slack.calls.filter((c) => c.method === 'apps.connections.open').length
    slack.sockets.at(-1)!.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }))
    await until(() => slack.calls.filter((c) => c.method === 'apps.connections.open').length === opened + 1 && slack.sockets.length === 2)
    slack.push({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U0ANA', ts: '7.7', text: 'still there?' })
    await until(() => r.messages.length === 4)

    await connector.stop()
    assert.equal(r.state(), 'off')
  } finally {
    await connector?.stop()
    slack.close()
  }
})

/* ------------------------------------------------------------------- Zulip */

function fakeZulip() {
  const sent: Record<string, string>[] = []
  const typing: Record<string, string>[] = []
  let registers = 0
  let expireNext = false
  const waiting: ((events: unknown[]) => void)[] = []
  let nextEvent = 1
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const body = Object.fromEntries(new URLSearchParams((await readBody(req)).toString()))
    const auth = Buffer.from(String(req.headers.authorization ?? '').replace('Basic ', ''), 'base64').toString()
    if (url.pathname === '/user_uploads/temp/notes.txt') return void res.end('zulip file')
    if (auth !== 'nova-bot@z.test:good-key') return json(res, { result: 'error', msg: 'Invalid API key', code: 'INVALID_API_KEY' }, 401)
    switch (url.pathname) {
      case '/api/v1/users/me':
        return json(res, { result: 'success', user_id: 7, email: 'nova-bot@z.test', full_name: 'Nova' })
      case '/api/v1/register':
        registers++
        return json(res, { result: 'success', queue_id: `q${registers}`, last_event_id: -1 })
      case '/api/v1/events':
        if (expireNext) {
          expireNext = false
          return json(res, { result: 'error', msg: 'Bad event queue id', code: 'BAD_EVENT_QUEUE_ID' }, 400)
        }
        waiting.push((events) => json(res, { result: 'success', events }))
        return
      case '/api/v1/messages':
        sent.push(body)
        return json(res, { result: 'success', id: 99 })
      case '/api/v1/typing':
        typing.push(body)
        return json(res, { result: 'success' })
      case '/api/v1/user_uploads':
        return json(res, { result: 'success', url: '/user_uploads/1/ab/report.txt' })
      default:
        if (url.pathname.startsWith('/api/v1/user_uploads/')) return json(res, { result: 'success', url: '/user_uploads/temp/notes.txt' })
        return json(res, { result: 'error', msg: 'no' }, 404)
    }
  })
  return {
    server,
    sent,
    typing,
    registers: () => registers,
    expire: () => (expireNext = true),
    push: async (message: Record<string, unknown>, flags: string[] = []) => {
      await until(() => waiting.length > 0)
      waiting.shift()!([{ id: nextEvent++, type: 'message', message, flags }])
    },
    heartbeat: async () => {
      await until(() => waiting.length > 0)
      waiting.shift()!([{ id: nextEvent++, type: 'heartbeat' }])
    },
    close: () => {
      for (const w of waiting.splice(0)) w([])
      server.closeAllConnections()
      server.close()
    }
  }
}

test('Zulip: a bot’s key from fields or a zuliprc, an event queue that comes back when it expires, and answers in the topic', async () => {
  const zulip = fakeZulip()
  const port = await listen(zulip.server)
  const server = `http://127.0.0.1:${port}`
  try {
    assert.deepEqual(zulipCredentials(JSON.stringify({ zuliprc: `[api]\nemail=nova-bot@z.test\nkey=good-key\nsite=${server}\n` })), { server, email: 'nova-bot@z.test', key: 'good-key' })
    assert.throws(() => zulipCredentials(JSON.stringify({ server, email: 'nope', key: 'k' })), /bot’s email/)
    const good = JSON.stringify({ server, email: 'nova-bot@z.test', key: 'good-key' })
    const verified = await verifyZulipCredentials(good)
    assert.equal(verified.account, 'Nova')
    await assert.rejects(verifyZulipCredentials(JSON.stringify({ server, email: 'nova-bot@z.test', key: 'bad' })), /didn’t accept/)

    const r = recorder()
    const connector = new ZulipConnector(verified.token, r.events)
    connector.start()
    await zulip.heartbeat()
    await until(() => r.state() === 'connected')

    await zulip.push({ id: 11, sender_id: 3, sender_full_name: 'Ana', sender_email: 'ana@z.test', type: 'private', display_recipient: [{ id: 3, email: 'ana@z.test', full_name: 'Ana' }, { id: 7, email: 'nova-bot@z.test', full_name: 'Nova' }], content: 'hello [notes.txt](/user_uploads/1/ab/notes.txt)' })
    await until(() => r.messages.length === 1)
    assert.deepEqual({ chat: r.messages[0].chatId, group: r.messages[0].isGroup, text: r.messages[0].text }, { chat: 'dm:3', group: false, text: 'hello' })
    assert.equal((await r.messages[0].files[0].download()).toString(), 'zulip file')

    // The queue expired: a new one, and nothing is lost after it.
    zulip.expire()
    await zulip.push({ id: 12, sender_id: 3, sender_full_name: 'Ana', sender_email: 'ana@z.test', type: 'stream', display_recipient: 'general', stream_id: 5, subject: 'plans', content: '@**Nova** what next?' }, ['mentioned'])
    await until(() => r.messages.length === 2)
    await zulip.push({ id: 13, sender_id: 3, sender_full_name: 'Ana', sender_email: 'ana@z.test', type: 'stream', display_recipient: 'general', stream_id: 5, subject: 'plans', content: 'after expiry' })
    await until(() => r.messages.length === 3)
    assert.ok(zulip.registers() >= 2)
    assert.deepEqual({ chat: r.messages[1].chatId, name: r.messages[1].chatName, mentioned: r.messages[1].mentioned, text: r.messages[1].text }, { chat: 'stream:5', name: '#general', mentioned: true, text: 'what next?' })

    await connector.send('stream:5', 'In the topic', '12')
    await connector.send('dm:3', 'Privately')
    await connector.typing('dm:3', true)
    assert.deepEqual(zulip.sent[0], { type: 'stream', to: '5', topic: 'plans', content: 'In the topic' })
    assert.deepEqual(zulip.sent[1], { type: 'private', to: '[3]', content: 'Privately' })
    assert.deepEqual(zulip.typing[0], { op: 'start', to: '[3]' })
    const dir = mkdtempSync(join(tmpdir(), 'eaon-zulip-'))
    writeFileSync(join(dir, 'report.txt'), 'r')
    await connector.sendFile('dm:3', join(dir, 'report.txt'))
    assert.equal(zulip.sent[2].content, '[report.txt](/user_uploads/1/ab/report.txt)')

    const stopping = connector.stop()
    zulip.close()
    await stopping
    assert.equal(r.state(), 'off')
  } finally {
    zulip.close()
  }
})
