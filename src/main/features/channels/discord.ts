import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import WebSocket from 'ws'
import { MAX_MESSAGE_CHARS } from '@shared/channels'
import { chunkText } from './format'
import type { Connector, ConnectorEvents, IncomingFile } from './types'

/**
 * A Discord bot: the gateway (a WebSocket) for incoming messages, REST for
 * everything it sends. Hand-rolled on `ws` like the Rich Presence client —
 * the protocol is small, and discord.js would be the app's largest
 * dependency by far.
 *
 * Message Content is a privileged intent. Without it Discord still delivers
 * DMs and messages that mention the bot in full, which is all "answer when
 * mentioned" needs, so the bot only asks for the intent when its application
 * has it switched on (asking without it closes the gateway with 4014).
 */

export const DISCORD_API = 'https://discord.com/api/v10'
export const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json'
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

const INTENTS = {
  guilds: 1 << 0,
  guildMessages: 1 << 9,
  directMessages: 1 << 12,
  messageContent: 1 << 15
}
/** Application flags meaning Message Content is switched on (full, or for unverified bots). */
const CONTENT_FLAGS = (1 << 18) | (1 << 19)

/** Close codes that mean "don't reconnect", with what to tell the user. */
const FATAL: Record<number, string> = {
  4004: 'Discord rejected the bot token. Reset it in the Developer Portal (Bot → Reset Token) and paste the new one.',
  4010: 'Discord refused the connection (invalid shard).',
  4011: 'This bot is in too many servers to run without sharding.',
  4012: 'Discord refused the connection (invalid API version).',
  4013: 'Discord refused the connection (invalid intents).'
}

interface DiscordUser {
  id: string
  username: string
  global_name?: string | null
  bot?: boolean
}

interface DiscordMessage {
  id: string
  channel_id: string
  guild_id?: string
  author: DiscordUser
  member?: { nick?: string | null }
  content: string
  webhook_id?: string
  mentions?: DiscordUser[]
  referenced_message?: { author?: DiscordUser } | null
  attachments?: { url: string; filename: string; size: number }[]
  sticker_items?: unknown[]
}

export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

async function rest<T>(api: string, token: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const form = body instanceof FormData
    const response = await fetch(`${api}${path}`, {
      method,
      headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (https://eaon.dev, 1)', ...(body && !form ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body),
      signal
    })
    if (response.status === 429 && attempt < 3) {
      const data = (await response.json().catch(() => ({}))) as { retry_after?: number }
      await new Promise((resolve) => setTimeout(resolve, Math.ceil((data.retry_after ?? 1) * 1000)))
      continue
    }
    if (response.status === 204) return undefined as T
    const data = (await response.json().catch(() => null)) as (T & { message?: string }) | null
    if (!response.ok) throw new DiscordError(`Discord: ${data?.message ?? response.statusText}`, response.status)
    return data as T
  }
}

/** Checks a token and names the bot. Throws a sentence for the user. */
export async function verifyDiscordToken(token: string, api = DISCORD_API): Promise<{ account: string; id: string }> {
  const trimmed = token.trim().replace(/^Bot\s+/i, '')
  if (trimmed.split('.').length !== 3) throw new Error('That doesn’t look like a Discord bot token. Copy it from the Developer Portal → your app → Bot → Reset Token.')
  try {
    const me = await rest<DiscordUser>(api, trimmed, 'GET', '/users/@me', undefined, AbortSignal.timeout(15_000))
    if (!me.bot) throw new Error('That token belongs to a user account, not a bot. Use the token from the Bot page of your application.')
    return { account: me.username, id: me.id }
  } catch (error) {
    if (error instanceof DiscordError && error.status === 401) throw new Error('Discord didn’t accept that token. Reset it in the Developer Portal and paste the new one.')
    throw error instanceof DiscordError ? new Error(`Couldn’t reach Discord: ${error.message}`) : error
  }
}

export class DiscordConnector implements Connector {
  readonly kind = 'discord' as const
  readonly typingEveryMs = 8000
  private socket: WebSocket | null = null
  private stopped = false
  private me: DiscordUser | null = null
  private seq: number | null = null
  private sessionId: string | null = null
  private resumeUrl: string | null = null
  private withContent = true
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private firstBeat: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private acked = true
  private failures = 0
  private readonly channelNames = new Map<string, string>()
  private readonly guildNames = new Map<string, string>()
  private readonly dms = new Map<string, string>()
  private readonly abort = new AbortController()

  constructor(
    private readonly token: string,
    private readonly events: ConnectorEvents,
    private readonly endpoints: { api: string; gateway: string } = { api: DISCORD_API, gateway: DISCORD_GATEWAY }
  ) {}

