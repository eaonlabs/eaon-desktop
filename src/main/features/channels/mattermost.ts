import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import WebSocket from 'ws'
import { MAX_MESSAGE_CHARS, type MattermostCredentials } from '@shared/channels'
import { chunkText } from './format'
import type { Connector, ConnectorEvents, IncomingFile } from './types'

/**
 * Mattermost through its REST API and WebSocket, with a bot account's access
 * token (System Console → Integrations → Bot Accounts) or a personal access
 * token. Mattermost writes Markdown itself, so replies go as they are.
 */

interface MattermostUser {
  id: string
  username: string
  first_name?: string
  last_name?: string
  nickname?: string
}

interface MattermostPost {
  id: string
  user_id: string
  channel_id: string
  root_id?: string
  message: string
  type?: string
  file_ids?: string[]
  props?: Record<string, unknown>
}

export class MattermostError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/** `chat.example.com` → `https://chat.example.com`, without a trailing slash. */
export function mattermostServer(server: string): string {
  const trimmed = server.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('Enter the Mattermost server’s address.')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function credentials(raw: string): MattermostCredentials {
  let parsed: Partial<MattermostCredentials>
  try {
    parsed = JSON.parse(raw) as Partial<MattermostCredentials>
  } catch {
    throw new Error('Enter the server’s address and the bot’s access token.')
  }
  const token = String(parsed.token ?? '').trim()
  if (!token) throw new Error('Paste the bot’s access token.')
  return { server: mattermostServer(String(parsed.server ?? '')), token }
}

async function rest<T>(server: string, token: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${server}/api/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal
  })
  const data = (await response.json().catch(() => null)) as (T & { message?: string }) | null
  if (!response.ok) throw new MattermostError(data?.message ?? `Mattermost answered ${response.status}`, response.status)
  return data as T
}

/** Checks the token and names the bot: "@nova". Throws a sentence for the user. */
export async function verifyMattermostCredentials(raw: string): Promise<{ account: string; id: string; token: string }> {
  const { server, token } = credentials(raw)
  try {
    const me = await rest<MattermostUser>(server, token, 'GET', '/users/me', undefined, AbortSignal.timeout(15_000))
    // Kept with the server's address made whole, so the connection needn't work it out again.
    return { account: `@${me.username}`, id: me.id, token: JSON.stringify({ server, token } satisfies MattermostCredentials) }
  } catch (error) {
    if (error instanceof MattermostError && (error.status === 401 || error.status === 403)) throw new Error('Mattermost didn’t accept that token. Copy the bot’s access token again.')
    if (error instanceof MattermostError) throw new Error(`Mattermost said: ${error.message}`)
    throw new Error(`Couldn’t reach ${server}. Check the server’s address.`)
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })

export class MattermostConnector implements Connector {
  readonly kind = 'mattermost' as const
  readonly typingEveryMs = 4000
  private readonly creds: MattermostCredentials | null
  private readonly abort = new AbortController()
  private me: MattermostUser | null = null
  private socket: WebSocket | null = null
  private seq = 1
  private running: Promise<void> | null = null
  /** A post's thread, so a reply to one in a thread stays in it. */
  private readonly rootOf = new Map<string, string>()
  /** What this bot posted, so a reply in its thread counts as calling it. */
  private readonly mine = new Set<string>()
  private readonly direct = new Map<string, string>()

  constructor(
    raw: string,
    private readonly events: ConnectorEvents
  ) {
    let creds: MattermostCredentials | null = null
    try {
      creds = credentials(raw)
    } catch {
      creds = null
    }
    this.creds = creds
  }

