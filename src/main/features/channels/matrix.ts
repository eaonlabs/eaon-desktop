import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { MAX_MESSAGE_CHARS, type MatrixCredentials } from '@shared/channels'
import { chunkText, plainText, toMatrixHtml } from './format'
import type { Connector, ConnectorEvents, IncomingFile } from './types'

/**
 * Matrix (Element, and every other Matrix app) through the client-server
 * API: long-polling `/sync`, so no public address is needed. The worker is
 * an ordinary Matrix account, signed in once with its password, which Eaon
 * trades for an access token and forgets. It joins rooms it is invited to;
 * who may talk to it there is the channels service's business.
 *
 * End-to-end encrypted rooms can't be read without a crypto library, so a
 * message there arrives as one the worker can't open, and Settings says to
 * use rooms without encryption.
 */

/** What the vault keeps for a Matrix connection once it signed in. */
interface MatrixSession {
  server: string
  token: string
  userId: string
}

interface MatrixEvent {
  type: string
  event_id: string
  sender: string
  origin_server_ts?: number
  content: {
    msgtype?: string
    body?: string
    url?: string
    info?: { size?: number; mimetype?: string }
    membership?: string
    is_direct?: boolean
    'm.mentions'?: { user_ids?: string[] }
    'm.relates_to'?: { rel_type?: string; 'm.in_reply_to'?: { event_id?: string } }
  }
}

interface SyncResponse {
  next_batch: string
  rooms?: {
    join?: Record<string, { summary?: { 'm.joined_member_count'?: number }; timeline?: { events?: MatrixEvent[] } }>
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>
  }
}

export class MatrixError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errcode?: string,
    readonly retryAfterMs?: number
  ) {
    super(message)
  }
}

const POLL_MS = 30_000
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
/** Only what is said in rooms, and the invites to them: no presence, receipts or typing. */
const FILTER = JSON.stringify({
  presence: { not_types: ['*'] },
  account_data: { not_types: ['*'] },
  room: {
    timeline: { limit: 50, types: ['m.room.message', 'm.room.encrypted'] },
    state: { lazy_load_members: true, types: ['m.room.member'] },
    ephemeral: { not_types: ['*'] },
    account_data: { not_types: ['*'] }
  }
})

/** `matrix.org` → its client API's base URL, through .well-known when the server publishes one. */
export async function matrixBaseUrl(server: string, signal?: AbortSignal): Promise<string> {
  const trimmed = server.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('Enter the homeserver, like matrix.org.')
  const base = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const response = await fetch(`${base}/.well-known/matrix/client`, { signal })
    if (response.ok) {
      const known = (await response.json()) as { 'm.homeserver'?: { base_url?: string } }
      const url = known['m.homeserver']?.base_url
      if (url && /^https?:\/\//i.test(url)) return url.replace(/\/+$/, '')
    }
  } catch {
    /* no .well-known: the address is the server itself */
  }
  return base
}

async function request<T>(server: string, token: string | null, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${server}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal
  })
  const data = (await response.json().catch(() => null)) as (T & { errcode?: string; error?: string; retry_after_ms?: number }) | null
  if (!response.ok) {
    throw new MatrixError(data?.error ?? `The homeserver answered ${response.status}`, response.status, data?.errcode, data?.retry_after_ms)
  }
  return data as T
}

/**
 * Signs in with the credentials Settings sends (a password, or an access
 * token) and names the account. `token` is the session to keep in the vault.
 */
export async function verifyMatrixCredentials(raw: string): Promise<{ account: string; id: string; token: string }> {
  let input: MatrixCredentials & Partial<MatrixSession>
  try {
    input = JSON.parse(raw) as MatrixCredentials & Partial<MatrixSession>
  } catch {
    throw new Error('Enter the homeserver and the account’s user name and password.')
  }
  const signal = AbortSignal.timeout(20_000)
  let server: string
  try {
    server = await matrixBaseUrl(String(input.server ?? ''), signal)
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
  try {
    if (input.password) {
      const user = String(input.user ?? '').trim()
      if (!user) throw new Error('Enter the account’s user name.')
      const login = await request<{ access_token: string; user_id: string }>(server, null, 'POST', '/_matrix/client/v3/login', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: input.password,
        initial_device_display_name: 'Eaon'
      }, signal)
      return { account: login.user_id, id: login.user_id, token: JSON.stringify({ server, token: login.access_token, userId: login.user_id } satisfies MatrixSession) }
    }
    const token = String(input.token ?? '').trim()
    if (!token) throw new Error('Enter the account’s password (or an access token).')
    const me = await request<{ user_id: string }>(server, token, 'GET', '/_matrix/client/v3/account/whoami', undefined, signal)
    return { account: me.user_id, id: me.user_id, token: JSON.stringify({ server, token, userId: me.user_id } satisfies MatrixSession) }
  } catch (error) {
    if (error instanceof MatrixError && (error.errcode === 'M_FORBIDDEN' || error.errcode === 'M_UNKNOWN_TOKEN' || error.status === 401 || error.status === 403)) {
      throw new Error(input.password ? 'The homeserver didn’t accept that user name and password.' : 'The homeserver didn’t accept that access token.')
    }
    if (error instanceof MatrixError) throw new Error(`The homeserver said: ${error.message}`)
    if (error instanceof Error && !/fetch failed|ENOTFOUND|ECONNREFUSED|timeout/i.test(error.message)) throw error
    throw new Error(`Couldn’t reach ${server}. Check the homeserver’s address.`)
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })

