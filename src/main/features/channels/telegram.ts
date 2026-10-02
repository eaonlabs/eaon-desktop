import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { CHANNEL_COMMANDS, MAX_MESSAGE_CHARS } from '@shared/channels'
import { chunkText, plainText, toTelegramHtml } from './format'
import type { Connector, ConnectorEvents, IncomingFile } from './types'

/**
 * Telegram through the Bot API. Long polling (`getUpdates`) rather than a
 * webhook, because a desktop app has no public address. Only one program may
 * poll a bot at a time — a second one, or a webhook, gets 409 Conflict, which
 * is reported rather than fought over.
 */

export const TELEGRAM_API = 'https://api.telegram.org'
const POLL_SECONDS = 50
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
}

interface TelegramEntity {
  type: string
  offset: number
  length: number
  user?: TelegramUser
}

interface TelegramMessage {
  message_id: number
  date: number
  from?: TelegramUser
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string }
  text?: string
  caption?: string
  entities?: TelegramEntity[]
  caption_entities?: TelegramEntity[]
  reply_to_message?: { from?: TelegramUser }
  photo?: { file_id: string; file_size?: number }[]
  document?: { file_id: string; file_name?: string; file_size?: number }
  video?: { file_id: string; file_name?: string; file_size?: number }
  audio?: { file_id: string; file_name?: string; file_size?: number }
  voice?: unknown
  video_note?: unknown
  sticker?: unknown
  location?: unknown
  contact?: unknown
  poll?: unknown
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter?: number
  ) {
    super(message)
  }
}

async function call<T>(api: string, token: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${api}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal
  })
  const data = (await response.json().catch(() => null)) as { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } | null
  if (!data?.ok) {
    throw new TelegramError(data?.description ?? `Telegram answered ${response.status}`, data?.error_code ?? response.status, data?.parameters?.retry_after)
  }
  return data.result as T
}

