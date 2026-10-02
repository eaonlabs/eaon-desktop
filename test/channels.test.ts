import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage as HttpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RunOptions, RunOutcome } from '../src/main/agent/loop'
import type { AgentTool } from '../src/main/agent/tools'
import { store } from '../src/main/store'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import type { RunAgent } from '../src/main/features/workers/runner'
import { guestCap, guestGate, isPrivateHost } from '../src/main/features/workers/guests'
import type { FeatureContext } from '../src/main/features/types'
import { ChannelsService } from '../src/main/features/channels/service'
import { calledByName, chunkText, parseCommand, replyText, toTelegramHtml, toWhatsApp } from '../src/main/features/channels/format'
import { TelegramConnector } from '../src/main/features/channels/telegram'
import { DiscordConnector } from '../src/main/features/channels/discord'
import type { Connector, ConnectorEvents, IncomingMessage } from '../src/main/features/channels/types'
import type { ChannelKind, ChannelLink, ChannelStatus } from '@shared/channels'
import type { ChatMessage, StreamEvent, StreamRequest } from '@shared/types'
import type { WorkerDraft, WorkerMail } from '@shared/workers'

/**
 * Chat apps: pairing, who may talk to a worker, guest limits held by the
 * loop, commands, replies going back to the chat they came from, and the
 * Telegram and Discord connectors against fake servers. The worker's model is
 * faked; the engine is the real one.
 */

const MODEL = { providerId: 'ollama', modelId: 'fake-model' }
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }

let workers: WorkersService | null = null
let channels: ChannelsService | null = null
let root = ''

beforeEach(() => {
  store.setJson('workers.json', [])
  root = mkdtempSync(join(tmpdir(), 'eaon-channels-'))
  const settings = store.getSettings()
  store.patchSettings({ work: { ...settings.work, defaultFolder: root } })
})

afterEach(async () => {
  await channels?.stop()
  channels = null
  workers?.stop()
  await workers?.engine.whenIdle()
  workers = null
  await store.flushWrites()
})

async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function fakeContext(): FeatureContext {
  return {
    ipcMain: { handle: () => {} },
    getWindow: () => null,
    send: () => {},
    emitStream: () => {}
  } as unknown as FeatureContext
}

type Behaviour = (request: StreamRequest, emit: (event: StreamEvent) => void, options: RunOptions) => Promise<RunOutcome> | RunOutcome

function fakeAgent(behave: Behaviour | string = 'Done.') {
  const requests: StreamRequest[] = []
  const options: RunOptions[] = []
  const runAgent: RunAgent = async (request, emit, opts) => {
    requests.push(structuredClone(request))
    options.push(opts)
    if (typeof behave === 'string') {
      emit({ type: 'delta', messageId: request.messageId, text: behave })
      emit({ type: 'done', messageId: request.messageId })
      return { text: behave, usage }
    }
    return behave(request, emit, opts)
  }
  return { runAgent, requests, options }
}

/** A chat app that records what the service says and lets the test say things back. */
class FakeConnector implements Connector {
  readonly typingEveryMs = 60_000
  sent: { chatId: string; text: string; replyTo?: string }[] = []
  files: { chatId: string; path: string }[] = []
  typingOn: string[] = []
  started = false
  constructor(
    readonly kind: ChannelKind,
    readonly events: ConnectorEvents
  ) {}
  start(): void {
    this.started = true
    this.events.status({ state: 'connected' })
  }
  async stop(): Promise<void> {
    this.started = false
  }
  async send(chatId: string, text: string, replyTo?: string): Promise<void> {
    this.sent.push({ chatId, text, ...(replyTo ? { replyTo } : {}) })
  }
  async sendFile(chatId: string, path: string): Promise<void> {
    this.files.push({ chatId, path })
  }
  async typing(chatId: string, on: boolean): Promise<void> {
    if (on) this.typingOn.push(chatId)
  }
  async directChat(userId: string): Promise<string> {
    return `dm-${userId}`
  }
  said(chatId?: string): string[] {
    return this.sent.filter((s) => !chatId || s.chatId === chatId).map((s) => s.text)
  }
}

function setup(behave: Behaviour | string = 'Done.') {
  const agent = fakeAgent(behave)
  workers = createWorkersService(fakeContext(), { runAgent: agent.runAgent, startDelayMs: 60_000 })
  workers.start()
  workers.engine.start()
  const connectors = new Map<string, FakeConnector>()
  const tokens = new Map<string, string>()
  let saved: ChannelLink[] = []
  const statuses: ChannelStatus[][] = []
  channels = new ChannelsService({
    engine: workers.engine,
    loadLinks: () => saved,
    saveLinks: (links) => (saved = structuredClone(links)),
    getToken: (id) => tokens.get(id),
    setToken: (id, token) => (token ? tokens.set(id, token) : tokens.delete(id)),
    verifyToken: async (kind, token) => {
      if (token === 'bad') throw new Error('Telegram didn’t accept that token.')
      return { account: kind === 'telegram' ? '@NovaBot' : 'NovaBot', id: 'app-1' }
    },
    createConnector: (link, _token, events) => {
      const connector = new FakeConnector(link.kind, events)
      connectors.set(link.id, connector)
      return connector
    },
    onStatus: (list) => statuses.push(list)
  })
  channels.load()
  channels.start()
  return { agent, engine: workers.engine, channels, connectors, tokens, statuses, saved: () => saved }
}