const enc = encodeURIComponent

export class MatrixConnector implements Connector {
  readonly kind = 'matrix' as const
  readonly typingEveryMs = 20_000
  private readonly session: MatrixSession | null
  private readonly abort = new AbortController()
  private running: Promise<void> | null = null
  /** Joined members, by room, and when that was learned: people come and go. */
  private readonly members = new Map<string, { count: number; at: number }>()
  private readonly roomNames = new Map<string, string | null>()
  /** Rooms made as a direct chat (the invite said so, or this account made it). */
  private readonly directRooms = new Set<string>()
  private readonly names = new Map<string, string>()
  /** A direct room with each person, once there is one. */
  private readonly direct = new Map<string, string>()
  /** What this account sent, so a reply to it counts as calling the worker. */
  private readonly sent = new Set<string>()

  constructor(
    raw: string,
    private readonly events: ConnectorEvents
  ) {
    let session: MatrixSession | null = null
    try {
      const parsed = JSON.parse(raw) as Partial<MatrixSession>
      if (parsed.server && parsed.token && parsed.userId) session = { server: parsed.server, token: parsed.token, userId: parsed.userId }
    } catch {
      session = null
    }
    this.session = session
  }

  /** A call, waited out and tried again (twice at most) when the homeserver says to slow down. */
  private async call<T>(method: string, path: string, body?: unknown, signal: AbortSignal = this.abort.signal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request<T>(this.session!.server, this.session!.token, method, path, body, signal)
      } catch (error) {
        if (!(error instanceof MatrixError) || error.errcode !== 'M_LIMIT_EXCEEDED' || attempt >= 2 || signal.aborted) throw error
        await sleep(Math.min(error.retryAfterMs ?? 2000, 30_000), signal)
      }
    }
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
    const session = this.session
    if (!session) {
      this.events.status({ state: 'error', message: 'This connection’s Matrix sign-in is missing. Sign in again.', needsToken: true })
      return
    }
    let since: string | null = null
    let failures = 0
    let connected = false
    this.events.status({ state: 'connecting' })
    while (!signal.aborted) {
      try {
        if (since === null) {
          await this.call('GET', '/_matrix/client/v3/account/whoami')
          this.events.account({ account: session.userId, selfId: session.userId })
          // Start from now: what was said before Eaon connected isn't answered.
          const first = await this.call<SyncResponse>('GET', `/_matrix/client/v3/sync?filter=${enc(JSON.stringify({ room: { timeline: { limit: 0 } } }))}`)
          await this.joinInvites(first)
          since = first.next_batch
          // Connected now: the long poll below can sit quiet for half a minute.
          this.events.status({ state: 'connected' })
          connected = true
        }
        const sync: SyncResponse = await this.call<SyncResponse>(
          'GET',
          `/_matrix/client/v3/sync?since=${enc(since)}&timeout=${POLL_MS}&filter=${enc(FILTER)}`,
          undefined,
          AbortSignal.any([signal, AbortSignal.timeout(POLL_MS + 30_000)])
        )
        if (!connected) this.events.status({ state: 'connected' })
        connected = true
        failures = 0
        since = sync.next_batch
        await this.joinInvites(sync)
        for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
          const count = room.summary?.['m.joined_member_count']
          if (typeof count === 'number') this.members.set(roomId, { count, at: Date.now() })
          for (const event of room.timeline?.events ?? []) await this.handle(roomId, event).catch((error) => console.error('[matrix] could not read a message:', error))
        }
      } catch (error) {
        if (signal.aborted) break
        connected = false
        failures += 1
        if (error instanceof MatrixError && (error.errcode === 'M_UNKNOWN_TOKEN' || error.status === 401)) {
          this.events.status({ state: 'error', message: 'The homeserver signed this account out. Sign in again.', needsToken: true })
          return
        }
        const wait = error instanceof MatrixError && error.retryAfterMs ? error.retryAfterMs : Math.min(2 ** failures * 1000, 60_000)
        this.events.status({ state: 'connecting', message: `Reconnecting — ${error instanceof Error ? error.message : String(error)}` })
        await sleep(wait, signal)
      }
    }
    this.events.status({ state: 'off' })
  }

  /** Joins the rooms it was invited to. Who may talk to it there is decided per message. */
  private async joinInvites(sync: SyncResponse): Promise<void> {
    for (const [roomId, room] of Object.entries(sync.rooms?.invite ?? {})) {
      const invite = room.invite_state?.events?.find((e) => e.type === 'm.room.member' && e.content.membership === 'invite')
      try {
        await this.call('POST', `/_matrix/client/v3/join/${enc(roomId)}`, {})
        if (invite?.content.is_direct) {
          this.directRooms.add(roomId)
          this.direct.set(invite.sender, roomId)
        }
      } catch (error) {
        console.error('[matrix] could not join a room it was invited to:', error instanceof Error ? error.message : error)
      }
    }
  }

  private async memberCount(roomId: string): Promise<number> {
    const known = this.members.get(roomId)
    if (known && Date.now() - known.at < 60_000) return known.count
    const count = await this.call<{ joined: Record<string, unknown> }>('GET', `/_matrix/client/v3/rooms/${enc(roomId)}/joined_members`)
      .then((r) => Object.keys(r.joined).length)
      .catch(() => known?.count ?? 3)
    this.members.set(roomId, { count, at: Date.now() })
    return count
  }

  /** The room's name or address; null for one that has neither (as direct chats usually don't). */
  private async roomName(roomId: string): Promise<string | null> {
    if (this.roomNames.has(roomId)) return this.roomNames.get(roomId)!
    const name = await this.call<{ name?: string }>('GET', `/_matrix/client/v3/rooms/${enc(roomId)}/state/m.room.name`)
      .then((r) => r.name || null)
      .catch(() => null)
    const alias = name
      ? null
      : await this.call<{ alias?: string }>('GET', `/_matrix/client/v3/rooms/${enc(roomId)}/state/m.room.canonical_alias`)
          .then((r) => r.alias || null)
          .catch(() => null)
    const result = name ?? alias
    this.roomNames.set(roomId, result)
    return result
  }

  private async displayName(userId: string): Promise<string> {
    const known = this.names.get(userId)
    if (known) return known
    const name = await this.call<{ displayname?: string }>('GET', `/_matrix/client/v3/profile/${enc(userId)}/displayname`)
      .then((r) => (r.displayname ? `${r.displayname} (${userId})` : userId))
      .catch(() => userId)
    this.names.set(userId, name)
    return name
  }

  private async handle(roomId: string, event: MatrixEvent): Promise<void> {
    const me = this.session!.userId
    if (event.sender === me) return
    if (event.type === 'm.room.encrypted') {
      this.events.message({
        ...(await this.where(roomId, event)),
        messageId: event.event_id,
        text: '',
        mentioned: false,
        files: [],
        unsupported: 'an end-to-end encrypted message (Eaon can only read Matrix rooms without encryption)'
      })
      return
    }
    if (event.type !== 'm.room.message') return
    const content = event.content
    const relates = content['m.relates_to']
    // An edit of an earlier message, or another bot's notice: nothing to answer.
    if (relates?.rel_type === 'm.replace' || content.msgtype === 'm.notice') return
    const replyTo = relates?.['m.in_reply_to']?.event_id
    let body = String(content.body ?? '')
    // Older apps quote the message replied to at the top ("> <@ana:x> …"); the reply is what follows.
    if (replyTo) body = body.replace(/^(>.*\n)+\n?/, '')
    const localpart = me.slice(1).split(':')[0]
    const mentioned =
      Boolean(content['m.mentions']?.user_ids?.includes(me)) || body.includes(me) || (replyTo !== undefined && this.sent.has(replyTo)) || new RegExp(`(^|\\W)@${localpart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body)
    const text = body
      .replace(new RegExp(me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')
      .replace(/^\s*[:,]\s*/, '')
      .trim()

    const files: IncomingFile[] = []
    if (content.url && ['m.image', 'm.file', 'm.video', 'm.audio'].includes(content.msgtype ?? '')) {
      const url = content.url
      files.push({ name: body || `file-${event.event_id.slice(1, 9)}`, size: content.info?.size ?? null, download: () => this.download(url) })
    }

    this.events.message({
      ...(await this.where(roomId, event)),
      messageId: event.event_id,
      text: files.length ? '' : content.msgtype === 'm.emote' ? `* ${text}` : text,
      mentioned,
      files
    })
  }

  /** The room and the sender, as the service wants them. */
  private async where(roomId: string, event: MatrixEvent): Promise<{ chatId: string; chatName: string; isGroup: boolean; senderId: string; senderName: string }> {
    // Made as a direct chat; or, when that isn't known (rooms joined before Eaon started), two people and no name.
    const name = await this.roomName(roomId)
    const isGroup = !this.directRooms.has(roomId) && (name !== null || (await this.memberCount(roomId)) > 2)
    if (!isGroup && !this.direct.has(event.sender)) this.direct.set(event.sender, roomId)
    return {
      chatId: roomId,
      chatName: isGroup ? (name ?? 'a room') : 'Direct message',
      isGroup,
      senderId: event.sender,
      senderName: await this.displayName(event.sender)
    }
  }

  private async download(mxc: string): Promise<Buffer> {
    const match = /^mxc:\/\/([^/]+)\/([^/?#]+)/.exec(mxc)
    if (!match) throw new Error('That file isn’t on a Matrix server.')
    const [, host, id] = match
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(120_000)])
    const headers = { authorization: `Bearer ${this.session!.token}` }
    // Authenticated media (Matrix 1.11) first; older servers only have the open endpoint.
    let response = await fetch(`${this.session!.server}/_matrix/client/v1/media/download/${enc(host)}/${enc(id)}`, { headers, signal })
    if (response.status === 404 || response.status === 400) response = await fetch(`${this.session!.server}/_matrix/media/v3/download/${enc(host)}/${enc(id)}`, { headers, signal })
    if (!response.ok) throw new Error(`The homeserver answered ${response.status} for the file`)
    return Buffer.from(await response.arrayBuffer())
  }

  private async post(roomId: string, content: Record<string, unknown>): Promise<void> {
    // The same transaction id on a retry, so a message the server took isn't sent twice.
    const { event_id } = await this.call<{ event_id: string }>('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/send/m.room.message/${randomUUID()}`, content)
    this.sent.add(event_id)
    if (this.sent.size > 500) this.sent.delete(this.sent.values().next().value as string)
  }

  async send(chatId: string, markdown: string, replyTo?: string): Promise<void> {
    for (const [index, piece] of chunkText(markdown, MAX_MESSAGE_CHARS.matrix).entries()) {
      await this.post(chatId, {
        msgtype: 'm.text',
        body: plainText(piece),
        format: 'org.matrix.custom.html',
        formatted_body: toMatrixHtml(piece),
        ...(replyTo && index === 0 ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } } } : {})
      })
    }
  }

  async sendFile(chatId: string, path: string, caption?: string): Promise<void> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${path} is not a file.`)
    if (info.size > MAX_UPLOAD_BYTES) throw new Error('Files sent to Matrix can be up to 50 MB here.')
    const name = basename(path)
    const image = IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
    const response = await fetch(`${this.session!.server}/_matrix/media/v3/upload?filename=${enc(name)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.session!.token}`, 'content-type': 'application/octet-stream' },
      body: await readFile(path),
      signal: this.abort.signal
    })
    const data = (await response.json().catch(() => null)) as { content_uri?: string; error?: string } | null
    if (!response.ok || !data?.content_uri) throw new Error(`The homeserver refused the file: ${data?.error ?? response.status}`)
    await this.post(chatId, { msgtype: image ? 'm.image' : 'm.file', body: name, url: data.content_uri, info: { size: info.size } })
    if (caption) await this.send(chatId, caption)
  }

  async typing(chatId: string, on: boolean): Promise<void> {
    await this.call('PUT', `/_matrix/client/v3/rooms/${enc(chatId)}/typing/${enc(this.session!.userId)}`, on ? { typing: true, timeout: 30_000 } : { typing: false })
  }

  async directChat(userId: string): Promise<string> {
    const known = this.direct.get(userId)
    if (known) return known
    // No room with them yet: one just for the two, without encryption so it can be read.
    const { room_id } = await this.call<{ room_id: string }>('POST', '/_matrix/client/v3/createRoom', { is_direct: true, invite: [userId], preset: 'trusted_private_chat' })
    this.direct.set(userId, room_id)
    this.directRooms.add(room_id)
    return room_id
  }
}
