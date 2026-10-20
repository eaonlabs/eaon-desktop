import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import WebSocket from 'ws'
import { MAX_MESSAGE_CHARS, type SlackCredentials } from '@shared/channels'
import { chunkText, toSlackMrkdwn } from './format'
import type { Connector, ConnectorEvents, IncomingFile } from './types'

/**
 * Slack through Socket Mode: events arrive over a WebSocket the app opens
 * (with its app-level token), so no public address is needed, and replies go
 * through the Web API (with its bot token). Settings hands the user an app
 * manifest that asks for exactly the scopes and events used here.
 */

export const SLACK_API = 'https://slack.com/api'
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

interface SlackFile {
  id: string
  name?: string
  title?: string
  size?: number
  url_private_download?: string
  url_private?: string
  mode?: string
}

interface SlackEvent {
  type: string
  subtype?: string
  user?: string
  bot_id?: string
  text?: string
  ts: string
  thread_ts?: string
  parent_user_id?: string
  channel: string
  channel_type?: 'im' | 'channel' | 'group' | 'mpim' | 'app_home'
  files?: SlackFile[]
}

export class SlackError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfter?: number
  ) {
    super(code)
  }
}

/** The JSON Settings sends, checked: two tokens of the right kinds. */
export function slackCredentials(raw: string): SlackCredentials {
  let parsed: Partial<SlackCredentials>
  try {
    parsed = JSON.parse(raw) as Partial<SlackCredentials>
  } catch {
    throw new Error('Paste both of the Slack app’s tokens.')
  }
  const bot = String(parsed.bot ?? '').trim()
  const app = String(parsed.app ?? '').trim()
  if (!bot.startsWith('xoxb-')) throw new Error('The bot token starts with xoxb-. It’s on the app’s OAuth & Permissions page, once the app is installed.')
  if (!app.startsWith('xapp-')) throw new Error('The app-level token starts with xapp-. Make one on the app’s Basic Information page, with the connections:write scope.')
  return { bot, app }
}

/** A Web API call. Arguments go form-encoded, which every method takes; objects as JSON strings. */
async function call<T>(api: string, token: string, method: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  const response = await fetch(`${api}/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal
  })
  if (response.status === 429) throw new SlackError('ratelimited', Number(response.headers.get('retry-after') ?? '5'))
  const data = (await response.json().catch(() => null)) as ({ ok: boolean; error?: string } & T) | null
  if (!data?.ok) throw new SlackError(data?.error ?? `http_${response.status}`)
  return data
}

const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'not_allowed_token_type'])

/** Checks both tokens and names the bot: "@nova in Acme". Throws a sentence for the user. */
export async function verifySlackCredentials(raw: string, api = SLACK_API): Promise<{ account: string; id: string }> {
  const { bot, app } = slackCredentials(raw)
  const signal = AbortSignal.timeout(15_000)
  let me: { user_id: string; user: string; team: string }
  try {
    me = await call(api, bot, 'auth.test', {}, signal)
  } catch (error) {
    if (error instanceof SlackError && AUTH_ERRORS.has(error.code)) throw new Error('Slack didn’t accept the bot token. Copy the Bot User OAuth Token (xoxb-…) again.')
    throw new Error(`Couldn’t reach Slack: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    await call(api, app, 'apps.connections.open', {}, signal)
  } catch (error) {
    if (error instanceof SlackError && AUTH_ERRORS.has(error.code)) {
      throw new Error('Slack didn’t accept the app-level token. Make one with the connections:write scope on the app’s Basic Information page.')
    }
    throw new Error(`Slack wouldn’t open a Socket Mode connection (${error instanceof Error ? error.message : String(error)}). Turn on Socket Mode in the app’s settings.`)
  }
  return { account: `@${me.user} in ${me.team}`, id: me.user_id }
}

/** Slack's own markup in a message, read as plain text: mentions by name, links as written. */
function readable(text: string, names: (id: string) => string | undefined): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${names(id) ?? id}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })

export class SlackConnector implements Connector {
  readonly kind = 'slack' as const
  /** Slack has no typing indicator for bots. */
  readonly typingEveryMs = 60_000
  private readonly credentials: SlackCredentials | null
  private readonly abort = new AbortController()
  private me: { id: string; name: string } | null = null
  private socket: WebSocket | null = null
  private running: Promise<void> | null = null
  private readonly userNames = new Map<string, string>()
  private readonly channelNames = new Map<string, string>()
  /** A message's thread, so a reply to one in a thread stays in it. */
  private readonly threadOf = new Map<string, string>()
  /** A mention arrives twice (as `message` and `app_mention`): handled once. */
  private readonly seen = new Set<string>()