/** Checks a token and names the bot: "@NovaBot". Throws a sentence for the user. */
export async function verifyTelegramToken(token: string, api = TELEGRAM_API): Promise<{ account: string; id: string }> {
  if (!/^\d+:[\w-]{30,}$/.test(token.trim())) throw new Error('That doesn’t look like a Telegram bot token. It looks like 123456789:ABC… — BotFather sends it when you create the bot.')
  try {
    const me = await call<TelegramUser>(api, token.trim(), 'getMe', undefined, AbortSignal.timeout(15_000))
    return { account: `@${me.username ?? me.first_name}`, id: String(me.id) }
  } catch (error) {
    if (error instanceof TelegramError && (error.code === 401 || error.code === 404)) throw new Error('Telegram didn’t accept that token. Copy it again from BotFather.')
    throw new Error(`Couldn’t reach Telegram: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })

export class TelegramConnector implements Connector {
  readonly kind = 'telegram' as const
  readonly typingEveryMs = 4500
  private readonly abort = new AbortController()
  private me: TelegramUser | null = null
  private running: Promise<void> | null = null

  constructor(
    private readonly token: string,
    private readonly events: ConnectorEvents,
    private readonly api = TELEGRAM_API
  ) {}

  start(): void {
    if (!this.running) this.running = this.loop()
  }

  async stop(): Promise<void> {
    this.abort.abort()
    await this.running
  }

  private call<T>(method: string, body?: unknown, signal: AbortSignal = this.abort.signal): Promise<T> {
    return call<T>(this.api, this.token, method, body, signal)
  }

  private async loop(): Promise<void> {
    const signal = this.abort.signal
    let offset = 0
    let failures = 0
    let connected = false
    this.events.status({ state: 'connecting' })
    while (!signal.aborted) {
      try {
        if (!this.me) {
          this.me = await this.call<TelegramUser>('getMe')
          this.events.account({ account: `@${this.me.username ?? this.me.first_name}`, selfId: String(this.me.id) })
          await this.call('setMyCommands', {
            commands: CHANNEL_COMMANDS.map((c) => ({ command: c.name, description: c.description }))
          }).catch(() => {})
        }
        const updates = await this.call<{ update_id: number; message?: TelegramMessage }[]>(
          'getUpdates',
          { offset, timeout: POLL_SECONDS, allowed_updates: ['message'] },
          AbortSignal.any([signal, AbortSignal.timeout((POLL_SECONDS + 15) * 1000)])
        )
        if (!connected) this.events.status({ state: 'connected' })
        connected = true
        failures = 0
        for (const update of updates) {
          offset = update.update_id + 1
          if (update.message) this.handle(update.message)
        }
      } catch (error) {
        if (signal.aborted) break
        failures += 1
        connected = false
        if (error instanceof TelegramError && error.code === 401) {
          this.events.status({ state: 'error', message: 'Telegram no longer accepts this bot’s token. Paste a new one from BotFather.' })
          return
        }
        if (error instanceof TelegramError && error.code === 409) {
          this.events.status({
            state: 'error',
            message: 'Another program is reading this bot’s messages (or it has a webhook). Stop it, or make a separate bot for Eaon. Retrying every 30 seconds.'
          })
          await sleep(30_000, signal)
          continue
        }
        const wait = error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : Math.min(2 ** failures * 1000, 60_000)
        this.events.status({ state: 'connecting', message: `Reconnecting — ${error instanceof Error ? error.message : String(error)}` })
        await sleep(wait, signal)
      }
    }
    this.events.status({ state: 'off' })
  }

  private handle(message: TelegramMessage): void {
    const me = this.me
    const from = message.from
    if (!me || !from || from.is_bot || message.chat.type === 'channel') return
    const isGroup = message.chat.type !== 'private'
    const raw = message.text ?? message.caption ?? ''
    const entities = message.entities ?? message.caption_entities ?? []
    const handle = me.username ? `@${me.username}` : null

    let mentioned = message.reply_to_message?.from?.id === me.id
    for (const entity of entities) {
      const piece = raw.slice(entity.offset, entity.offset + entity.length)
      if (entity.type === 'mention' && handle && piece.toLowerCase() === handle.toLowerCase()) mentioned = true
      if (entity.type === 'text_mention' && entity.user?.id === me.id) mentioned = true
      // In a group every bot gets every command; "/status@OtherBot" is not ours.
      if (entity.type === 'bot_command' && entity.offset === 0) {
        const target = piece.split('@')[1]
        if (!target || (me.username && target.toLowerCase() === me.username.toLowerCase())) mentioned = true
      }
    }
    let text = raw
    if (handle) text = text.replace(new RegExp(`\\s*${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ')
    text = text.replace(/\s+\n/g, '\n').trim()

    const files: IncomingFile[] = []
    const file = (id: string, name: string, size?: number): IncomingFile => ({ name, size: size ?? null, download: () => this.download(id) })
    if (message.photo?.length) {
      const largest = message.photo[message.photo.length - 1]
      files.push(file(largest.file_id, `photo-${message.message_id}.jpg`, largest.file_size))
    }
    for (const doc of [message.document, message.video, message.audio]) {
      if (doc) files.push(file(doc.file_id, doc.file_name ?? `file-${message.message_id}`, doc.file_size))
    }
    const unsupported = message.voice
      ? 'a voice message'
      : message.video_note
        ? 'a video message'
        : message.sticker
          ? 'a sticker'
          : message.location
            ? 'a location'
            : message.contact
              ? 'a contact'
              : message.poll
                ? 'a poll'
                : undefined

    this.events.message({
      chatId: String(message.chat.id),
      chatName: isGroup ? (message.chat.title ?? 'a group') : 'Direct message',
      isGroup,
      senderId: String(from.id),
      senderName: [from.first_name, from.last_name].filter(Boolean).join(' ') + (from.username ? ` (@${from.username})` : ''),
      messageId: String(message.message_id),
      text,
      mentioned,
      files,
      ...(unsupported ? { unsupported } : {})
    })
  }

  private async download(fileId: string): Promise<Buffer> {
    const info = await this.call<{ file_path?: string }>('getFile', { file_id: fileId })
    if (!info.file_path) throw new Error('Telegram only lets bots download files up to 20 MB.')
    const response = await fetch(`${this.api}/file/bot${this.token}/${info.file_path}`, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(120_000)]) })
    if (!response.ok) throw new Error(`Telegram answered ${response.status} for the file`)
    return Buffer.from(await response.arrayBuffer())
  }

  async send(chatId: string, markdown: string, replyTo?: string): Promise<void> {
    const pieces = chunkText(markdown, MAX_MESSAGE_CHARS.telegram - 400)
    for (const [index, piece] of pieces.entries()) {
      const base = {
        chat_id: chatId,
        link_preview_options: { is_disabled: true },
        // Only the first piece quotes the message it answers.
        ...(replyTo && index === 0 ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : {})
      }
      try {
        await this.call('sendMessage', { ...base, text: toTelegramHtml(piece), parse_mode: 'HTML' })
      } catch (error) {
        // Formatting Telegram rejects ("can't parse entities") goes again as plain text.
        if (!(error instanceof TelegramError) || error.code !== 400) throw error
        await this.call('sendMessage', { ...base, text: plainText(piece) })
      }
    }
  }

  async sendFile(chatId: string, path: string, caption?: string): Promise<void> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${path} is not a file.`)
    if (info.size > MAX_UPLOAD_BYTES) throw new Error('Telegram bots can send files up to 50 MB.')
    const photo = PHOTO_EXTENSIONS.has(extname(path).toLowerCase()) && info.size <= 10 * 1024 * 1024
    const form = new FormData()
    form.set('chat_id', chatId)
    if (caption) form.set('caption', plainText(caption).slice(0, 1024))
    form.set(photo ? 'photo' : 'document', new Blob([await readFile(path)]), basename(path))
    const response = await fetch(`${this.api}/bot${this.token}/${photo ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: form, signal: this.abort.signal })
    const data = (await response.json().catch(() => null)) as { ok: boolean; description?: string } | null
    if (!data?.ok) throw new Error(`Telegram refused the file: ${data?.description ?? response.status}`)
  }

  async typing(chatId: string, on: boolean): Promise<void> {
    if (on) await this.call('sendChatAction', { chat_id: chatId, action: 'typing' })
  }

  async directChat(userId: string): Promise<string> {
    // A private chat's id is the user's id; the bot can write once they have started it.
    return userId
  }
}