  private rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return rest<T>(this.creds!.server, this.creds!.token, method, path, body, this.abort.signal)
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
    if (!this.creds) {
      this.events.status({ state: 'error', message: 'This connection’s Mattermost token is missing. Paste it again.', needsToken: true })
      return
    }
    let failures = 0
    this.events.status({ state: 'connecting' })
    while (!signal.aborted) {
      try {
        if (!this.me) {
          this.me = await this.rest<MattermostUser>('GET', '/users/me')
          this.events.account({ account: `@${this.me.username}`, selfId: this.me.id })
        }
        const greeted = await this.session()
        if (signal.aborted) break
        failures = greeted ? 0 : failures + 1
        await sleep(greeted ? 1000 : Math.min(2 ** failures * 1000, 60_000), signal)
      } catch (error) {
        if (signal.aborted) break
        if (error instanceof MattermostError && error.status === 401) {
          this.events.status({ state: 'error', message: 'Mattermost no longer accepts this bot’s token. Paste a new one.', needsToken: true })
          return
        }
        failures += 1
        this.events.status({ state: 'connecting', message: `Reconnecting — ${error instanceof Error ? error.message : String(error)}` })
        await sleep(Math.min(2 ** failures * 1000, 60_000), signal)
      }
    }
    this.events.status({ state: 'off' })
  }

  /** One WebSocket connection, until it closes; true once Mattermost said hello on it. */
  private session(): Promise<boolean> {
    return new Promise((resolve) => {
      let greeted = false
      const url = `${this.creds!.server.replace(/^http/i, 'ws')}/api/v4/websocket`
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.creds!.token}` } })
      this.socket = socket
      // A connection that goes quiet is gone: Mattermost answers pings.
      let alive = true
      const ping = setInterval(() => {
        if (!alive) return socket.terminate()
        alive = false
        socket.ping()
      }, 30_000)
      socket.on('pong', () => (alive = true))
      socket.on('open', () => socket.send(JSON.stringify({ seq: this.seq++, action: 'authentication_challenge', data: { token: this.creds!.token } })))
      socket.on('message', (data) => {
        alive = true
        let message: { event?: string; data?: Record<string, unknown> }
        try {
          message = JSON.parse(String(data))
        } catch {
          return
        }
        if (message.event === 'hello') {
          greeted = true
          this.events.status({ state: 'connected' })
        } else if (message.event === 'posted' && message.data) {
          void this.handle(message.data).catch((error) => console.error('[mattermost] could not read a post:', error))
        }
      })
      socket.on('close', () => {
        clearInterval(ping)
        if (this.socket === socket) this.socket = null
        resolve(greeted)
      })
      socket.on('error', () => {
        /* 'close' follows */
      })
    })
  }

  private async handle(data: Record<string, unknown>): Promise<void> {
    const me = this.me
    if (!me || typeof data.post !== 'string') return
    const post = JSON.parse(data.post) as MattermostPost
    // Its own posts, system messages ("joined the channel") and other bots' posts.
    if (post.user_id === me.id || post.type || post.props?.from_bot === 'true' || post.props?.from_webhook === 'true') return
    const root = post.root_id || ''
    if (root) this.rootOf.set(post.id, root)
    if (this.rootOf.size > 2000) this.rootOf.delete(this.rootOf.keys().next().value as string)
    const channelType = String(data.channel_type ?? '')
    const isDirect = channelType === 'D'
    if (isDirect) this.direct.set(post.user_id, post.channel_id)
    let mentions: string[] = []
    try {
      mentions = typeof data.mentions === 'string' ? (JSON.parse(data.mentions) as string[]) : []
    } catch {
      mentions = []
    }
    const handle = `@${me.username}`
    const mentioned = mentions.includes(me.id) || post.message.toLowerCase().includes(handle.toLowerCase()) || (root !== '' && this.mine.has(root))
    const text = post.message.replace(new RegExp(`\\s*${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ').trim()
    const files: IncomingFile[] = []
    for (const id of post.file_ids ?? []) {
      const info = await this.rest<{ name: string; size: number }>('GET', `/files/${id}/info`).catch(() => null)
      files.push({ name: info?.name ?? `file-${id}`, size: info?.size ?? null, download: () => this.download(id) })
    }
    const sender = String(data.sender_name ?? '').replace(/^@/, '')
    this.events.message({
      chatId: post.channel_id,
      chatName: isDirect ? 'Direct message' : String(data.channel_display_name || 'a channel'),
      isGroup: !isDirect,
      senderId: post.user_id,
      senderName: sender ? `@${sender}` : post.user_id,
      messageId: post.id,
      text,
      mentioned,
      files
    })
  }

  private async download(id: string): Promise<Buffer> {
    const response = await fetch(`${this.creds!.server}/api/v4/files/${id}`, {
      headers: { authorization: `Bearer ${this.creds!.token}` },
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(120_000)])
    })
    if (!response.ok) throw new Error(`Mattermost answered ${response.status} for the file`)
    return Buffer.from(await response.arrayBuffer())
  }

  private async post(body: { channel_id: string; message: string; root_id?: string; file_ids?: string[] }): Promise<void> {
    const post = await this.rest<{ id: string }>('POST', '/posts', body)
    this.mine.add(post.id)
    if (this.mine.size > 500) this.mine.delete(this.mine.values().next().value as string)
  }

  async send(chatId: string, markdown: string, replyTo?: string): Promise<void> {
    // In the thread the message was in; a message on its own gets its answer beside it, not in a new thread.
    const root_id = replyTo ? this.rootOf.get(replyTo) : undefined
    for (const piece of chunkText(markdown, MAX_MESSAGE_CHARS.mattermost)) await this.post({ channel_id: chatId, message: piece, ...(root_id ? { root_id } : {}) })
  }

  async sendFile(chatId: string, path: string, caption?: string): Promise<void> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${path} is not a file.`)
    if (info.size > MAX_UPLOAD_BYTES) throw new Error('Files sent to Mattermost can be up to 100 MB here.')
    const form = new FormData()
    form.set('channel_id', chatId)
    form.set('files', new Blob([await readFile(path)]), basename(path))
    const { file_infos } = await this.rest<{ file_infos: { id: string }[] }>('POST', '/files', form)
    await this.post({ channel_id: chatId, message: caption ?? '', file_ids: file_infos.map((f) => f.id) })
  }

  async typing(chatId: string, on: boolean): Promise<void> {
    if (on && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ seq: this.seq++, action: 'user_typing', data: { channel_id: chatId } }))
  }

  async directChat(userId: string): Promise<string> {
    const known = this.direct.get(userId)
    if (known) return known
    const channel = await this.rest<{ id: string }>('POST', '/channels/direct', [this.me!.id, userId])
    this.direct.set(userId, channel.id)
    return channel.id
  }
}
