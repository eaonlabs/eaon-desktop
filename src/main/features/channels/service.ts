import { randomInt, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, sep } from 'node:path'
import {
  CHANNEL_COMMANDS,
  CHANNEL_LABEL,
  GUEST_ACCESS,
  GUEST_MESSAGES_PER_HOUR,
  MAX_CHATS,
  MAX_INCOMING_FILE_BYTES,
  MAX_PEOPLE,
  MAX_REQUESTS,
  type ChannelKind,
  type ChannelLevel,
  type ChannelLink,
  type ChannelLinkPatch,
  type ChannelRequest,
  type ChannelStatus,
  type GuestAccess,
  type WhatsAppGroup
} from '@shared/channels'
import type { ChatMessage } from '@shared/types'
import { approvalCode, describeWorker, type Worker, type WorkerAsk, type WorkerMail } from '@shared/workers'
import { redactSecrets } from '../../redact'
import type { WorkersEngine } from '../workers/engine'
import { calledByName, parseCommand, replyText } from './format'
import type { Connector, ConnectorEvents, IncomingMessage } from './types'

/**
 * Chat apps, end to end: which bots run, who may talk to which worker, and
 * getting replies back to the chat they were asked in.
 *
 * - **Owner.** The user claims a Discord or Telegram bot by sending it
 *   `/pair CODE` (the code is shown in Settings) from their own account; a
 *   WhatsApp link is the user's own account, so it is theirs from the start.
 *   The owner's messages arrive as the user's own mail and may use every
 *   command.
 * - **Guests.** People the owner let in, and everyone in a group the owner
 *   allowed. Their mail carries the link's `guestAccess` as a cap, which the
 *   engine holds the whole turn to (see workers/guests.ts). Strangers get a
 *   request with a short code the owner can accept in Eaon or with `/allow`.
 * - **Addressed.** In a DM a bot answers everything; in a group only when
 *   mentioned, replied to, or called by name — unless the owner chose "every
 *   message" for that link. A WhatsApp link on the user's own number answers
 *   only when called by name (or in "Message yourself"), and never speaks up
 *   to strangers, because it would be speaking as the user.
 *
 * Replies go back when the worker's turn ends: the text after its last real
 * tool call, to every chat that had mail in the turn, unless the worker
 * already posted there itself with `send_chat_message`.
 *
 * Everything outside the process (storage, secrets, the apps themselves) is
 * injected so tests can drive it with fake connectors.
 */

export interface ChannelsDeps {
  engine: WorkersEngine
  loadLinks: () => unknown
  saveLinks: (links: ChannelLink[]) => void
  getToken: (linkId: string) => string | undefined
  setToken: (linkId: string, token: string | null) => void
  /** Checks a bot token with the app; throws a sentence for the user. */
  verifyToken: (kind: Exclude<ChannelKind, 'whatsapp'>, token: string) => Promise<{ account: string; id: string }>
  createConnector: (link: ChannelLink, token: string | null, events: ConnectorEvents) => Connector
  onChange?: (links: ChannelLink[]) => void
  onStatus?: (statuses: ChannelStatus[]) => void
  now?: () => number
}

type Role = 'owner' | ChannelLevel

interface Destination {
  id: string
  label: string
  linkId: string
  resolve: () => Promise<string>
}

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const REQUEST_TTL = 7 * DAY
const MAX_FILES_PER_MESSAGE = 5
/** Typing stops by itself after this, in case a turn never reports back. */
const TYPING_LIMIT_MS = 15 * 60_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const KINDS: ChannelKind[] = ['discord', 'telegram', 'whatsapp']
const COMMANDS = new Set(CHANNEL_COMMANDS.map((c) => c.name))

/**
 * The call an approval is for, as lines to show in a chat: the tool and its
 * arguments, secrets blanked and long values cut. The model's own summary of
 * what it wants is shown too, but the owner agrees to this.
 */
function describeCall(ask: WorkerAsk): string[] {
  const call = ask.approve
  if (!call) return []
  let args = ''
  try {
    args = JSON.stringify(call.input)
  } catch {
    args = ''
  }
  const shown = redactSecrets(args)
  return [`Tool: ${call.tool}`, ...(shown && shown !== '{}' ? [`With: ${shown.length > 600 ? `${shown.slice(0, 599)}…` : shown}`] : [])]
}

const clone = <T>(value: T): T => structuredClone(value)
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const chatKey = (linkId: string, chatId: string): string => `${linkId}|${chatId}`
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function code(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return out
}

/** Fills in anything an older or hand-edited file lacks; null for something that isn't a link. */
function normalize(raw: unknown, now: number): ChannelLink | null {
  const v = raw as Partial<ChannelLink> | null
  if (!v || typeof v.id !== 'string' || !KINDS.includes(v.kind as ChannelKind)) return null
  const list = <T>(value: unknown, ok: (item: T) => boolean): T[] => (Array.isArray(value) ? (value as T[]).filter((item) => item && ok(item)) : [])
  return {
    id: v.id,
    kind: v.kind as ChannelKind,
    workerId: typeof v.workerId === 'string' ? v.workerId : null,
    enabled: v.enabled === true,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : now,
    account: typeof v.account === 'string' ? v.account : null,
    appId: typeof v.appId === 'string' ? v.appId : null,
    owner: v.owner && typeof v.owner.id === 'string' ? { id: v.owner.id, name: str(v.owner.name) || 'You' } : null,
    pairCode: typeof v.pairCode === 'string' && /^[A-Z0-9]{6}$/.test(v.pairCode) ? v.pairCode : code(6),
    people: list(v.people, (p: ChannelLink['people'][number]) => typeof p.id === 'string').map((p) => ({ ...p, level: p.level === 'control' ? 'control' : 'chat' })),
    chats: list(v.chats, (c: ChannelLink['chats'][number]) => typeof c.id === 'string'),
    requests: list(v.requests, (r: ChannelRequest) => typeof r.code === 'string' && typeof r.id === 'string' && now - (r.at ?? 0) < REQUEST_TTL),
    groupReplies: v.groupReplies === 'all' ? 'all' : 'mention',
    guestAccess: GUEST_ACCESS.some((g) => g.id === v.guestAccess) ? (v.guestAccess as GuestAccess) : 'talk',
    forwardAlerts: v.forwardAlerts !== false,
    whatsappMode: v.whatsappMode === 'dedicated' ? 'dedicated' : 'personal'
  }
}

