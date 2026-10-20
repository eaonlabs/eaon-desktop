import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { MAX_MESSAGE_CHARS, type ZulipCredentials } from '@shared/channels'
import { chunkText } from './format'
import type { Connector, ConnectorEvents, IncomingFile } from './types'

/**
 * Zulip through its REST API: an event queue long-polled for messages, so no
 * public address is needed. The worker is a Zulip bot (its email and API
 * key, from the zuliprc Zulip offers when the bot is made). Zulip writes
 * Markdown itself.
 *
 * A channel's conversations are topics; the worker answers in the topic it
 * was written to in, and the whole channel counts as one place to allow.
 */

interface ZulipUser {
  user_id: number
  email: string
  full_name: string
}

interface ZulipMessage {
  id: number
  sender_id: number
  sender_full_name: string
  sender_email: string
  type: 'private' | 'stream'
  display_recipient: string | { id: number; email: string; full_name: string }[]
  stream_id?: number
  subject?: string
  content: string
}

export class ZulipError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfter?: number
  ) {
    super(message)
  }
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const DEFAULT_TOPIC = 'Eaon'

/** The credentials Settings sends, or a pasted zuliprc. */
export function zulipCredentials(raw: string): ZulipCredentials {
  let parsed: Partial<ZulipCredentials> & { zuliprc?: string }
  try {
    parsed = JSON.parse(raw) as Partial<ZulipCredentials> & { zuliprc?: string }
  } catch {
    throw new Error('Enter the Zulip server, the bot’s email and its API key.')
  }
  const rc = parsed.zuliprc ?? ''
  const field = (name: string): string => new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm').exec(rc)?.[1]?.trim() ?? ''
  const server = String(parsed.server || field('site')).trim().replace(/\/+$/, '')
  const email = String(parsed.email || field('email')).trim()
  const key = String(parsed.key || field('key')).trim()
  if (!server) throw new Error('Enter the Zulip server’s address, like chat.example.com or yourteam.zulipchat.com.')
  if (!email.includes('@')) throw new Error('Enter the bot’s email, from its zuliprc (it ends in -bot@…).')
  if (!key) throw new Error('Paste the bot’s API key.')
  return { server: /^https?:\/\//i.test(server) ? server : `https://${server}`, email, key }
}

async function api<T>(creds: ZulipCredentials, method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}, signal?: AbortSignal, form?: FormData): Promise<T> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    query.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  const url = `${creds.server}/api/v1${path}${method === 'GET' && [...query].length ? `?${query}` : ''}`
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${creds.email}:${creds.key}`).toString('base64')}`,
      ...(method === 'POST' && !form ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
    },
    body: method === 'POST' ? (form ?? query) : undefined,
    signal
  })
  const data = (await response.json().catch(() => null)) as (T & { result?: string; msg?: string; code?: string; 'retry-after'?: number }) | null
  if (!response.ok || data?.result !== 'success') {
    throw new ZulipError(data?.msg ?? `Zulip answered ${response.status}`, response.status, data?.code, data?.['retry-after'])
  }
  return data
}

/** Checks the bot's key and names it. Throws a sentence for the user. */
export async function verifyZulipCredentials(raw: string): Promise<{ account: string; id: string; token: string }> {
  const creds = zulipCredentials(raw)
  try {
    const me = await api<ZulipUser>(creds, 'GET', '/users/me', {}, AbortSignal.timeout(15_000))
    return { account: me.full_name, id: String(me.user_id), token: JSON.stringify(creds) }
  } catch (error) {
    if (error instanceof ZulipError && (error.status === 401 || error.code === 'UNAUTHORIZED' || error.code === 'INVALID_API_KEY')) {
      throw new Error('Zulip didn’t accept that email and API key. Copy them from the bot’s zuliprc again.')
    }
    if (error instanceof ZulipError) throw new Error(`Zulip said: ${error.message}`)
    throw new Error(`Couldn’t reach ${creds.server}. Check the server’s address.`)
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })

/** Zulip's mention marks, read as plain names: `@**Ana**` → `@Ana`. */
const readable = (text: string): string => text.replace(/@_?\*\*([^*|]+)(?:\|\d+)?\*\*/g, '@$1').replace(/#\*\*([^*]+)\*\*/g, '#$1')

export class ZulipConnector implements Connector {
  readonly kind = 'zulip' as const
  readonly typingEveryMs = 10_000
  private readonly creds: ZulipCredentials | null
  private readonly abort = new AbortController()
  private me: ZulipUser | null = null
  private running: Promise<void> | null = null
  /** A message's topic, so the answer goes in it; and each channel's latest, for a message that answers none. */
  private readonly topicOf = new Map<string, string>()
  private readonly lastTopic = new Map<string, string>()

  constructor(
    raw: string,
    private readonly events: ConnectorEvents
  ) {
    let creds: ZulipCredentials | null = null
    try {
      creds = zulipCredentials(raw)
    } catch {
      creds = null
    }
    this.creds = creds
  }

  private api<T>(method: 'GET' | 'POST', path: string, params?: Record<string, unknown>, signal: AbortSignal = this.abort.signal, form?: FormData): Promise<T> {
    return api<T>(this.creds!, method, path, params, signal, form)
  }

  start(): void {
    if (!this.running) this.running = this.loop()
  }

  async stop(): Promise<void> {
    this.abort.abort()
    await this.running
  }

  private async loop(): Promise<void> {
    const signal = this.abort.signal
    if (!this.creds) {
      this.events.status({ state: 'error', message: 'This connection’s Zulip key is missing. Paste it again.', needsToken: true })
      return
    }
    let queue: { id: string; last: number } | null = null
    let failures = 0
    let connected = false
    this.events.status({ state: 'connecting' })
    while (!signal.aborted) {
      try {
        if (!this.me) {
          this.me = await this.api<ZulipUser>('GET', '/users/me')
          this.events.account({ account: this.me.full_name, selfId: String(this.me.user_id) })
        }
        if (!queue) {
          const registered = await this.api<{ queue_id: string; last_event_id: number }>('POST', '/register', { event_types: ['message'], apply_markdown: false, client_gravatar: true })
          queue = { id: registered.queue_id, last: registered.last_event_id }
          // Connected now: the long poll below can sit quiet for a minute.
          if (!connected) this.events.status({ state: 'connected' })
          connected = true
        }
        // Zulip holds this open until there is something, or sends a heartbeat within about a minute.
        const { events } = await this.api<{ events: { id: number; type: string; message?: ZulipMessage; flags?: string[] }[] }>(
          'GET',
          '/events',
          { queue_id: queue.id, last_event_id: queue.last },
          AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        )
        if (!connected) this.events.status({ state: 'connected' })
        connected = true
        failures = 0
        for (const event of events) {
          queue.last = Math.max(queue.last, event.id)
          if (event.type === 'message' && event.message) await this.handle(event.message, event.flags ?? []).catch((error) => console.error('[zulip] could not read a message:', error))
        }
      } catch (error) {
        if (signal.aborted) break
        connected = false
        if (error instanceof ZulipError && error.code === 'BAD_EVENT_QUEUE_ID') {
          // The queue expired (Zulip drops one left unread for a while): a new one, at once.
          queue = null
          continue
        }
        if (error instanceof ZulipError && (error.status === 401 || error.code === 'UNAUTHORIZED' || error.code === 'INVALID_API_KEY' || error.code === 'USER_DEACTIVATED')) {
          this.events.status({ state: 'error', message: 'Zulip no longer accepts this bot’s key. Paste its zuliprc again.', needsToken: true })
          return
        }
        failures += 1
        const wait = error instanceof ZulipError && error.retryAfter ? error.retryAfter * 1000 : Math.min(2 ** failures * 1000, 60_000)
        this.events.status({ state: 'connecting', message: `Reconnecting — ${error instanceof Error ? error.message : String(error)}` })
        await sleep(wait, signal)
      }
    }
    this.events.status({ state: 'off' })
  }

  private async handle(message: ZulipMessage, flags: string[]): Promise<void> {
    const me = this.me
    if (!me || message.sender_id === me.user_id) return
    const id = String(message.id)
    let chatId: string
    let chatName: string
    let isGroup: boolean
    if (message.type === 'private') {
      const others = (Array.isArray(message.display_recipient) ? message.display_recipient : []).filter((u) => u.id !== me.user_id)
      chatId = `dm:${others.map((u) => u.id).sort((a, b) => a - b).join(',')}`
      isGroup = others.length > 1
      chatName = isGroup ? others.map((u) => u.full_name).join(', ') : 'Direct message'
    } else {
      chatId = `stream:${message.stream_id}`
      chatName = `#${typeof message.display_recipient === 'string' ? message.display_recipient : 'a channel'}`
      isGroup = true
      const topic = message.subject || DEFAULT_TOPIC
      this.topicOf.set(id, topic)
      this.lastTopic.set(chatId, topic)
      if (this.topicOf.size > 2000) this.topicOf.delete(this.topicOf.keys().next().value as string)
    }
    const handle = new RegExp(`@_?\\*\\*${me.full_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|\\d+)?\\*\\*`, 'gi')
    const mentioned = flags.includes('mentioned') || handle.test(message.content)
    const content = message.content.replace(handle, ' ').trim()

    // Files are links to the server's uploads: [name](/user_uploads/…).
    const files: IncomingFile[] = []
    for (const match of content.matchAll(/\[([^\]]+)\]\((\/user_uploads\/[^)\s]+)\)/g)) {
      const path = match[2]
      files.push({ name: match[1], size: null, download: () => this.download(path) })
    }
    this.events.message({
      chatId,
      chatName,
      isGroup,
      senderId: String(message.sender_id),
      senderName: message.sender_full_name,
      messageId: id,
      text: readable(content.replace(/\[([^\]]+)\]\(\/user_uploads\/[^)\s]+\)/g, '').trim()),
      mentioned,
      files
    })
  }

  private async download(path: string): Promise<Buffer> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(120_000)])
    // Uploads need signing in; the API hands out a short-lived link to the file.
    const { url } = await this.api<{ url: string }>('GET', path, {}, signal)
    const response = await fetch(new URL(url, this.creds!.server), { signal })
    if (!response.ok) throw new Error(`Zulip answered ${response.status} for the file`)
    return Buffer.from(await response.arrayBuffer())
  }

  /** Where a message to `chatId` goes. */
  private target(chatId: string, replyTo?: string): Record<string, unknown> {
    if (chatId.startsWith('dm:')) return { type: 'private', to: chatId.slice(3).split(',').map(Number) }
    const streamId = Number(chatId.slice('stream:'.length))
    const topic = (replyTo && this.topicOf.get(replyTo)) || this.lastTopic.get(chatId) || DEFAULT_TOPIC
    return { type: 'stream', to: streamId, topic }
  }

  async send(chatId: string, markdown: string, replyTo?: string): Promise<void> {
    const target = this.target(chatId, replyTo)
    for (const piece of chunkText(markdown, MAX_MESSAGE_CHARS.zulip)) await this.api('POST', '/messages', { ...target, content: piece })
  }

  async sendFile(chatId: string, path: string, caption?: string): Promise<void> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${path} is not a file.`)
    if (info.size > MAX_UPLOAD_BYTES) throw new Error('Files sent to Zulip can be up to 25 MB here.')
    const name = basename(path)
    const form = new FormData()
    form.set('filename', new Blob([await readFile(path)]), name)
    const uploaded = await this.api<{ uri?: string; url?: string }>('POST', '/user_uploads', {}, this.abort.signal, form)
    const link = uploaded.url ?? uploaded.uri
    if (!link) throw new Error('Zulip didn’t say where the file went.')
    await this.api('POST', '/messages', { ...this.target(chatId), content: `${caption ? `${caption}\n` : ''}[${name.replace(/[[\]]/g, '')}](${link})` })
  }

  async typing(chatId: string, on: boolean): Promise<void> {
    // Typing shows in direct messages; a channel topic's is newer than many servers.
    if (!chatId.startsWith('dm:')) return
    await this.api('POST', '/typing', { op: on ? 'start' : 'stop', to: chatId.slice(3).split(',').map(Number) })
  }

  async directChat(userId: string): Promise<string> {
    return `dm:${userId}`
  }
}