  constructor(
    raw: string,
    private readonly events: ConnectorEvents,
    private readonly api = SLACK_API
  ) {
    let credentials: SlackCredentials | null = null
    try {
      credentials = slackCredentials(raw)
    } catch {
      credentials = null
    }
    this.credentials = credentials
  }

  private call<T>(method: string, args?: Record<string, unknown>): Promise<T> {
    return call<T>(this.api, this.credentials!.bot, method, args, this.abort.signal)
  }

  start(): void {
    if (!this.running) this.running = this.loop()
  }

  async stop(): Promise<void> {
    this.abort.abort()
    this.socket?.close(1000)
    await this.running
  }

  private async loop(): Promise<void> {
    const signal = this.abort.signal
    if (!this.credentials) {
      this.events.status({ state: 'error', message: 'This connection’s Slack tokens are missing. Paste them again.', needsToken: true })
      return
    }
    let failures = 0
    this.events.status({ state: 'connecting' })
    while (!signal.aborted) {
      try {
        if (!this.me) {
          const me = await this.call<{ user_id: string; user: string; team: string }>('auth.test')
          this.me = { id: me.user_id, name: me.user }
          this.events.account({ account: `@${me.user} in ${me.team}`, selfId: me.user_id })
        }
        const { url } = await call<{ url: string }>(this.api, this.credentials.app, 'apps.connections.open', {}, signal)
        // Resolves when the socket closes; true once Slack said hello on it.
        const greeted = await this.session(url)
        if (greeted) failures = 0
        if (signal.aborted) break
        failures += greeted ? 0 : 1
        if (!greeted) await sleep(Math.min(2 ** failures * 1000, 60_000), signal)
      } catch (error) {
        if (signal.aborted) break
        if (error instanceof SlackError && AUTH_ERRORS.has(error.code)) {
          this.events.status({ state: 'error', message: 'Slack no longer accepts this app’s tokens. Paste new ones.', needsToken: true })
          return
        }
        failures += 1
        const wait = error instanceof SlackError && error.retryAfter ? error.retryAfter * 1000 : Math.min(2 ** failures * 1000, 60_000)
        this.events.status({ state: 'connecting', message: `Reconnecting — ${error instanceof Error ? error.message : String(error)}` })
        await sleep(wait, signal)
      }
    }
    this.events.status({ state: 'off' })
  }