/**
 * A file name safe to write: no folders, no control characters, and nothing
 * Windows refuses or reads as a device — a name ending in a dot or space, or
 * one called CON, NUL, COM1 and so on, with or without an extension.
 */
export function safeName(name: string): string {
  const cleaned = basename(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
    .replace(/[. ]+$/, '')
  if (!cleaned) return 'file'
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\s*(\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned
}

function freePath(dir: string, name: string): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = join(dir, name)
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`)
  return candidate
}

export class ChannelsService {
  private links: ChannelLink[] = []
  private readonly connectors = new Map<string, Connector>()
  private readonly statuses = new Map<string, ChannelStatus>()
  private readonly typing = new Map<string, { timer: ReturnType<typeof setInterval>; stop: ReturnType<typeof setTimeout> }>()
  /** Chats with mail in each worker's running turn. */
  private readonly turnChats = new Map<string, Set<string>>()
  /** Chats the worker posted in itself during its running turn. */
  private readonly postedThisTurn = new Map<string, Set<string>>()
  private readonly guestLog = new Map<string, number[]>()
  private readonly pairFailures = new Map<string, number[]>()
  /** When each automatic notice (request received, slow down…) last went out, so they are not repeated. */
  private readonly notices = new Map<string, number>()
  private unobserve: (() => void) | null = null
  private readonly now: () => number

  constructor(private readonly deps: ChannelsDeps) {
    this.now = deps.now ?? Date.now
  }

  /* --------------------------------------------------------------- lifecycle */

  load(): void {
    const raw = this.deps.loadLinks()
    const now = this.now()
    this.links = (Array.isArray(raw) ? raw : []).map((l) => normalize(l, now)).filter((l): l is ChannelLink => l !== null)
  }

  start(): void {
    this.unobserve = this.deps.engine.observe({
      turnStarted: (worker, mail) => this.turnStarted(worker, mail),
      turnEnded: (worker, turn) => void this.turnEnded(worker, turn).catch((error) => console.error('[channels] could not post a reply:', error)),
      asked: (worker, ask) => {
        const lines = [`${worker.name} has a question: ${ask.question}`]
        if (ask.approve) {
          // The exact call, not just the model's description of it: this is what the owner is agreeing to.
          lines.push(`It wants to: ${ask.approve.summary}`, ...describeCall(ask), `Reply /approve ${approvalCode(ask)} or /decline ${approvalCode(ask)}.`)
        } else {
          ask.options.forEach((option, i) => lines.push(`${i + 1}. ${option}`))
          lines.push(ask.options.length ? 'Reply /answer with a number or your own words.' : 'Reply /answer and your answer.')
        }
        void this.tellOwners(worker.id, lines.join('\n'))
      },
      notified: (worker, message) => void this.tellOwners(worker.id, `${message.title}\n${message.body}`)
    })
    for (const link of this.links) this.sync(link)
  }

  async stop(): Promise<void> {
    this.unobserve?.()
    this.unobserve = null
    for (const key of [...this.typing.keys()]) this.stopTyping(key)
    const running = [...this.connectors.values()]
    this.connectors.clear()
    await Promise.all(running.map((c) => c.stop().catch(() => {})))
  }

  /* ------------------------------------------------------------------- reads */

  list(): ChannelLink[] {
    return clone(this.links)
  }

  statusList(): ChannelStatus[] {
    return this.links.map((l) => this.statuses.get(l.id) ?? { linkId: l.id, state: 'off' })
  }

  hasToken(id: string): boolean {
    return Boolean(this.deps.getToken(id))
  }

  /* ---------------------------------------------------------------- commands */

  /** A new connection for `workerId`. Discord and Telegram wait for a token; WhatsApp starts linking at once. */
  create(kind: ChannelKind, workerId: string | null): ChannelLink {
    if (!KINDS.includes(kind)) throw new Error('Unknown chat app.')
    if (workerId && !this.deps.engine.has(workerId)) throw new Error('That worker no longer exists.')
    const link = normalize({ id: randomUUID(), kind, workerId, enabled: kind === 'whatsapp' }, this.now())!
    this.links.push(link)
    this.commit()
    this.sync(link)
    return clone(link)
  }

  /** Checks the bot token with the app, saves it to the vault and connects. */
  async setToken(id: string, token: string): Promise<ChannelLink> {
    const link = this.require(id)
    if (link.kind === 'whatsapp') throw new Error('WhatsApp links with a QR code, not a token.')
    const trimmed = token.trim().replace(/^Bot\s+/i, '')
    const who = await this.deps.verifyToken(link.kind, trimmed)
    // A different bot is a fresh start: nobody paired with it yet.
    if (link.account && link.account !== who.account) Object.assign(link, { owner: null, people: [], chats: [], requests: [], pairCode: code(6) })
    this.deps.setToken(id, trimmed)
    link.account = who.account
    if (link.kind === 'discord') link.appId = who.id
    link.enabled = true
    this.commit()
    await this.restart(link)
    return clone(link)
  }

  update(id: string, patch: ChannelLinkPatch): ChannelLink {
    const link = this.require(id)
    if (patch.workerId !== undefined) {
      if (patch.workerId !== null && !this.deps.engine.has(patch.workerId)) throw new Error('That worker no longer exists.')
      link.workerId = patch.workerId
    }
    if (patch.groupReplies === 'all' || patch.groupReplies === 'mention') link.groupReplies = patch.groupReplies
    if (patch.guestAccess && GUEST_ACCESS.some((g) => g.id === patch.guestAccess)) link.guestAccess = patch.guestAccess
    if (typeof patch.forwardAlerts === 'boolean') link.forwardAlerts = patch.forwardAlerts
    if (patch.whatsappMode === 'personal' || patch.whatsappMode === 'dedicated') link.whatsappMode = patch.whatsappMode
    if (typeof patch.enabled === 'boolean') link.enabled = patch.enabled
    this.commit()
    this.sync(link)
    return clone(link)
  }

  /** Disconnects and forgets the link: its token, and a WhatsApp session (unlinked from the phone). */
  async remove(id: string): Promise<void> {
    const link = this.require(id)
    const connector = this.connectors.get(id)
    this.connectors.delete(id)
    if (connector?.logout) await connector.logout().catch(() => {})
    else await connector?.stop().catch(() => {})
    this.links = this.links.filter((l) => l.id !== id)
    this.statuses.delete(id)
    if (link.kind !== 'whatsapp') this.deps.setToken(id, null)
    this.commit()
    this.emitStatus()
  }

  /** Lets in whoever asked with `code`: a person, or everyone in a group. */
  allow(id: string, requestCode: string): ChannelLink {
    const link = this.require(id)
    const request = this.accept(link, requestCode)
    if (!request) throw new Error('That request has expired or was already answered.')
    return clone(link)
  }

  dismiss(id: string, requestCode: string): ChannelLink {
    const link = this.require(id)
    link.requests = link.requests.filter((r) => r.code !== requestCode.toUpperCase())
    this.commit()
    return clone(link)
  }

  setPersonLevel(id: string, personId: string, level: ChannelLevel): ChannelLink {
    const link = this.require(id)
    const person = link.people.find((p) => p.id === personId)
    if (!person) throw new Error('That person is no longer on the list.')
    person.level = level === 'control' ? 'control' : 'chat'
    this.commit()
    return clone(link)
  }

  removePerson(id: string, personId: string): ChannelLink {
    const link = this.require(id)
    link.people = link.people.filter((p) => p.id !== personId)
    this.commit()
    return clone(link)
  }

  /** WhatsApp: pick a group from the account's own list. */
  addChat(id: string, chatId: string, name: string): ChannelLink {
    const link = this.require(id)
    if (!link.chats.some((c) => c.id === chatId)) {
      if (link.chats.length >= MAX_CHATS) throw new Error(`A connection can answer in up to ${MAX_CHATS} groups.`)
      link.chats.push({ id: chatId, name: str(name) || 'a group', addedAt: this.now() })
      link.requests = link.requests.filter((r) => !(r.kind === 'chat' && r.id === chatId))
      this.commit()
    }
    return clone(link)
  }

  removeChat(id: string, chatId: string): ChannelLink {
    const link = this.require(id)
    link.chats = link.chats.filter((c) => c.id !== chatId)
    this.commit()
    return clone(link)
  }

  /** Forgets the owner and makes a new pairing code, for handing the bot to another account. */
  resetOwner(id: string): ChannelLink {
    const link = this.require(id)
    if (link.kind === 'whatsapp') throw new Error('A WhatsApp link always belongs to the account it is linked to.')
    link.owner = null
    link.pairCode = code(6)
    this.commit()
    return clone(link)
  }

  async whatsappGroups(id: string): Promise<WhatsAppGroup[]> {
    const connector = this.connectors.get(id)
    if (!connector?.groups) throw new Error('Connect WhatsApp first.')
    return connector.groups()
  }

  /* ------------------------------------------------------ the worker's tool */

  /** Every chat a worker may post in on its own: the owner, the people and the groups on its links. */
  destinations(workerId: string): Destination[] {
    const out: Destination[] = []
    for (const link of this.links) {
      if (!link.enabled || link.workerId !== workerId) continue
      const app = CHANNEL_LABEL[link.kind]
      const connector = (): Connector => {
        const c = this.connectors.get(link.id)
        if (!c) throw new Error(`${app} isn’t connected right now.`)
        return c
      }
      const owner = link.owner
      if (owner) out.push({ id: `${link.id}:owner`, label: `${app}: the user`, linkId: link.id, resolve: () => connector().directChat(owner.id) })
      for (const chat of link.chats) out.push({ id: `${link.id}:${chat.id}`, label: `${app}: ${chat.name}`, linkId: link.id, resolve: async () => chat.id })
      for (const person of link.people) {
        out.push({ id: `${link.id}:dm:${person.id}`, label: `${app}: ${person.name} (direct message)`, linkId: link.id, resolve: () => connector().directChat(person.id) })
      }
    }
    return out
  }

  /** `send_chat_message`. Returns a sentence for the tool result; throws one the model can act on. */
  async post(workerId: string, chat: string, text: string, files: string[] = []): Promise<string> {
    const worker = this.deps.engine.lookup(workerId)
    if (!worker) throw new Error('That worker no longer exists.')
    const all = this.destinations(workerId)
    const wanted = chat.trim().toLowerCase()
    const exact = all.find((d) => d.id.toLowerCase() === wanted || d.label.toLowerCase() === wanted)
    const partial = all.filter((d) => d.label.toLowerCase().includes(wanted))
    const target = exact ?? (partial.length === 1 ? partial[0] : undefined)
    if (!target) {
      const known = all.map((d) => `- ${d.label} (id: ${d.id})`).join('\n')
      throw new Error(`${partial.length > 1 ? `"${chat}" matches more than one chat` : `No connected chat matches "${chat}"`}. Your chats:\n${known || '(none)'}`)
    }
    if (!text.trim() && files.length === 0) throw new Error('Write something to post.')
    const link = this.require(target.linkId)
    const connector = this.connectors.get(link.id)
    if (!connector || this.statuses.get(link.id)?.state !== 'connected') throw new Error(`${CHANNEL_LABEL[link.kind]} isn’t connected right now, so nothing was posted.`)
    const chatId = await target.resolve()

    // A guest's turn may only answer where the guest is, and sends no files.
    if (this.deps.engine.turnCap(workerId) !== null) {
      if (!this.turnChats.get(workerId)?.has(chatKey(link.id, chatId))) {
        throw new Error('A guest’s message is part of this turn, so you can only post in the chat it came from.')
      }
      if (files.length > 0) throw new Error('A guest’s message is part of this turn, so you can’t send files now.')
    }
    const paths: string[] = []
    const home = await realpath(worker.folder).catch(() => worker.folder)
    for (const file of files) {
      // isAbsolute, not a leading separator: on Windows an absolute path starts with a drive (`C:\…`).
      const full = await realpath(isAbsolute(file) ? file : join(worker.folder, file)).catch(() => null)
      if (!full) throw new Error(`${file} doesn’t exist.`)
      if (full !== home && !full.startsWith(home + sep)) throw new Error(`${file} is outside your folder (${worker.folder}). Only files in your folder can be sent to a chat.`)
      paths.push(full)
    }
    if (text.trim()) await this.say(link, connector, chatId, text.trim(), undefined, worker.name)
    for (const path of paths) await connector.sendFile(chatId, path)
    this.postedThisTurn.get(workerId)?.add(chatKey(link.id, chatId))
    return `Posted in ${target.label}${paths.length ? ` with ${paths.length} file${paths.length === 1 ? '' : 's'}` : ''}.`
  }

  /* ------------------------------------------------------------ connectors */

  private sync(link: ChannelLink): void {
    const token = link.kind === 'whatsapp' ? null : (this.deps.getToken(link.id) ?? null)
    const shouldRun = link.enabled && (link.kind === 'whatsapp' || Boolean(token))
    const running = this.connectors.get(link.id)
    if (shouldRun && !running) {
      const connector = this.deps.createConnector(link, token, this.eventsFor(link.id))
      this.connectors.set(link.id, connector)
      connector.start()
    } else if (!shouldRun && running) {
      this.connectors.delete(link.id)
      void running.stop().catch(() => {})
      this.setStatus(link.id, { state: 'off' })
    } else if (!shouldRun) {
      this.setStatus(
        link.id,
        link.enabled && link.kind !== 'whatsapp'
          ? { state: 'error', needsToken: true, message: 'Eaon no longer has this bot’s token. Paste it again to reconnect.' }
          : { state: 'off' }
      )
    }
  }

  private async restart(link: ChannelLink): Promise<void> {
    const running = this.connectors.get(link.id)
    this.connectors.delete(link.id)
    await running?.stop().catch(() => {})
    this.sync(link)
  }

  private eventsFor(linkId: string): ConnectorEvents {
    // Events from a connector that has since been replaced or stopped are dropped.
    const current = (): boolean => this.connectors.has(linkId)
    return {
      status: (status) => {
        if (current() || status.state === 'off') this.setStatus(linkId, status)
      },
      account: (info) => {
        const link = this.find(linkId)
        if (!link || !current()) return
        link.account = info.account
        if (info.appId) link.appId = info.appId
        // A WhatsApp link is the user's own account: its owner is whoever it is linked to.
        if (link.kind === 'whatsapp' && info.selfId) link.owner = { id: info.selfId, name: info.selfName ?? 'You' }
        this.commit()
      },
      message: (message) => {
        if (!current()) return
        void this.handle(linkId, message).catch((error) => console.error(`[channels] ${linkId}: could not handle a message:`, error))
      }
    }
  }

  private setStatus(linkId: string, status: Omit<ChannelStatus, 'linkId'>): void {
    const previous = this.statuses.get(linkId)
    const next: ChannelStatus = { linkId, ...status }
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return
    this.statuses.set(linkId, next)
    this.emitStatus()
  }

  private emitStatus(): void {
    this.deps.onStatus?.(this.statusList())
  }

  /* ------------------------------------------------------ incoming messages */

  /** @internal Exposed for tests; connectors reach it through their events. */
  async handle(linkId: string, message: IncomingMessage): Promise<void> {
    const link = this.find(linkId)
    const connector = this.connectors.get(linkId)
    if (!link || !link.enabled || !connector) return
    const worker = link.workerId ? (this.deps.engine.lookup(link.workerId) ?? null) : null
    const workerName = worker?.name ?? 'This bot'
    const chatAllowed = link.chats.some((c) => c.id === message.chatId)

    let text = message.text.trim()
    const byName = worker ? calledByName(text, worker.name) : null
    // "Hey Nova" on its own is still something said to Nova.
    if (byName) text = byName
    const command = parseCommand(text)

    let addressed: boolean
    if (link.kind === 'whatsapp') {
      addressed =
        Boolean(message.selfChat) ||
        byName !== null ||
        message.mentioned ||
        (!message.isGroup && !message.fromSelf && link.whatsappMode === 'dedicated') ||
        (message.isGroup && !message.fromSelf && chatAllowed && link.groupReplies === 'all')
    } else {
      addressed = !message.isGroup || message.mentioned || byName !== null || (chatAllowed && link.groupReplies === 'all')
    }
    if (!addressed) return
    if (!text && message.files.length === 0 && !message.unsupported) return

    const isOwner = (link.owner !== null && message.senderId === link.owner.id) || (link.kind === 'whatsapp' && Boolean(message.fromSelf))
    const reply = (body: string): Promise<void> => this.say(link, connector, message.chatId, body, message.isGroup ? message.messageId : undefined, worker?.name)

    // Telegram's "Start" button sends `/start <payload>`: Settings links to the bot with the pairing code as that payload.
    if (command?.name === 'pair' || (command?.name === 'start' && command.args)) return this.pair(link, message, command.args, reply)

    const role = this.roleOf(link, message, isOwner)
    if (!role) return this.stranger(link, connector, message, text, workerName)

    if (command?.name === 'start') return this.command(link, message, role, { name: 'help', args: '' }, worker, reply)
    if (command && COMMANDS.has(command.name)) return this.command(link, message, role, command, worker, reply)

    if (!worker) {
      if (this.once(`noworker|${link.id}|${message.chatId}`, HOUR)) {
        await reply('This bot isn’t connected to a worker right now. Its owner can choose one in Eaon → Settings → Chat apps.')
      }
      return
    }

    if (role !== 'owner') {
      const key = `${link.id}|${message.senderId}`
      const now = this.now()
      const recent = (this.guestLog.get(key) ?? []).filter((at) => at > now - HOUR)
      if (recent.length >= GUEST_MESSAGES_PER_HOUR) {
        if (this.once(`slow|${key}`, HOUR)) await reply(`You’ve sent ${worker.name} a lot this hour. Give it a breather and try again later.`)
        return
      }
      this.guestLog.set(key, [...recent, now])
    }

    // The owner can talk in any group; the group itself still needs letting in.
    if (role === 'owner' && message.isGroup && !chatAllowed) {
      const { request, fresh } = this.ensureRequest(link, { kind: 'chat', id: message.chatId, name: message.chatName, preview: text })
      if (fresh && this.once(`ownergroup|${link.id}|${message.chatId}`, DAY)) {
        const note = `Only you can call ${worker.name} in ${message.chatName}. To let everyone there talk to it, send /allow ${request.code}.`
        // On the user's own WhatsApp number this would go to the whole group as the user; say it privately.
        if (link.kind === 'whatsapp' && link.whatsappMode === 'personal') await this.tellOwner(link, note)
        else await reply(note)
      }
    }

    const { saved, skipped } = await this.download(message, worker, link.kind)
    const notes = [
      message.unsupported ? `(Sent ${message.unsupported}, which you can’t open.)` : '',
      skipped.length ? `(Also sent ${skipped.join(', ')}, which couldn’t be saved: too large, or the download failed.)` : ''
    ].filter(Boolean)
    const body = [text, ...notes].filter(Boolean).join('\n')
    const mail: Omit<WorkerMail, 'id' | 'at'> = {
      from: role === 'owner' ? 'user' : 'guest',
      fromName: role === 'owner' ? 'You' : message.senderName,
      text: body,
      files: saved,
      channel: {
        linkId: link.id,
        kind: link.kind,
        chatId: message.chatId,
        chatName: message.chatName,
        isGroup: message.isGroup,
        messageId: message.messageId,
        senderId: message.senderId,
        ...(role === 'owner' ? {} : { cap: link.guestAccess })
      }
    }
    if (!mail.text && mail.files.length === 0) return
    this.deps.engine.receive(worker.id, mail)

    const current = this.deps.engine.lookup(worker.id)
    if (current?.paused) {
      if (this.once(`paused|${link.id}|${message.chatId}`, HOUR)) {
        await reply(role === 'owner' ? `${worker.name} is paused. Your message waits until you send /resume.` : `${worker.name} is taking a break and will read this later.`)
      }
    } else if (this.deps.engine.isRunning(worker.id) && !this.turnChats.get(worker.id)?.has(chatKey(link.id, message.chatId))) {
      if (!message.isGroup && this.once(`busy|${link.id}|${message.chatId}`, 10 * 60_000)) {
        await reply(`Got it. ${worker.name} is in the middle of something and will read this next.`)
      }
    }
  }

  private roleOf(link: ChannelLink, message: IncomingMessage, isOwner: boolean): Role | null {
    if (isOwner) return 'owner'
    const person = link.people.find((p) => p.id === message.senderId)
    if (person) return person.level
    if (message.isGroup && link.chats.some((c) => c.id === message.chatId)) return 'chat'
    return null
  }

  private async pair(link: ChannelLink, message: IncomingMessage, attempt: string, reply: (body: string) => Promise<void>): Promise<void> {
    if (link.kind === 'whatsapp') return
    if (link.owner?.id === message.senderId) {
      await reply('You’re already paired with this bot.')
      return
    }
    const key = `${link.id}|${message.senderId}`
    const now = this.now()
    const failures = (this.pairFailures.get(key) ?? []).filter((at) => at > now - HOUR)
    if (failures.length >= 5) return
    if (attempt.trim().toUpperCase() !== link.pairCode) {
      this.pairFailures.set(key, [...failures, now])
      await reply('That code doesn’t match. The pairing code is in Eaon → Settings → Chat apps.')
      return
    }
    link.owner = { id: message.senderId, name: message.senderName }
    link.pairCode = code(6)
    link.requests = link.requests.filter((r) => !(r.kind === 'person' && r.id === message.senderId))
    this.commit()
    await reply('Paired. This bot is yours now: talk to it here, and send /help to see what you can do.')
  }

  /** Someone the bot doesn't know. They get a request the owner can accept, and a short explanation. */
  private async stranger(link: ChannelLink, connector: Connector, message: IncomingMessage, text: string, workerName: string): Promise<void> {
    const { request, fresh } = this.ensureRequest(link, {
      kind: message.isGroup ? 'chat' : 'person',
      id: message.isGroup ? message.chatId : message.senderId,
      name: message.isGroup ? message.chatName : message.senderName,
      preview: text || message.unsupported || 'sent a file'
    })
    // On the user's own WhatsApp number the bot would be speaking as the user: stay quiet.
    const quiet = link.kind === 'whatsapp' && link.whatsappMode === 'personal'
    if (!quiet && this.once(`request|${link.id}|${request.id}`, 6 * HOUR)) {
      const owner = link.owner?.name ?? 'its owner'
      const body = !link.owner
        ? 'This bot isn’t set up yet. If it’s yours, send /pair and the code shown in Eaon → Settings → Chat apps.'
        : message.isGroup
          ? `${workerName} will answer here once ${owner} allows it. I’ve let them know.`
          : `Hi! ${workerName} only talks with people ${owner} lets in. I’ve let them know you’d like to.`
      await this.say(link, connector, message.chatId, body, message.isGroup ? message.messageId : undefined, workerName)
    }
    if (fresh && link.owner && link.forwardAlerts) {
      const who = message.isGroup ? `${message.senderName} in ${message.chatName}` : message.senderName
      await this.tellOwner(link, `${who} wants to talk to ${workerName} on ${CHANNEL_LABEL[link.kind]}: “${request.preview}”\nSend /allow ${request.code} to let ${message.isGroup ? 'everyone in that chat' : 'them'} in.`)
    }
  }

  private ensureRequest(link: ChannelLink, input: Omit<ChannelRequest, 'code' | 'at'>): { request: ChannelRequest; fresh: boolean } {
    const now = this.now()
    link.requests = link.requests.filter((r) => now - r.at < REQUEST_TTL)
    const existing = link.requests.find((r) => r.kind === input.kind && r.id === input.id)
    if (existing) return { request: existing, fresh: false }
    const request: ChannelRequest = { ...input, preview: input.preview.replace(/\s+/g, ' ').slice(0, 160), code: code(4), at: now }
    link.requests.push(request)
    if (link.requests.length > MAX_REQUESTS) link.requests.splice(0, link.requests.length - MAX_REQUESTS)
    this.commit()
    return { request, fresh: true }
  }

  /** Lets a request in. Returns it, or null when no request has that code. */
  private accept(link: ChannelLink, requestCode: string): ChannelRequest | null {
    const request = link.requests.find((r) => r.code === requestCode.trim().toUpperCase())
    if (!request) return null
    const now = this.now()
    if (request.kind === 'person') {
      if (!link.people.some((p) => p.id === request.id)) {
        if (link.people.length >= MAX_PEOPLE) throw new Error(`A connection can let in up to ${MAX_PEOPLE} people. Remove someone first.`)
        link.people.push({ id: request.id, name: request.name, level: 'chat', addedAt: now })
      }
    } else if (!link.chats.some((c) => c.id === request.id)) {
      if (link.chats.length >= MAX_CHATS) throw new Error(`A connection can answer in up to ${MAX_CHATS} chats. Remove one first.`)
      link.chats.push({ id: request.id, name: request.name, addedAt: now })
    }
    link.requests = link.requests.filter((r) => r !== request)
    this.commit()
    const connector = this.connectors.get(link.id)
    const worker = link.workerId ? this.deps.engine.lookup(link.workerId) : undefined
    const name = worker?.name ?? 'The worker'
    const quiet = link.kind === 'whatsapp' && link.whatsappMode === 'personal'
    if (connector && !quiet) {
      void (async () => {
        const chatId = request.kind === 'person' ? await connector.directChat(request.id) : request.id
        await this.say(
          link,
          connector,
          chatId,
          request.kind === 'person' ? `You’re in. Say hi to ${name}.` : `${name} will answer here now. Mention it or start a message with its name.`,
          undefined,
          worker?.name
        )
      })().catch((error) => console.error('[channels] could not send the welcome:', errorText(error)))
    }
    return request
  }

  private async command(
    link: ChannelLink,
    message: IncomingMessage,
    role: Role,
    command: { name: string; args: string },
    worker: Worker | null,
    reply: (body: string) => Promise<void>
  ): Promise<void> {
    const spec = CHANNEL_COMMANDS.find((c) => c.name === command.name)!
    const allowed = spec.who === 'anyone' || (spec.who === 'control' && role !== 'chat') || (spec.who === 'owner' && role === 'owner')
    if (!allowed) {
      await reply(`Only ${spec.who === 'owner' ? (link.owner?.name ?? 'the owner') : 'people with control'} can use /${spec.name}.`)
      return
    }
    const engine = this.deps.engine
    if (command.name === 'help') {
      const lines = CHANNEL_COMMANDS.filter((c) => c.name !== 'pair' && (c.who === 'anyone' || (c.who === 'control' && role !== 'chat') || role === 'owner')).map(
        (c) => `/${c.name}${c.args ? ` <${c.args}>` : ''} — ${c.description}`
      )
      const talk = worker ? `Talk to ${worker.name} by writing to it${message.isGroup ? ' (mention it, reply to it, or start with its name)' : ''}.` : ''
      await reply([talk, ...lines].filter(Boolean).join('\n'))
      return
    }
    if (command.name === 'allow') {
      try {
        const request = this.accept(link, command.args)
        await reply(request ? `Done: ${request.name} ${request.kind === 'person' ? 'can talk to it now' : 'is allowed now'}.` : 'No request has that code. /allow takes the 4-letter code from the request.')
      } catch (error) {
        await reply(errorText(error))
      }
      return
    }
    if (command.name === 'workers') {
      const now = this.now()
      const all = engine.list()
      await reply(all.length ? all.map((w) => `• ${w.name}${w.id === link.workerId ? ' (this bot)' : ''} — ${describeWorker(w, now)}`).join('\n') : 'You have no workers yet.')
      return
    }
    if (command.name === 'use') {
      const target = command.args ? engine.lookup(command.args) : undefined
      if (!target) {
        await reply(`No worker called “${command.args}”. /workers lists them.`)
        return
      }
      link.workerId = target.id
      this.commit()
      await reply(`This bot now speaks for ${target.name}.`)
      return
    }
    if (!worker) {
      await reply('This bot isn’t connected to a worker right now. /use <name> picks one.')
      return
    }
    try {
      switch (command.name) {
        case 'status': {
          const asks = role === 'owner' && worker.asks.length ? ` It has ${worker.asks.length} question${worker.asks.length === 1 ? '' : 's'} for you: /asks.` : ''
          await reply(`${worker.name}: ${describeWorker(worker, this.now())}.${asks}`)
          return
        }
        case 'stop':
          if (!engine.isRunning(worker.id)) await reply(`${worker.name} isn’t doing anything right now.`)
          else {
            engine.stopTurn(worker.id)
            await reply('Stopped.')
          }
          return
        case 'pause':
          engine.setPaused(worker.id, true)
          await reply(`${worker.name} is paused. Messages wait until someone sends /resume.`)
          return
        case 'resume':
          engine.setPaused(worker.id, false)
          await reply(`${worker.name} is back at work.`)
          return
        case 'wake':
          engine.wake(worker.id)
          await reply(`${worker.name} is checking in.`)
          return
        case 'asks': {
          if (!worker.asks.length) {
            await reply(`${worker.name} isn’t waiting on anything from you.`)
            return
          }
          await reply(
            worker.asks
              .map(
                (ask, i) =>
                  `${i + 1}. ${ask.question}${ask.approve ? ` (wants to: ${ask.approve.summary}; /approve ${approvalCode(ask)} or /decline ${approvalCode(ask)})` : ask.options.length ? ` [${ask.options.join(' / ')}]` : ''}`
              )
              .join('\n')
          )
          return
        }
        case 'answer': {
          const ask = worker.asks.find((a) => !a.approve) ?? worker.asks[0]
          if (!ask) {
            await reply(`${worker.name} isn’t waiting on anything from you.`)
            return
          }
          const pick = /^\d+$/.test(command.args) ? ask.options[Number(command.args) - 1] : undefined
          const text = pick ?? command.args
          if (!text) {
            await reply('Add your answer after /answer.')
            return
          }
          engine.answer(worker.id, ask.id, ask.approve ? { text, approved: false } : { text })
          await reply(`Sent to ${worker.name}.`)
          return
        }
        case 'approve':
        case 'decline': {
          const pending = worker.asks.filter((a) => a.approve)
          if (pending.length === 0) {
            await reply(`${worker.name} isn’t waiting for an approval.`)
            return
          }
          // Always by code: an approval is for the one call that was shown, and
          // a second may have arrived since (or the first was answered in the app).
          const [first = '', ...rest] = command.args.trim().split(/\s+/)
          const ask = pending.find((a) => approvalCode(a) === first.toLowerCase())
          if (!ask) {
            const list = pending.map((a) => `/${command.name} ${approvalCode(a)} — ${a.approve!.summary}`).join('\n')
            await reply(`${first ? `No waiting approval is called ${first} (it may have been answered already). ` : ''}${worker.name} is waiting for:\n${list}`)
            return
          }
          const note = rest.join(' ')
          engine.answer(worker.id, ask.id, { approved: command.name === 'approve', ...(note ? { text: note } : {}) })
          await reply(command.name === 'approve' ? `Approved: ${ask.approve!.summary}` : 'Declined.')
          return
        }
      }
    } catch (error) {
      await reply(errorText(error))
    }
  }

  /** Saves what came with a message into the worker's folder, under `from-<app>/`. */
  private async download(message: IncomingMessage, worker: Worker, kind: ChannelKind): Promise<{ saved: string[]; skipped: string[] }> {
    const saved: string[] = []
    const skipped: string[] = message.files.slice(MAX_FILES_PER_MESSAGE).map((f) => f.name)
    const dir = join(worker.folder, `from-${kind}`)
    for (const file of message.files.slice(0, MAX_FILES_PER_MESSAGE)) {
      if (file.size !== null && file.size > MAX_INCOMING_FILE_BYTES) {
        skipped.push(file.name)
        continue
      }
      try {
        const data = await file.download()
        if (data.length > MAX_INCOMING_FILE_BYTES) {
          skipped.push(file.name)
          continue
        }
        await mkdir(dir, { recursive: true })
        const path = freePath(dir, safeName(file.name))
        await writeFile(path, data)
        saved.push(path)
      } catch (error) {
        console.error(`[channels] could not save ${file.name}:`, errorText(error))
        skipped.push(file.name)
      }
    }
    return { saved, skipped }
  }

  /* ---------------------------------------------------- following the turns */

  private turnStarted(worker: Worker, mail: WorkerMail[]): void {
    const chats = new Set<string>()
    for (const item of mail) if (item.channel) chats.add(chatKey(item.channel.linkId, item.channel.chatId))
    this.turnChats.set(worker.id, chats)
    this.postedThisTurn.set(worker.id, new Set())
    for (const key of chats) this.startTyping(key)
  }

  private async turnEnded(worker: Worker, turn: { mail: WorkerMail[]; reply: ChatMessage; error?: string; cancelled: boolean }): Promise<void> {
    const posted = this.postedThisTurn.get(worker.id) ?? new Set<string>()
    this.turnChats.delete(worker.id)
    this.postedThisTurn.delete(worker.id)
    const chats = new Map<string, { linkId: string; chatId: string; isGroup: boolean; lastMessageId: string; owner: boolean }>()
    for (const item of turn.mail) {
      const channel = item.channel
      if (!channel) continue
      const key = chatKey(channel.linkId, channel.chatId)
      this.stopTyping(key)
      const entry = chats.get(key)
      chats.set(key, {
        linkId: channel.linkId,
        chatId: channel.chatId,
        isGroup: channel.isGroup,
        lastMessageId: channel.messageId,
        owner: (entry?.owner ?? false) || item.from === 'user'
      })
    }
    if (turn.cancelled || chats.size === 0) return
    const text = replyText(turn.reply)
    for (const [key, chat] of chats) {
      if (posted.has(key)) continue
      const link = this.find(chat.linkId)
      const connector = this.connectors.get(chat.linkId)
      if (!link || !connector) continue
      const body = turn.error ? (chat.owner ? `Something went wrong: ${turn.error}` : 'Sorry, something went wrong on my side.') : text
      if (!body) continue
      await this.say(link, connector, chat.chatId, body, chat.isGroup ? chat.lastMessageId : undefined, worker.name).catch((error) =>
        console.error(`[channels] could not post ${worker.name}’s reply:`, errorText(error))
      )
    }
  }

  private startTyping(key: string): void {
    if (this.typing.has(key)) return
    const [linkId, chatId] = key.split('|')
    const connector = this.connectors.get(linkId)
    if (!connector) return
    const beat = (): void => void connector.typing(chatId, true).catch(() => {})
    beat()
    const timer = setInterval(beat, connector.typingEveryMs)
    const stop = setTimeout(() => this.stopTyping(key), TYPING_LIMIT_MS)
    timer.unref?.()
    stop.unref?.()
    this.typing.set(key, { timer, stop })
  }

  private stopTyping(key: string): void {
    const entry = this.typing.get(key)
    if (!entry) return
    clearInterval(entry.timer)
    clearTimeout(entry.stop)
    this.typing.delete(key)
    const [linkId, chatId] = key.split('|')
    void this.connectors.get(linkId)?.typing(chatId, false).catch(() => {})
  }

  /** The worker's questions and news, to the owner of every link that speaks for it and forwards alerts. */
  private async tellOwners(workerId: string, text: string): Promise<void> {
    for (const link of this.links) {
      if (link.workerId === workerId && link.enabled && link.forwardAlerts) await this.tellOwner(link, text)
    }
  }

  private async tellOwner(link: ChannelLink, text: string): Promise<void> {
    const connector = this.connectors.get(link.id)
    if (!link.owner || !connector || this.statuses.get(link.id)?.state !== 'connected') return
    const worker = link.workerId ? this.deps.engine.lookup(link.workerId) : undefined
    try {
      await this.say(link, connector, await connector.directChat(link.owner.id), text, undefined, worker?.name)
    } catch (error) {
      console.error(`[channels] could not reach the owner on ${link.kind}:`, errorText(error))
    }
  }

  /**
   * Everything the bot says goes through here. On the user's own WhatsApp
   * number it is signed with the worker's name, since it arrives as the user.
   */
  private say(link: ChannelLink, connector: Connector, chatId: string, text: string, replyTo: string | undefined, workerName?: string): Promise<void> {
    const signed = link.kind === 'whatsapp' && link.whatsappMode === 'personal' ? `*${workerName ?? 'Eaon'}:* ${text}` : text
    return connector.send(chatId, signed, replyTo)
  }

  /** True the first time `key` is seen in `windowMs` — for notices that must not repeat. */
  private once(key: string, windowMs: number): boolean {
    const now = this.now()
    const last = this.notices.get(key)
    if (last !== undefined && now - last < windowMs) return false
    this.notices.set(key, now)
    return true
  }

  /* ------------------------------------------------------------------ misc */

  private find(id: string): ChannelLink | undefined {
    return this.links.find((l) => l.id === id)
  }

  private require(id: string): ChannelLink {
    const link = this.find(id)
    if (!link) throw new Error('That connection no longer exists.')
    return link
  }

  private commit(): void {
    this.deps.saveLinks(this.links)
    this.deps.onChange?.(clone(this.links))
  }
}