function draft(name: string, extra: Partial<WorkerDraft> = {}): WorkerDraft {
  return { name, color: '#3E86C6', personality: '', purpose: `${name}'s job`, model: MODEL, ...extra }
}

let nextId = 1
function message(extra: Partial<IncomingMessage>): IncomingMessage {
  return {
    chatId: 'owner-chat',
    chatName: 'Direct message',
    isGroup: false,
    senderId: 'owner',
    senderName: 'Sam',
    messageId: `m${nextId++}`,
    text: 'hello',
    mentioned: false,
    files: [],
    ...extra
  }
}

/** A Telegram link for Nova, paired with the user ('owner'). */
async function pairedTelegram(env: ReturnType<typeof setup>) {
  const nova = env.engine.save(draft('Nova'))
  const link = env.channels.create('telegram', nova.id)
  await env.channels.setToken(link.id, '123:token')
  const connector = env.connectors.get(link.id)!
  const code = env.channels.list()[0].pairCode
  await env.channels.handle(link.id, message({ text: `/pair ${code}` }))
  return { nova, link: env.channels.list()[0], connector }
}

const lastUserText = (request: StreamRequest): string => {
  const last = request.history[request.history.length - 1]
  return last.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/* ------------------------------------------------------------- format */

test('replies are split on paragraph breaks and formatted for each app', () => {
  const long = `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`
  assert.deepEqual(chunkText(long, 2000).map((c) => c.length), [1500, 1500])
  assert.ok(chunkText('x'.repeat(5000), 2000).every((c) => c.length <= 2000))

  assert.equal(toTelegramHtml('**Done** — see `a<b>` and [docs](https://x.dev/a_b_c)'), '<b>Done</b> — see <code>a&lt;b&gt;</code> and <a href="https://x.dev/a_b_c">docs</a>')
  assert.equal(toTelegramHtml('```js\nif (a < b) {}\n```'), '<pre>if (a &lt; b) {}</pre>')
  assert.equal(toTelegramHtml('see https://x.dev/_a_ now'), 'see https://x.dev/_a_ now', 'bare links keep their underscores')
  assert.equal(toWhatsApp('**Bold**, *italic*, ~~gone~~ and [site](https://x.dev)'), '*Bold*, _italic_, ~gone~ and site (https://x.dev)')
  assert.equal(toWhatsApp('# Title\n- one'), '*Title*\n• one')
})

test('a worker is called by name, and commands are parsed with or without a bot suffix', () => {
  assert.equal(calledByName('Nova, what’s the weather?', 'Nova'), 'what’s the weather?')
  assert.equal(calledByName('hey nova: hi', 'Nova'), 'hi')
  assert.equal(calledByName('@Nova /status', 'Nova'), '/status')
  assert.equal(calledByName('Novak, hi', 'Nova'), null, 'a longer word is not the name')
  assert.equal(calledByName('I asked Nova', 'Nova'), null)
  assert.deepEqual(parseCommand('/status@NovaBot'), { name: 'status', args: '' })
  assert.deepEqual(parseCommand('/use  Data Wrangler'), { name: 'use', args: 'Data Wrangler' })
  assert.equal(parseCommand('not /a command'), null)
})

test('the reply is what the worker wrote after its last real tool call', () => {
  const msg = (parts: ChatMessage['parts']): ChatMessage => ({ id: 'a', role: 'assistant', parts, createdAt: 0 })
  const tool = (name: string) => ({ type: 'tool' as const, id: name, name, input: {}, output: 'ok', status: 'done' as const })
  assert.equal(replyText(msg([{ type: 'text', text: 'Let me look.' }, tool('web_search'), { type: 'text', text: 'It is sunny.' }])), 'It is sunny.')
  assert.equal(
    replyText(msg([tool('web_search'), { type: 'text', text: 'It is sunny.' }, tool('set_status'), { type: 'text', text: '' }])),
    'It is sunny.',
    'status bookkeeping at the end does not swallow the answer'
  )
  assert.equal(replyText(msg([{ type: 'text', text: 'Checking.' }, tool('read_file')])), 'Checking.', 'nothing after the tool: everything it said')
})

/* ------------------------------------------------------------- guests */

test('a guest’s message caps the turn, and the gate keeps guests from lasting changes and the local network', () => {
  const mail = (cap?: 'talk' | 'read-only' | 'safe' | 'autonomous'): WorkerMail => ({
    id: 'x',
    from: cap ? 'guest' : 'user',
    fromName: 'A',
    text: 'hi',
    files: [],
    at: 0,
    ...(cap ? { channel: { linkId: 'l', kind: 'telegram', chatId: 'c', chatName: 'DM', isGroup: false, messageId: '1', senderId: 's', cap } } : {})
  })
  assert.equal(guestCap([mail()], 'autonomous'), null, 'the user alone: no cap')
  assert.equal(guestCap([mail(), mail('safe')], 'autonomous'), 'safe')
  assert.equal(guestCap([mail('autonomous')], 'read-only'), 'read-only', 'never above the worker itself')
  assert.equal(guestCap([mail('safe'), mail('talk')], 'autonomous'), 'talk', 'the weakest wins')

  const tool = (name: string): AgentTool => ({ name, description: '', inputSchema: {}, mutating: false, run: async () => '' })
  const talk = guestGate('talk')!
  assert.equal(talk(tool('web_search'), {}), null)
  assert.equal(talk(tool('web_fetch'), { url: 'https://example.com' }), null)
  assert.match(talk(tool('web_fetch'), { url: 'http://127.0.0.1:11434/api/tags' })!, /network/)
  assert.match(talk(tool('read_file'), {})!, /only talk/)
  assert.match(talk(tool('set_heartbeat'), {})!, /later turns/)
  const look = guestGate('read-only')!
  assert.equal(look(tool('read_file'), {}), null)
  assert.match(look(tool('add_routine'), {})!, /later turns/)
  assert.match(look(tool('message_worker'), {})!, /later turns/, 'a guest cannot reach a colleague with more access')
  for (const name of ['email_send', 'email_read', 'trading_order', 'trading_account']) {
    assert.match(guestGate('safe')!(tool(name), {})!, /the user's alone/, name)
  }
  for (const name of ['web_browser', 'browser', 'computer']) {
    assert.match(look(tool(name), { action: 'screenshot' })!, /accounts or screen/, `${name}: even looking is private`)
    assert.match(guestGate('safe')!(tool(name), {})!, /accounts or screen/, name)
  }
  assert.equal(guestGate('autonomous'), undefined)

  for (const host of ['localhost', '10.0.0.4', '192.168.1.1', '172.20.0.1', '[::1]', 'router', 'nas.local', 'fd12:3456::1']) assert.ok(isPrivateHost(host), host)
  for (const host of ['example.com', '8.8.8.8', 'fcbarcelona.com', '172.32.0.1']) assert.ok(!isPrivateHost(host), host)
})

/* ---------------------------------------------------------- the service */

test('the user pairs a bot with a code, then talks to the worker and gets its reply in the same chat', async () => {
  const env = setup('It is sunny in Lisbon.')
  const nova = env.engine.save(draft('Nova'))
  const link = env.channels.create('telegram', nova.id)
  assert.equal(link.enabled, false, 'a bot waits for its token')
  await assert.rejects(env.channels.setToken(link.id, 'bad'), /didn’t accept/)
  const ready = await env.channels.setToken(link.id, '123:token')
  assert.equal(ready.account, '@NovaBot')
  assert.equal(env.tokens.get(link.id), '123:token', 'the token goes to the vault')
  assert.ok(!JSON.stringify(env.saved()).includes('123:token'), 'and never into channels.json')
  const connector = env.connectors.get(link.id)!
  assert.ok(connector.started)

  // Before pairing, nobody is the owner: a message gets the setup hint and becomes a request.
  await env.channels.handle(link.id, message({ text: 'hi' }))
  assert.match(connector.said()[0], /isn’t set up yet/)
  assert.equal(env.agent.requests.length, 0)

  await env.channels.handle(link.id, message({ text: '/pair WRONG1' }))
  assert.match(connector.said().at(-1)!, /doesn’t match/)
  const code = env.channels.list()[0].pairCode
  await env.channels.handle(link.id, message({ text: `/pair ${code.toLowerCase()}` }))
  assert.match(connector.said().at(-1)!, /Paired/)
  const paired = env.channels.list()[0]
  assert.deepEqual(paired.owner, { id: 'owner', name: 'Sam' })
  assert.notEqual(paired.pairCode, code, 'a used code is replaced')
  assert.equal(paired.requests.length, 0, 'the owner’s own request is cleared')

  await env.channels.handle(link.id, message({ text: 'Weather in Lisbon?' }))
  await until(() => env.agent.requests.length === 1)
  await env.engine.whenIdle()
  await settle()
  assert.match(lastUserText(env.agent.requests[0]), /\[From the user, in a direct message on Telegram\] Weather in Lisbon\?/)
  assert.match(lastUserText(env.agent.requests[0]), /\[Chat apps\]/)
  assert.equal(env.agent.options[0].unattended, 'autonomous', 'the owner’s message runs with the worker’s own access')
  assert.equal(env.agent.options[0].toolGate, undefined)
  assert.ok(connector.typingOn.includes('owner-chat'), 'shows typing while the worker works')
  assert.equal(connector.said('owner-chat').at(-1), 'It is sunny in Lisbon.')
  const thread = env.engine.getThread(nova.id)
  assert.equal(thread.messages[0].mail?.[0].channel?.kind, 'telegram', 'the transcript knows where the message came from')
})

test('a friend asks, the owner allows them from the chat, and their turns are held to talk-only', async () => {
  const env = setup('Hi Alex!')
  const { nova, link, connector } = await pairedTelegram(env)

  await env.channels.handle(link.id, message({ chatId: 'alex-chat', senderId: 'alex', senderName: 'Alex', text: 'Hey Nova' }))
  assert.match(connector.said('alex-chat')[0], /only talks with people Sam lets in/)
  const request = env.channels.list()[0].requests[0]
  assert.equal(request.kind, 'person')
  assert.match(connector.said('dm-owner').at(-1)!, new RegExp(`Alex wants to talk to Nova.*\\n.*/allow ${request.code}`), 'the owner hears about it')
  assert.equal(env.agent.requests.length, 0)

  // Asking again does not repeat the notice or make a second request.
  await env.channels.handle(link.id, message({ chatId: 'alex-chat', senderId: 'alex', senderName: 'Alex', text: 'hello?' }))
  assert.equal(connector.said('alex-chat').length, 1)
  assert.equal(env.channels.list()[0].requests.length, 1)

  // Only the owner may let people in.
  await env.channels.handle(link.id, message({ chatId: 'alex-chat', senderId: 'alex', senderName: 'Alex', text: `/allow ${request.code}` }))
  assert.equal(env.channels.list()[0].people.length, 0)

  await env.channels.handle(link.id, message({ text: `/allow ${request.code}` }))
  assert.deepEqual(env.channels.list()[0].people.map((p) => [p.id, p.level]), [['alex', 'chat']])
  await settle()
  assert.match(connector.said('dm-alex').at(-1)!, /You’re in/)

  await env.channels.handle(link.id, message({ chatId: 'alex-chat', senderId: 'alex', senderName: 'Alex', text: 'What can you do?' }))
  await until(() => env.agent.requests.length === 1)
  await env.engine.whenIdle()
  await settle()
  const turn = lastUserText(env.agent.requests[0])
  assert.match(turn, /\[From Alex, in a direct message on Telegram — a guest, not the user\] What can you do\?/)
  assert.match(turn, /\[Guests\].*only talk and search the web/)
  assert.equal(env.agent.options[0].unattended, 'read-only')
  assert.ok(env.agent.options[0].toolGate, 'the loop holds the turn to talk-only')
  assert.equal(connector.said('alex-chat').at(-1), 'Hi Alex!')
  assert.equal(env.engine.list().find((w) => w.id === nova.id)!.inbox.length, 0)

  // Chat-level friends can't control the worker; raising them to control lets them.
  await env.channels.handle(link.id, message({ chatId: 'alex-chat', senderId: 'alex', senderName: 'Alex', text: '/pause' }))
  assert.match(connector.said('alex-chat').at(-1)!, /Only people with control/)
  env.channels.setPersonLevel(link.id, 'alex', 'control')
  await env.channels.handle(link.id, message({ chatId: 'alex-chat', senderId: 'alex', senderName: 'Alex', text: '/pause' }))
  assert.ok(env.engine.list()[0].paused)
  await env.channels.handle(link.id, message({ chatId: 'alex-chat', senderId: 'alex', senderName: 'Alex', text: '/workers' }))
  assert.match(connector.said('alex-chat').at(-1)!, /Only Sam can use \/workers/)
})

test('in a group the bot answers only when called on, and a group the owner allows lets everyone in it talk', async () => {
  const env = setup('Sure thing.')
  const { link, connector } = await pairedTelegram(env)
  const group = { chatId: 'g1', chatName: 'Weekend plans', isGroup: true }

  await env.channels.handle(link.id, message({ ...group, senderId: 'bea', senderName: 'Bea', text: 'anyone up for hiking?' }))
  assert.equal(connector.sent.filter((s) => s.chatId === 'g1').length, 0, 'not addressed: ignored')

  await env.channels.handle(link.id, message({ ...group, senderId: 'bea', senderName: 'Bea', text: 'find us a trail', mentioned: true }))
  assert.match(connector.said('g1')[0], /will answer here once Sam allows it/)
  const request = env.channels.list()[0].requests[0]
  assert.equal(request.kind, 'chat')
  env.channels.allow(link.id, request.code)
  assert.deepEqual(env.channels.list()[0].chats.map((c) => c.name), ['Weekend plans'])

  const asked = message({ ...group, senderId: 'bea', senderName: 'Bea', text: 'Nova, find us a trail' })
  await env.channels.handle(link.id, asked)
  await until(() => env.agent.requests.length === 1)
  await env.engine.whenIdle()
  await settle()
  assert.match(lastUserText(env.agent.requests[0]), /\[From Bea, in Weekend plans on Telegram — a guest, not the user\] find us a trail/)
  const reply = connector.sent.filter((s) => s.chatId === 'g1').at(-1)!
  assert.deepEqual(reply, { chatId: 'g1', text: 'Sure thing.', replyTo: asked.messageId }, 'a group reply quotes the message it answers')

  env.channels.update(link.id, { groupReplies: 'all' })
  await env.channels.handle(link.id, message({ ...group, senderId: 'cal', senderName: 'Cal', text: 'what time?' }))
  await until(() => env.agent.requests.length === 2)
})

test('the owner controls the worker from the chat, and hears its questions and failures', async () => {
  let fail = false
  const env = setup(async (request, emit) => {
    if (fail) return { text: '', error: 'The model is offline', usage }
    emit({ type: 'delta', messageId: request.messageId, text: 'On it.' })
    return { text: 'On it.', usage }
  })
  const { nova, link, connector } = await pairedTelegram(env)
  const say = async (text: string): Promise<string> => {
    await env.channels.handle(link.id, message({ text }))
    return connector.said('owner-chat').at(-1)!
  }
  assert.match(await say('/help'), /\/status — What the worker is doing/)
  assert.match(await say('/status'), /^Nova: Ready for its first job/)
  assert.match(await say('/pause'), /paused/)
  assert.ok(env.engine.list()[0].paused)
  assert.match(await say('/resume'), /back at work/)
  assert.match(await say('/stop'), /isn’t doing anything/)

  const scout = env.engine.save(draft('Scout'))
  assert.match(await say('/workers'), /• Nova \(this bot\).*\n• Scout/)
  assert.match(await say('/use scout'), /now speaks for Scout/)
  assert.equal(env.channels.list()[0].workerId, scout.id)
  await say(`/use Nova`)

  // A question the worker asks reaches the owner, who answers from the chat.
  env.engine.ask(nova.id, { question: 'Which city?', options: ['Lisbon', 'Porto'] })
  await settle()
  assert.match(connector.said('dm-owner').at(-1)!, /Nova has a question: Which city\?\n1\. Lisbon\n2\. Porto/)
  assert.match(await say('/answer 2'), /Sent to Nova/)
  await until(() => env.agent.requests.length === 1)
  await env.engine.whenIdle()
  assert.match(lastUserText(env.agent.requests[0]), /\[Answer to "Which city\?"\] Porto/)

  fail = true
  await say('Try again')
  await until(() => env.agent.requests.length === 2)
  await env.engine.whenIdle()
  await settle()
  assert.equal(connector.said('owner-chat').at(-1), 'Something went wrong: The model is offline')
})

test('a worker posts on its own with send_chat_message, only in its chats, and a guest turn can’t reach elsewhere', async () => {
  let post: (() => Promise<string>) | null = null
  const results: (string | Error)[] = []
  const env = setup(async (request, emit) => {
    if (post) {
      results.push(await post().catch((e: Error) => e))
      post = null
    }
    emit({ type: 'delta', messageId: request.messageId, text: 'Posted.' })
    return { text: 'Posted.', usage }
  })
  const { nova, link, connector } = await pairedTelegram(env)
  env.channels.addChat(link.id, 'g1', 'Weekend plans')
  const report = join(nova.folder, 'report.txt')
  writeFileSync(report, 'numbers')

  const destinations = env.channels.destinations(nova.id).map((d) => d.label)
  assert.deepEqual(destinations, ['Telegram: the user', 'Telegram: Weekend plans'])
  assert.match(await env.channels.post(nova.id, 'weekend', 'Morning digest', ['report.txt']), /Posted in Telegram: Weekend plans with 1 file/)
  assert.deepEqual(connector.files, [{ chatId: 'g1', path: realpathSync(report) }])
  await assert.rejects(env.channels.post(nova.id, 'weekend', 'x', ['/etc/hosts']), /outside your folder/)
  await assert.rejects(env.channels.post(nova.id, 'nowhere', 'x'), /No connected chat matches "nowhere".*\n- Telegram: the user/s)

  // A guest in the group asks; during that turn the worker may post only in the group.
  env.channels.update(link.id, { guestAccess: 'read-only' })
  post = () => env.channels.post(nova.id, 'the user', 'psst')
  await env.channels.handle(link.id, message({ chatId: 'g1', chatName: 'Weekend plans', isGroup: true, senderId: 'bea', senderName: 'Bea', text: 'Nova, hi' }))
  await until(() => results.length === 1)
  await env.engine.whenIdle()
  assert.match(String(results[0]), /only post in the chat it came from/)

  // When the worker posted the answer itself, the automatic reply is not sent twice.
  post = () => env.channels.post(nova.id, 'Weekend plans', 'Here you go')
  const before = connector.said('g1').length
  await env.channels.handle(link.id, message({ chatId: 'g1', chatName: 'Weekend plans', isGroup: true, senderId: 'bea', senderName: 'Bea', text: 'Nova, again' }))
  await until(() => results.length === 2)
  await env.engine.whenIdle()
  await settle()
  assert.deepEqual(connector.said('g1').slice(before), ['Here you go'])
})

test('a WhatsApp link on the user’s own number answers only when called, signs its words, and never speaks to strangers', async () => {
  const env = setup('Buy milk.')
  const nova = env.engine.save(draft('Nova'))
  const link = env.channels.create('whatsapp', nova.id)
  assert.equal(link.enabled, true, 'WhatsApp starts linking at once')
  const connector = env.connectors.get(link.id)!
  connector.events.account({ account: '+447700900123', selfId: '447700900123@s.whatsapp.net', selfName: 'Sam' })
  assert.deepEqual(env.channels.list()[0].owner, { id: '447700900123@s.whatsapp.net', name: 'Sam' }, 'the linked account is the owner')

  const self = { senderId: '447700900123@s.whatsapp.net', fromSelf: true }
  // The user chatting with a friend as usual: not for the worker.
  await env.channels.handle(link.id, message({ ...self, chatId: 'friend@s.whatsapp.net', text: 'see you at 8' }))
  // A stranger writing to the user: nothing goes back to them; the user hears privately.
  await env.channels.handle(link.id, message({ chatId: 'x@s.whatsapp.net', senderId: 'x@s.whatsapp.net', senderName: 'Xan', text: 'Nova, hello' }))
  assert.equal(connector.said('x@s.whatsapp.net').length, 0)
  assert.equal(connector.said('friend@s.whatsapp.net').length, 0)
  assert.equal(env.channels.list()[0].requests.length, 1)
  assert.match(connector.said('dm-447700900123@s.whatsapp.net').at(-1)!, /^\*Nova:\* Xan wants to talk to Nova on WhatsApp/)

  await env.channels.handle(link.id, message({ ...self, chatId: '447700900123@s.whatsapp.net', selfChat: true, text: 'What do I need from the shop?' }))
  await until(() => env.agent.requests.length === 1)
  await env.engine.whenIdle()
  await settle()
  assert.equal(connector.said('447700900123@s.whatsapp.net').at(-1), '*Nova:* Buy milk.', 'signed, since it goes out as the user')

  await env.channels.handle(link.id, message({ ...self, chatId: 'fam@g.us', chatName: 'Family', isGroup: true, text: 'Nova, remind us about Sunday' }))
  await until(() => env.agent.requests.length === 2)
  assert.match(lastUserText(env.agent.requests[1]), /\[From the user, in Family on WhatsApp\] remind us about Sunday/)
})

test('guests are rate limited, and files they send land in the worker’s folder', async () => {
  const env = setup('Got it.')
  const { nova, link, connector } = await pairedTelegram(env)
  env.channels.addChat(link.id, 'g1', 'Weekend plans')
  const group = { chatId: 'g1', chatName: 'Weekend plans', isGroup: true, senderId: 'bea', senderName: 'Bea', mentioned: true }
  await env.channels.handle(
    link.id,
    message({ ...group, text: 'here’s the map', files: [{ name: '../../map.png', size: 4, download: async () => Buffer.from('png!') }], unsupported: undefined })
  )
  await until(() => env.agent.requests.length === 1)
  await env.engine.whenIdle()
  const saved = join(nova.folder, 'from-telegram', 'map.png')
  assert.ok(existsSync(saved), 'saved under from-telegram, with any folder parts dropped')
  assert.equal(readFileSync(saved, 'utf8'), 'png!')
  assert.match(lastUserText(env.agent.requests[0]), new RegExp(`Files \\(copied into your folder\\): ${saved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

  for (let i = 0; i < 25; i++) await env.channels.handle(link.id, message({ ...group, text: `spam ${i}` }))
  assert.equal(connector.said('g1').filter((t) => /breather/.test(t)).length, 1, 'told once')
  const mailed = env.engine.list()[0].inbox.length + env.agent.requests.length
  assert.ok(mailed <= 21, `at most 20 guest messages an hour reach the worker (got ${mailed})`)
})

test('Telegram’s Start button pairs with the code in its payload; a bot whose token went missing asks for it again', async () => {
  const env = setup()
  const nova = env.engine.save(draft('Nova'))
  const link = env.channels.create('telegram', nova.id)
  await env.channels.setToken(link.id, '123:token')
  const connector = env.connectors.get(link.id)!
  await env.channels.handle(link.id, message({ text: `/start ${env.channels.list()[0].pairCode}` }))
  assert.match(connector.said().at(-1)!, /Paired/)
  await env.channels.handle(link.id, message({ text: '/start' }))
  assert.match(connector.said().at(-1)!, /\/status — What the worker is doing/, 'a plain /start from the owner is help')

  // The keychain lost the token: the link is still on, but can't run.
  env.tokens.delete(link.id)
  env.channels.update(link.id, { enabled: false })
  env.channels.update(link.id, { enabled: true })
  const status = env.channels.statusList().find((s) => s.linkId === link.id)!
  assert.equal(status.state, 'error')
  assert.equal(status.needsToken, true)
})

test('removing a connection stops it and forgets its token', async () => {
  const env = setup()
  const { link, connector } = await pairedTelegram(env)
  await env.channels.remove(link.id)
  assert.equal(connector.started, false)
  assert.equal(env.tokens.has(link.id), false)
  assert.equal(env.channels.list().length, 0)
})

/* ---------------------------------------------------------- connectors */

function events() {
  const received: IncomingMessage[] = []
  const statuses: string[] = []
  const accounts: string[] = []
  const ev: ConnectorEvents = {
    message: (m) => received.push(m),
    status: (s) => statuses.push(s.state + (s.message ? `: ${s.message}` : '')),
    account: (a) => accounts.push(a.account)
  }
  return { ev, received, statuses, accounts }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

async function body(req: HttpRequest): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try {
    return JSON.parse(raw)
  } catch {
    return { raw }
  }
}

test('Telegram: long-polls updates, spots mentions and commands, and falls back to plain text when HTML is refused', async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = []
  let polled = 0
  const server = createServer(async (req, res) => {
    const method = req.url!.split('/').pop()!
    const payload = await body(req)
    calls.push({ method, body: payload })
    const ok = (result: unknown) => res.end(JSON.stringify({ ok: true, result }))
    if (method === 'getMe') return ok({ id: 42, is_bot: true, first_name: 'Nova', username: 'NovaBot' })
    if (method === 'setMyCommands' || method === 'sendChatAction') return ok(true)
    if (method === 'getUpdates') {
      polled++
      if (polled === 1) {
        return ok([
          {
            update_id: 7,
            message: {
              message_id: 1,
              date: 0,
              from: { id: 5, is_bot: false, first_name: 'Bea', username: 'bea' },
              chat: { id: -100, type: 'supergroup', title: 'Weekend plans' },
              text: '@NovaBot find a trail',
              entities: [{ type: 'mention', offset: 0, length: 8 }]
            }
          },
          {
            update_id: 8,
            message: { message_id: 2, date: 0, from: { id: 5, is_bot: false, first_name: 'Bea' }, chat: { id: -100, type: 'supergroup', title: 'Weekend plans' }, text: '/status@OtherBot', entities: [{ type: 'bot_command', offset: 0, length: 16 }] }
          },
          {
            update_id: 9,
            message: { message_id: 3, date: 0, from: { id: 6, is_bot: false, first_name: 'Cal' }, chat: { id: 6, type: 'private' }, voice: {}, text: undefined }
          }
        ])
      }
      // Hold the next poll open until the test stops the connector.
      return void setTimeout(() => ok([]), 2000)
    }
    if (method === 'sendMessage') {
      if (payload.parse_mode === 'HTML') return res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }))
      return ok({ message_id: 99 })
    }
    res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }))
  })
  const port = await listen(server)
  const { ev, received, statuses, accounts } = events()
  const telegram = new TelegramConnector('123:abc', ev, `http://127.0.0.1:${port}`)
  telegram.start()
  // Stopped whatever happens: a connector left long-polling keeps the test process alive forever.
  try {
    await until(() => received.length === 3)
    // The next poll carries the offset; under load it can land a moment after the third message.
    await until(() => calls.filter((c) => c.method === 'getUpdates').length >= 2)
    assert.deepEqual(accounts, ['@NovaBot'])
    assert.ok(statuses.includes('connected'))
    assert.ok(calls.some((c) => c.method === 'setMyCommands' && (c.body.commands as { command: string }[]).some((cmd) => cmd.command === 'status')))
    assert.deepEqual(
      [received[0].text, received[0].mentioned, received[0].isGroup, received[0].chatName, received[0].senderName],
      ['find a trail', true, true, 'Weekend plans', 'Bea (@bea)']
    )
    assert.equal(received[1].mentioned, false, 'a command for another bot is not ours')
    assert.equal(received[2].unsupported, 'a voice message')
    assert.equal(calls.filter((c) => c.method === 'getUpdates')[1]?.body.offset, 10, 'confirms what it read')

    await telegram.send('-100', '**Found** one', '1')
    const sends = calls.filter((c) => c.method === 'sendMessage')
    assert.equal(sends[0].body.text, '<b>Found</b> one')
    assert.deepEqual(sends[1].body, { chat_id: '-100', link_preview_options: { is_disabled: true }, reply_parameters: { message_id: 1, allow_sending_without_reply: true }, text: 'Found one' })
  } finally {
    await telegram.stop()
    server.close()
  }
})

test('Discord: identifies without the content intent it lacks, resumes after a drop, and never lets the worker ping anyone', async () => {
  const rest: { method: string; path: string; body: Record<string, unknown> }[] = []
  const http = createServer(async (req, res) => {
    const payload = await body(req)
    rest.push({ method: req.method!, path: req.url!, body: payload })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/users/@me') return res.end(JSON.stringify({ id: 'bot1', username: 'NovaBot', bot: true }))
    if (req.url === '/oauth2/applications/@me') return res.end(JSON.stringify({ id: 'app1', flags: 0 }))
    if (req.url === '/channels/c1') return res.end(JSON.stringify({ id: 'c1', name: 'general' }))
    if (req.url?.endsWith('/typing')) return res.writeHead(204).end()
    res.end(JSON.stringify({ id: 'sent' }))
  })
  const apiPort = await listen(http)
  const gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => gateway.once('listening', resolve))
  const gatewayPort = (gateway.address() as { port: number }).port
  const frames: Record<string, unknown>[] = []
  const sockets: WebSocket[] = []
  gateway.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data))
      frames.push(frame)
      if (frame.op === 2) {
        socket.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess', resume_gateway_url: `ws://127.0.0.1:${gatewayPort}`, user: { id: 'bot1', username: 'NovaBot', bot: true } } }))
        socket.send(JSON.stringify({ op: 0, s: 2, t: 'GUILD_CREATE', d: { id: 'g1', name: 'Eaon Lab', channels: [{ id: 'c1', name: 'general' }] } }))
        socket.send(
          JSON.stringify({
            op: 0,
            s: 3,
            t: 'MESSAGE_CREATE',
            d: { id: 'm1', channel_id: 'c1', guild_id: 'g1', author: { id: 'u1', username: 'bea', global_name: 'Bea' }, content: '<@bot1> find a trail', mentions: [{ id: 'bot1', username: 'NovaBot' }] }
          })
        )
        socket.send(JSON.stringify({ op: 0, s: 4, t: 'MESSAGE_CREATE', d: { id: 'm2', channel_id: 'c1', guild_id: 'g1', author: { id: 'bot2', username: 'x', bot: true }, content: 'beep' } }))
      }
      if (frame.op === 6) socket.send(JSON.stringify({ op: 0, s: 5, t: 'RESUMED', d: {} }))
    })
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }))
  })

  const { ev, received, statuses, accounts } = events()
  const discord = new DiscordConnector('a.b.c', ev, { api: `http://127.0.0.1:${apiPort}`, gateway: `ws://127.0.0.1:${gatewayPort}` })
  discord.start()
  await until(() => received.length === 1)
  const identify = frames.find((f) => f.op === 2) as { d: { intents: number; token: string } }
  assert.equal(identify.d.token, 'a.b.c')
  assert.equal(identify.d.intents & (1 << 15), 0, 'no Message Content intent when the app has it off')
  assert.equal(identify.d.intents & (1 << 9), 1 << 9)
  assert.deepEqual(accounts, ['NovaBot'])
  assert.ok(statuses.includes('connected'))
  assert.deepEqual([received[0].text, received[0].mentioned, received[0].chatName, received[0].senderName], ['find a trail', true, '#general (Eaon Lab)', 'Bea'])

  // A dropped connection resumes the session rather than identifying again.
  sockets[0].close(4000)
  await until(() => frames.some((f) => f.op === 6))
  assert.deepEqual((frames.find((f) => f.op === 6) as { d: unknown }).d, { token: 'a.b.c', session_id: 'sess', seq: 4 })

  await discord.send('c1', 'Found one @everyone', 'm1')
  const post = rest.find((r) => r.method === 'POST' && r.path === '/channels/c1/messages')!
  assert.deepEqual(post.body, { content: 'Found one @everyone', allowed_mentions: { parse: [] }, message_reference: { message_id: 'm1', fail_if_not_exists: false } })
  await discord.typing('c1', true)
  assert.ok(rest.some((r) => r.path === '/channels/c1/typing'))
  await discord.stop()
  gateway.close()
  http.close()
})