  /** One Socket Mode connection, until Slack (or `stop`) closes it. */
  private session(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      let greeted = false
      const socket = new WebSocket(url)
      this.socket = socket
      const done = (): void => {
        if (this.socket === socket) this.socket = null
        resolve(greeted)
      }
      socket.on('message', (data) => {
        let envelope: { type?: string; envelope_id?: string; reason?: string; payload?: { event?: SlackEvent } }
        try {
          envelope = JSON.parse(String(data))
        } catch {
          return
        }
        // Every envelope is acknowledged at once, or Slack sends it again.
        if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }))
        if (envelope.type === 'hello') {
          greeted = true
          this.events.status({ state: 'connected' })
        } else if (envelope.type === 'disconnect') {
          // Slack rotates connections every few hours; a new one is opened straight away.
          socket.close(1000)
        } else if (envelope.type === 'events_api' && envelope.payload?.event) {
          void this.handle(envelope.payload.event).catch((error) => console.error('[slack] could not read a message:', error))
        }
      })
      socket.on('close', done)
      socket.on('error', () => {
        /* 'close' follows */
      })
    })
  }

  private async userName(id: string): Promise<string> {
    const known = this.userNames.get(id)
    if (known) return known
    const name = await this.call<{ user: { name: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>('users.info', { user: id })
      .then(({ user }) => user.profile?.display_name || user.profile?.real_name || user.real_name || user.name)
      .catch(() => id)
    this.userNames.set(id, name)
    return name
  }

  private async channelName(id: string): Promise<string> {
    const known = this.channelNames.get(id)
    if (known) return known
    const name = await this.call<{ channel: { name?: string; is_mpim?: boolean } }>('conversations.info', { channel: id })
      .then(({ channel }) => (channel.is_mpim ? 'a group message' : `#${channel.name ?? id}`))
      .catch(() => 'a channel')
    this.channelNames.set(id, name)
    return name
  }

  private async handle(event: SlackEvent): Promise<void> {
    const me = this.me
    if (!me || (event.type !== 'message' && event.type !== 'app_mention')) return
    // Edits, joins, topic changes and the like aren't something said to the worker.
    if (event.subtype && event.subtype !== 'file_share' && event.subtype !== 'thread_broadcast') return
    if (!event.user || event.bot_id || event.user === me.id) return
    const key = `${event.channel}|${event.ts}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value as string)
    if (event.thread_ts && event.thread_ts !== event.ts) this.threadOf.set(event.ts, event.thread_ts)
    if (this.threadOf.size > 2000) this.threadOf.delete(this.threadOf.keys().next().value as string)

    const isDirect = event.channel_type === 'im' || (!event.channel_type && event.channel.startsWith('D'))
    const raw = event.text ?? ''
    const mentionsMe = raw.includes(`<@${me.id}>`)
    const mentioned = event.type === 'app_mention' || mentionsMe || event.parent_user_id === me.id
    // Names for the people mentioned, so "<@U123>" reads as "@Ana".
    for (const id of new Set([...raw.matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1]))) if (id !== me.id) await this.userName(id)
    const text = readable(raw.replace(new RegExp(`\\s*<@${me.id}>`, 'g'), ' '), (id) => this.userNames.get(id))
      .replace(/[ \t]+\n/g, '\n')
      .trim()

    const files: IncomingFile[] = (event.files ?? [])
      .filter((f) => f.mode !== 'external' && (f.url_private_download || f.url_private))
      .map((f) => ({ name: f.name ?? f.title ?? `file-${f.id}`, size: f.size ?? null, download: () => this.download(f.url_private_download ?? f.url_private!) }))

    this.events.message({
      chatId: event.channel,
      chatName: isDirect ? 'Direct message' : await this.channelName(event.channel),
      isGroup: !isDirect,
      senderId: event.user,
      senderName: await this.userName(event.user),
      messageId: event.ts,
      text,
      mentioned,
      files
    })
  }

  private async download(url: string): Promise<Buffer> {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.credentials!.bot}` },
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(120_000)])
    })
    if (!response.ok) throw new Error(`Slack answered ${response.status} for the file`)
    // Without the files:read scope Slack sends its sign-in page instead of the file.
    if ((response.headers.get('content-type') ?? '').startsWith('text/html')) throw new Error('Slack wouldn’t hand over the file. The app needs the files:read scope.')
    return Buffer.from(await response.arrayBuffer())
  }

  /** Where a reply goes: into the thread the message was in, or (outside a DM) a thread under it. */
  private threadFor(chatId: string, replyTo?: string): string | undefined {
    if (!replyTo) return undefined
    const thread = this.threadOf.get(replyTo)
    if (thread) return thread
    return chatId.startsWith('D') ? undefined : replyTo
  }

  async send(chatId: string, markdown: string, replyTo?: string): Promise<void> {
    const thread_ts = this.threadFor(chatId, replyTo)
    for (const piece of chunkText(markdown, MAX_MESSAGE_CHARS.slack)) {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.call('chat.postMessage', { channel: chatId, text: toSlackMrkdwn(piece), thread_ts, unfurl_links: false, unfurl_media: false })
          break
        } catch (error) {
          if (!(error instanceof SlackError) || !error.retryAfter || attempt >= 2) throw error
          await sleep(error.retryAfter * 1000, this.abort.signal)
        }
      }
    }
  }

  async sendFile(chatId: string, path: string, caption?: string): Promise<void> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${path} is not a file.`)
    if (info.size > MAX_UPLOAD_BYTES) throw new Error('Files sent to Slack can be up to 100 MB here.')
    const name = basename(path)
    const { upload_url, file_id } = await this.call<{ upload_url: string; file_id: string }>('files.getUploadURLExternal', { filename: name, length: info.size })
    const upload = await fetch(upload_url, { method: 'POST', body: await readFile(path), signal: this.abort.signal })
    if (!upload.ok) throw new Error(`Slack refused the file (${upload.status}).`)
    await this.call('files.completeUploadExternal', {
      files: [{ id: file_id, title: name }],
      channel_id: chatId,
      ...(caption ? { initial_comment: toSlackMrkdwn(caption) } : {})
    })
  }

  async typing(): Promise<void> {
    /* Slack shows bots no typing indicator. */
  }

  async directChat(userId: string): Promise<string> {
    const { channel } = await this.call<{ channel: { id: string } }>('conversations.open', { users: userId })
    return channel.id
  }
}
