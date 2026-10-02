import { safeStorage } from 'electron'
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { AuthenticationCreds, AuthenticationState, proto, WAMessage, WASocket } from 'baileys'
import { MAX_MESSAGE_CHARS, type WhatsAppGroup } from '@shared/channels'
import { chunkText, toWhatsApp } from './format'
import type { Connector, ConnectorEvents, IncomingFile } from './types'

/**
 * WhatsApp, linked as a device the way WhatsApp Web is: the user scans a QR
 * code with their phone, and the worker reads and writes as that account.
 * This goes through Baileys, an unofficial client of WhatsApp's multi-device
 * protocol — WhatsApp has no bot API for personal accounts or groups — so it
 * can break when WhatsApp changes, and WhatsApp may restrict numbers it
 * thinks are automated. Settings says so before anyone links.
 *
 * The session keys are the account itself, so they are written encrypted
 * with the OS keychain (`safeStorage`), one file per key like Baileys' own
 * multi-file store, and removed when the link is.
 */

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
/** Messages this old when they arrive (sent while Eaon was closed) are not answered: replying hours later as the user reads strangely. */
const STALE_MS = 30 * 60_000
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

/** Baileys wants a pino-shaped logger; Eaon only cares about its errors. */
const logger = {
  level: 'silent',
  child() {
    return logger
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error(obj: unknown, msg?: string) {
    if (msg) console.error('[whatsapp]', msg)
  }
}

/* --------------------------------------------------------- encrypted auth */

const fileName = (key: string): string => `${key.replace(/\//g, '__').replace(/:/g, '-')}.dat`

/** Per-file queue, so a read never sees a half-written file (Baileys does the same with a mutex). */
const queues = new Map<string, Promise<unknown>>()
function locked<T>(path: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(path) ?? Promise.resolve()).then(work, work)
  queues.set(
    path,
    next.catch(() => {})
  )
  return next
}

function seal(json: string): Buffer {
  return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8')
}

function unseal(data: Buffer): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(data)
    } catch {
      /* written while the keychain was unavailable — plaintext */
    }
  }
  return data.toString('utf8')
}