  private rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return rest<T>(this.endpoints.api, this.token, method, path, body, this.abort.signal)
  }

  start(): void {
    this.events.status({ state: 'connecting' })
    void this.prepare()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    this.clearTimers()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState <= WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve())
        socket.close(1000)
        setTimeout(resolve, 1000).unref?.()
      })
    }
    this.events.status({ state: 'off' })
  }

  /** Who the bot is and whether it may read every message, then the gateway. */
  private async prepare(): Promise<void> {
    try {
      this.me = await this.rest<DiscordUser>('GET', '/users/@me')
      const app = await this.rest<{ id: string; flags?: number }>('GET', '/oauth2/applications/@me').catch(() => null)
      this.withContent = Boolean(app && (app.flags ?? 0) & CONTENT_FLAGS)
      this.events.account({ account: this.me.username, appId: app?.id ?? this.me.id, selfId: this.me.id })
      this.connect()
    } catch (error) {
      if (this.stopped) return
      if (error instanceof DiscordError && error.status === 401) {
        this.events.status({ state: 'error', message: FATAL[4004] })
        return
      }
      this.retry(error instanceof Error ? error.message : String(error), () => void this.prepare())
    }
  }

  private connect(): void {
    if (this.stopped) return
    const url = this.sessionId && this.resumeUrl ? `${this.resumeUrl}/?v=10&encoding=json` : this.endpoints.gateway
    const socket = new WebSocket(url)
    this.socket = socket
    socket.on('message', (data) => {
      try {
        this.onPayload(JSON.parse(String(data)))
      } catch (error) {
        console.error('[discord] bad gateway payload:', error)
      }
    })
    socket.on('close', (code) => this.onClose(socket, code))
    socket.on('error', () => {
      /* 'close' follows and decides what to do */
    })
  }

  private onPayload(payload: { op: number; d: unknown; s: number | null; t: string | null }): void {
    if (payload.s !== null && payload.s !== undefined) this.seq = payload.s
    switch (payload.op) {
      case 10: {
        const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval
        this.startHeartbeat(interval)
        if (this.sessionId) {
          this.sendGateway({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } })
        } else {
          const intents = INTENTS.guilds | INTENTS.guildMessages | INTENTS.directMessages | (this.withContent ? INTENTS.messageContent : 0)
          this.sendGateway({ op: 2, d: { token: this.token, intents, properties: { os: process.platform, browser: 'eaon', device: 'eaon' } } })
        }
        return
      }
      case 11:
        this.acked = true
        return
      case 1:
        this.sendGateway({ op: 1, d: this.seq })
        return
      case 7:
        // Discord wants us to reconnect and resume.
        this.socket?.close(4000)
        return
      case 9: {
        const resumable = payload.d === true
        if (!resumable) {
          this.sessionId = null
          this.seq = null
        }
        setTimeout(() => this.socket?.close(4000), 1000 + Math.random() * 4000)
        return
      }
      case 0:
        this.onDispatch(payload.t ?? '', payload.d)
    }
  }

  private onDispatch(type: string, data: unknown): void {
    switch (type) {
      case 'READY': {
        const ready = data as { session_id: string; resume_gateway_url: string; user: DiscordUser }
        this.sessionId = ready.session_id
        this.resumeUrl = ready.resume_gateway_url
        this.me = ready.user
        this.failures = 0
        this.events.status({ state: 'connected', readsAllMessages: this.withContent })
        return
      }
      case 'RESUMED':
        this.failures = 0
        this.events.status({ state: 'connected', readsAllMessages: this.withContent })
        return
      case 'GUILD_CREATE': {
        const guild = data as { id: string; name: string; channels?: { id: string; name: string }[]; threads?: { id: string; name: string }[] }
        this.guildNames.set(guild.id, guild.name)
        for (const channel of [...(guild.channels ?? []), ...(guild.threads ?? [])]) this.channelNames.set(channel.id, channel.name)
        return
      }
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE': {
        const channel = data as { id: string; name?: string }
        if (channel.name) this.channelNames.set(channel.id, channel.name)
        return
      }
      case 'MESSAGE_CREATE':
        void this.onMessage(data as DiscordMessage).catch((error) => console.error('[discord] could not read a message:', error))
    }
  }

  private async onMessage(message: DiscordMessage): Promise<void> {
    const me = this.me
    if (!me || message.author.bot || message.author.id === me.id || message.webhook_id) return
    const isGroup = Boolean(message.guild_id)
    const mentioned = Boolean(message.mentions?.some((user) => user.id === me.id) || message.referenced_message?.author?.id === me.id)
    const text = (message.content ?? '').replace(new RegExp(`<@!?${me.id}>`, 'g'), ' ').replace(/[ \t]+/g, ' ').trim()
    const files: IncomingFile[] = (message.attachments ?? []).map((a) => ({
      name: a.filename,
      size: a.size,
      download: async () => {
        const response = await fetch(a.url, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(120_000)]) })
        if (!response.ok) throw new Error(`Discord answered ${response.status} for ${a.filename}`)
        return Buffer.from(await response.arrayBuffer())
      }
    }))
    this.events.message({
      chatId: message.channel_id,
      chatName: isGroup ? await this.channelName(message.channel_id, message.guild_id!) : 'Direct message',
      isGroup,
      senderId: message.author.id,
      senderName: message.member?.nick || message.author.global_name || message.author.username,
      messageId: message.id,
      text,
      mentioned,
      files,
      ...(message.sticker_items?.length ? { unsupported: 'a sticker' } : {})
    })
  }

  /** "#general (Eaon Lab)". */
  private async channelName(channelId: string, guildId: string): Promise<string> {
    let name = this.channelNames.get(channelId)
    if (!name) {
      const channel = await this.rest<{ name?: string }>('GET', `/channels/${channelId}`).catch(() => null)
      name = channel?.name ?? 'a channel'
      this.channelNames.set(channelId, name)
    }
    const guild = this.guildNames.get(guildId)
    return `#${name}${guild ? ` (${guild})` : ''}`
  }

  private startHeartbeat(interval: number): void {
    this.clearTimers()
    this.acked = true
    const beat = (): void => {
      // No ack since the last beat: the connection is a zombie. Drop it and resume.
      if (!this.acked) {
        this.socket?.terminate()
        return
      }
      this.acked = false
      this.sendGateway({ op: 1, d: this.seq })
    }
    this.firstBeat = setTimeout(() => {
      beat()
      this.heartbeat = setInterval(beat, interval)
    }, interval * Math.random())
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.firstBeat) clearTimeout(this.firstBeat)
    this.heartbeat = null
    this.firstBeat = null
  }

  private onClose(socket: WebSocket, code: number): void {
    if (socket !== this.socket) return
    this.clearTimers()
    this.socket = null
    if (this.stopped) return
    if (code === 4014 && this.withContent) {
      // The intent was switched off after we checked: carry on without it.
      this.withContent = false
      this.sessionId = null
      this.connect()
      return
    }
    if (FATAL[code]) {
      this.events.status({ state: 'error', message: FATAL[code] })
      return
    }
    // Session-ending codes: identify from scratch next time.
    if (code === 4007 || code === 4009) {
      this.sessionId = null
      this.seq = null
    }
    this.retry(`Connection closed (${code})`, () => this.connect())
  }

  private retry(reason: string, again: () => void): void {
    if (this.stopped) return
    this.failures += 1
    const wait = Math.min(1000 * 2 ** Math.min(this.failures, 6), 60_000)
    this.events.status({ state: 'connecting', message: `Reconnecting — ${reason}` })
    this.reconnectTimer = setTimeout(again, wait)
  }

  async send(chatId: string, markdown: string, replyTo?: string): Promise<void> {
    const pieces = chunkText(markdown, MAX_MESSAGE_CHARS.discord)
    for (const [index, piece] of pieces.entries()) {
      await this.rest('POST', `/channels/${chatId}/messages`, {
        content: piece,
        // The worker's words never ping @everyone, roles or people.
        allowed_mentions: { parse: [] },
        ...(replyTo && index === 0 ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {})
      })
    }
  }

  private sendGateway(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload))
  }

  async sendFile(chatId: string, path: string, caption?: string): Promise<void> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${path} is not a file.`)
    if (info.size > MAX_UPLOAD_BYTES) throw new Error('Discord bots can send files up to 10 MB.')
    const form = new FormData()
    form.set('payload_json', JSON.stringify({ content: caption?.slice(0, MAX_MESSAGE_CHARS.discord) ?? '', allowed_mentions: { parse: [] } }))
    form.set('files[0]', new Blob([await readFile(path)]), basename(path))
    await this.rest('POST', `/channels/${chatId}/messages`, form)
  }

  async typing(chatId: string, on: boolean): Promise<void> {
    if (on) await this.rest('POST', `/channels/${chatId}/typing`)
  }

  async directChat(userId: string): Promise<string> {
    const known = this.dms.get(userId)
    if (known) return known
    const channel = await this.rest<{ id: string }>('POST', '/users/@me/channels', { recipient_id: userId })
    this.dms.set(userId, channel.id)
    return channel.id
  }
}