export async function vaultAuthState(dir: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const { BufferJSON, initAuthCreds, proto } = await import('baileys')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const write = (key: string, value: unknown): Promise<void> => {
    const path = join(dir, fileName(key))
    return locked(path, async () => {
      await writeFile(`${path}.tmp`, seal(JSON.stringify(value, BufferJSON.replacer)), { mode: 0o600 })
      await rename(`${path}.tmp`, path)
    })
  }
  const read = async (key: string): Promise<unknown> => {
    const path = join(dir, fileName(key))
    return locked(path, async () => {
      try {
        return JSON.parse(unseal(await readFile(path)), BufferJSON.reviver)
      } catch {
        return null
      }
    })
  }
  const remove = (key: string): Promise<void> => {
    const path = join(dir, fileName(key))
    return locked(path, () => unlink(path).catch(() => {}))
  }
  const creds = ((await read('creds')) as AuthenticationCreds | null) ?? initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: Record<string, unknown> = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}`)
              if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value as object)
              data[id] = value
            })
          )
          return data as never
        },
        set: async (data) => {
          const tasks: Promise<void>[] = []
          for (const category of Object.keys(data) as (keyof typeof data)[]) {
            for (const [id, value] of Object.entries(data[category] ?? {})) {
              tasks.push(value ? write(`${category}-${id}`, value) : remove(`${category}-${id}`))
            }
          }
          await Promise.all(tasks)
        }
      }
    },
    saveCreds: () => write('creds', creds)
  }
}

/* ------------------------------------------------------------- connector */

/** The message inside WhatsApp's wrappers (disappearing, view-once, captioned documents). */
function unwrap(message: proto.IMessage | null | undefined): proto.IMessage | null {
  let m = message ?? null
  for (let i = 0; i < 4 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ??
      m.viewOnceMessage?.message ??
      m.viewOnceMessageV2?.message ??
      m.documentWithCaptionMessage?.message ??
      m.editedMessage?.message
    if (!inner) break
    m = inner
  }
  return m
}

/** "447700900123@s.whatsapp.net" → "+447700900123". */
const phone = (jid: string): string => `+${jid.split('@')[0].split(':')[0]}`

export class WhatsAppConnector implements Connector {
  readonly kind = 'whatsapp' as const
  readonly typingEveryMs = 10_000
  private socket: WASocket | null = null
  private stopped = false
  private failures = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private selfIds = new Set<string>()
  private connectedAt = 0
  /** What we sent, by id: echoes are skipped, replies to them count as addressed, and retries can be re-sent. */
  private readonly sent = new Map<string, proto.IMessage>()
  /** Recent incoming messages, so a reply can quote them. */
  private readonly recent = new Map<string, WAMessage>()
  private readonly groupNames = new Map<string, string>()

  constructor(
    private readonly dir: string,
    private readonly events: ConnectorEvents
  ) {}

  start(): void {
    this.events.status({ state: 'connecting' })
    void this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.socket?.end(undefined)
    this.socket = null
    this.events.status({ state: 'off' })
  }

  async logout(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    await this.socket?.logout().catch(() => {})
    this.socket?.end(undefined)
    this.socket = null
    await rm(this.dir, { recursive: true, force: true })
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    try {
      const baileys = await import('baileys')
      const makeSocket = baileys.default
      const { state, saveCreds } = await vaultAuthState(this.dir)
      // WhatsApp refuses clients that claim an old web version; ask for the current one, and fall back to Baileys' own.
      const latest = await Promise.race([
        baileys.fetchLatestBaileysVersion().catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
      ])
      if (this.stopped) return
      const socket = makeSocket({
        auth: { creds: state.creds, keys: baileys.makeCacheableSignalKeyStore(state.keys, logger) },
        logger,
        browser: baileys.Browsers.macOS('Eaon'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        getMessage: async (key) => (key.id ? this.sent.get(key.id) : undefined),
        ...(latest?.version ? { version: latest.version } : {})
      })
      this.socket = socket
      socket.ev.on('creds.update', () => void saveCreds())
      socket.ev.on('connection.update', (update) => {
        if (socket !== this.socket) return
        if (update.qr) this.events.status({ state: 'scan', qr: update.qr })
        if (update.connection === 'open') {
          this.failures = 0
          this.connectedAt = Date.now()
          const user = socket.user
          if (user) {
            this.selfIds = new Set([user.id, user.lid, user.phoneNumber].filter((id): id is string => Boolean(id)).map((id) => baileys.jidNormalizedUser(id)))
            const selfId = baileys.jidNormalizedUser(user.id)
            this.events.account({ account: phone(selfId), selfId, selfName: user.name ?? user.notify ?? phone(selfId) })
          }
          this.events.status({ state: 'connected' })
        }
        if (update.connection === 'close') {
          const error = update.lastDisconnect?.error as { output?: { statusCode?: number }; message?: string } | undefined
          const code = error?.output?.statusCode
          this.socket = null
          if (this.stopped) return
          if (code === baileys.DisconnectReason.loggedOut) {
            // Unlinked from the phone: forget the session and offer a fresh code.
            void rm(this.dir, { recursive: true, force: true }).then(() => {
              this.events.status({ state: 'connecting', message: 'This computer was unlinked from WhatsApp. Scan the new code to link it again.' })
              void this.connect()
            })
            return
          }
          if (code === baileys.DisconnectReason.restartRequired) {
            // Normal right after the QR is scanned.
            void this.connect()
            return
          }
          if (code === baileys.DisconnectReason.connectionReplaced) {
            this.events.status({ state: 'error', message: 'Another copy of Eaon (or another program) opened this WhatsApp session. Switch this one off and on to take it back.' })
            return
          }
          this.retry(error?.message ?? `closed (${code ?? 'no code'})`)
        }
      })
      socket.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return
        for (const message of messages) void this.handle(message).catch((error) => console.error('[whatsapp] could not read a message:', error))
      })
    } catch (error) {
      this.retry(error instanceof Error ? error.message : String(error))
    }
  }

  private retry(reason: string): void {
    if (this.stopped) return
    this.failures += 1
    const wait = Math.min(2000 * 2 ** Math.min(this.failures, 5), 60_000)
    this.events.status({ state: 'connecting', message: `Reconnecting — ${reason}` })
    this.reconnectTimer = setTimeout(() => void this.connect(), wait)
  }

  private isSelf(jid: string | null | undefined): boolean {
    if (!jid) return false
    const bare = `${jid.split('@')[0].split(':')[0]}@${jid.split('@')[1] ?? ''}`
    return this.selfIds.has(bare)
  }

  private async handle(message: WAMessage): Promise<void> {
    const socket = this.socket
    const key = message.key
    const jid = key.remoteJid
    if (!socket || !jid || !key.id || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return
    // Our own reply coming back to us.
    if (key.fromMe && this.sent.has(key.id)) return
    const at = Number(message.messageTimestamp ?? 0) * 1000
    if (at && at < Math.min(this.connectedAt, Date.now()) - STALE_MS) return
    const content = unwrap(message.message)
    if (!content || content.protocolMessage || content.reactionMessage) return

    const isGroup = jid.endsWith('@g.us')
    const fromSelf = Boolean(key.fromMe)
    const sender = fromSelf ? [...this.selfIds][0] ?? jid : isGroup ? (key.participant ?? '') : jid
    if (!sender) return
    const text =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      content.documentMessage?.caption ??
      ''
    const context =
      content.extendedTextMessage?.contextInfo ?? content.imageMessage?.contextInfo ?? content.videoMessage?.contextInfo ?? content.documentMessage?.contextInfo
    const mentioned = Boolean(
      (context?.stanzaId && this.sent.has(context.stanzaId)) || context?.mentionedJid?.some((m) => this.isSelf(m))
    )
    const baileys = await import('baileys')
    const files: IncomingFile[] = []
    const media = (name: string, size: unknown): IncomingFile => ({
      name,
      size: size === null || size === undefined ? null : Number(size),
      download: async () => (await baileys.downloadMediaMessage(message, 'buffer', {})) as Buffer
    })
    if (content.imageMessage) files.push(media(`photo-${key.id}.jpg`, content.imageMessage.fileLength))
    if (content.videoMessage) files.push(media(`video-${key.id}.mp4`, content.videoMessage.fileLength))
    if (content.documentMessage) files.push(media(content.documentMessage.fileName ?? `file-${key.id}`, content.documentMessage.fileLength))
    const unsupported = content.audioMessage
      ? 'a voice message'
      : content.stickerMessage
        ? 'a sticker'
        : content.locationMessage || content.liveLocationMessage
          ? 'a location'
          : content.contactMessage
            ? 'a contact'
            : content.pollCreationMessage || content.pollCreationMessageV3
              ? 'a poll'
              : undefined
    if (!text && files.length === 0 && !unsupported) return

    this.recent.set(key.id, message)
    if (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value!)
    this.events.message({
      chatId: jid,
      chatName: isGroup ? await this.groupName(jid) : 'Direct message',
      isGroup,
      senderId: baileys.jidNormalizedUser(sender),
      senderName: fromSelf ? 'You' : (message.pushName ?? phone(sender)),
      messageId: key.id,
      // An @-mention of the linked number reads as "@447700900123" in the text.
      text: text.replace(/@\d{6,}/g, (tag) => (this.isSelf(`${tag.slice(1)}@s.whatsapp.net`) ? '' : tag)).trim(),
      mentioned,
      fromSelf,
      selfChat: !isGroup && this.isSelf(jid),
      files,
      ...(unsupported ? { unsupported } : {})
    })
  }

  private async groupName(jid: string): Promise<string> {
    const known = this.groupNames.get(jid)
    if (known) return known
    const meta = await this.socket?.groupMetadata(jid).catch(() => null)
    const name = meta?.subject || 'a group'
    this.groupNames.set(jid, name)
    return name
  }

  private remember(sent: proto.IWebMessageInfo | undefined): void {
    if (!sent?.key?.id || !sent.message) return
    this.sent.set(sent.key.id, sent.message)
    if (this.sent.size > 500) this.sent.delete(this.sent.keys().next().value!)
  }

  private live(): WASocket {
    if (!this.socket) throw new Error('WhatsApp isn’t connected right now.')
    return this.socket
  }

  async send(chatId: string, markdown: string, replyTo?: string): Promise<void> {
    const socket = this.live()
    const quoted = replyTo ? this.recent.get(replyTo) : undefined
    for (const [index, piece] of chunkText(toWhatsApp(markdown), MAX_MESSAGE_CHARS.whatsapp).entries()) {
      this.remember(await socket.sendMessage(chatId, { text: piece }, index === 0 && quoted ? { quoted } : {}))
    }
  }

  async sendFile(chatId: string, path: string, caption?: string): Promise<void> {
    const socket = this.live()
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${path} is not a file.`)
    if (info.size > MAX_UPLOAD_BYTES) throw new Error('WhatsApp can send files up to 100 MB.')
    const data = await readFile(path)
    const text = caption ? toWhatsApp(caption) : undefined
    const content = IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
      ? { image: data, ...(text ? { caption: text } : {}) }
      : { document: data, fileName: basename(path), mimetype: 'application/octet-stream', ...(text ? { caption: text } : {}) }
    this.remember(await socket.sendMessage(chatId, content))
  }

  async typing(chatId: string, on: boolean): Promise<void> {
    await this.socket?.sendPresenceUpdate(on ? 'composing' : 'paused', chatId)
  }

  async directChat(userId: string): Promise<string> {
    return userId
  }

  async groups(): Promise<WhatsAppGroup[]> {
    const all = await this.live().groupFetchAllParticipating()
    return Object.values(all)
      .map((group) => {
        this.groupNames.set(group.id, group.subject)
        return { id: group.id, name: group.subject || 'Unnamed group', size: group.participants?.length ?? 0 }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}
