import { DurableObject } from 'cloudflare:workers'
import { randomToken, same, sha256, type Env } from './auth'
import { grantsFor, INVITE_MS, isLogin, MAX_SHARES, permits, publicShare, type Access, type Share } from './shares'

/**
 * One GitHub account: its linked computers, and the relay between them and
 * the account's open browser tabs.
 *
 * A computer connects out to `/relay/device` and keeps that socket open; a
 * browser tab connects to `/relay/web`. Messages are JSON. A tab's message
 * names the computer it is for (`dev`); the relay adds which tab sent it
 * (`from`) and passes it on. A computer's message names the tab it answers
 * (`to`, or "*" for every tab); the relay adds which computer sent it.
 * Nothing is stored but the device list: what passes through is not kept.
 *
 * WebSocket hibernation: the object sleeps between messages, sockets stay
 * open, and each socket remembers who it is in its attachment and tags.
 *
 * Sharing (shares.ts): the account also keeps what it shared with other
 * accounts, and what other accounts shared with it (`incoming`, so its tabs
 * know whose relays to join). Another account's tab joins this relay as a
 * guest (`/guest`): it hears only about the computers shared with it, and
 * each message it sends is checked against those shares before it reaches a
 * computer. Revoking closes its sockets and tells the computers to stop
 * streaming to them.
 */

export interface Device {
  id: string
  name: string
  platform: string
  /** SHA-256 of the device secret; the secret itself is only on the computer. */
  hash: string
  createdAt: number
  lastSeen: number
}

type Who = { kind: 'device'; id: string } | { kind: 'web'; conn: string; login: string } | { kind: 'guest'; conn: string; uid: string; login: string }

/** A share another account made with this one: whose relay to join. */
export interface Incoming {
  owner: string
  ownerLogin: string
  share: string
}

/** A single message bigger than this is refused (terminal output is chunked well below it). */
const MAX_MESSAGE = 1024 * 1024

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export class Account extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Keepalives answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private async devices(): Promise<Device[]> {
    return (await this.ctx.storage.get<Device[]>('devices')) ?? []
  }

  private async saveDevices(list: Device[]): Promise<void> {
    await this.ctx.storage.put('devices', list)
  }

  private async shares(): Promise<Share[]> {
    return (await this.ctx.storage.get<Share[]>('shares')) ?? []
  }

  private async saveShares(list: Share[]): Promise<void> {
    await this.ctx.storage.put('shares', list)
  }

  private async incoming(): Promise<Incoming[]> {
    return (await this.ctx.storage.get<Incoming[]>('incoming')) ?? []
  }

  /** The accounts that shared something with this one, once each: the relays its tabs join. */
  private async sharedWithMe(): Promise<{ owner: string; login: string }[]> {
    const seen = new Map<string, string>()
    for (const i of await this.incoming()) seen.set(i.owner, i.ownerLogin)
    return [...seen].map(([owner, login]) => ({ owner, login }))
  }

  /** A guest's view of this account's computers: only the ones shared with it, and what it may do on each. */
  private async guestDevices(uid: string): Promise<unknown[]> {
    const shares = await this.shares()
    const list = await this.deviceList()
    return list
      .map((d) => ({ d, grants: grantsFor(shares, uid, d.id) }))
      .filter((x) => x.grants.length)
      .map(({ d, grants }) => ({ ...d, owner: shares.find((s) => s.dev === d.id)?.ownerLogin ?? '', grants }))
  }

  private guests(): { ws: WebSocket; who: Extract<Who, { kind: 'guest' }> }[] {
    return this.socketsOf('guest').flatMap((ws) => {
      const who = ws.deserializeAttachment() as Who | null
      return who?.kind === 'guest' ? [{ ws, who }] : []
    })
  }

  /** A presence change to the guests who can see that computer. */
  private async toGuests(dev: string, message: unknown): Promise<void> {
    const shares = await this.shares()
    for (const { ws, who } of this.guests()) if (grantsFor(shares, who.uid, dev).length) this.send(ws, message)
  }

  /**
   * A guest account's tabs lose what they had: the computers stop streaming to
   * them, and their sockets close (they reconnect to whatever is still shared).
   */
  private dropGuest(uid: string): void {
    for (const { ws, who } of this.guests()) {
      if (who.uid !== uid) continue
      for (const device of this.socketsOf('device')) this.send(device, { t: 'gone', from: who.conn })
      try {
        ws.close(4003, 'revoked')
      } catch {
        /* already closing */
      }
    }
  }

  /** Takes a share away; returns the account it was with (to forget it there), or null when there was none. */
  private async revoke(id: string, dev?: string): Promise<{ found: boolean; uid: string | null }> {
    const list = await this.shares()
    const share = list.find((s) => s.id === id && (dev === undefined || s.dev === dev))
    if (!share) return { found: false, uid: null }
    await this.saveShares(list.filter((s) => s !== share))
    if (share.uid) this.dropGuest(share.uid)
    return { found: true, uid: share.uid }
  }

  /** An unlinked computer's shares: gone, and their guests disconnected. Returns who to tell. */
  private async dropDeviceShares(dev: string): Promise<{ uid: string; share: string }[]> {
    const list = await this.shares()
    const gone = list.filter((s) => s.dev === dev)
    if (!gone.length) return []
    await this.saveShares(list.filter((s) => s.dev !== dev))
    for (const uid of new Set(gone.flatMap((s) => (s.uid ? [s.uid] : [])))) this.dropGuest(uid)
    return gone.flatMap((s) => (s.uid ? [{ uid: s.uid, share: s.id }] : []))
  }

  /** A device verified by its own secret (for the computer listing and revoking its shares). */
  private async deviceBySecret(request: Request): Promise<Device | null> {
    const id = request.headers.get('X-RC-Device') ?? ''
    const device = (await this.devices()).find((d) => d.id === id)
    return device && same(device.hash, await sha256(request.headers.get('X-RC-Secret') ?? '')) ? device : null
  }

  private socketsOf(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag)
  }

  private online(id: string): boolean {
    return this.socketsOf(`device:${id}`).length > 0
  }

  private send(ws: WebSocket, message: unknown): void {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      /* closing */
    }
  }

  private toWeb(message: unknown): void {
    for (const ws of this.socketsOf('web')) this.send(ws, message)
  }

  private async deviceList(): Promise<{ id: string; name: string; platform: string; online: boolean; createdAt: number; lastSeen: number }[]> {
    return (await this.devices()).map(({ hash: _hash, ...d }) => ({ ...d, online: this.online(d.id) }))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/devices' && request.method === 'GET') return json({ devices: await this.deviceList() })

    if (url.pathname === '/devices/add' && request.method === 'POST') {
      const body = (await request.json()) as { name?: string; platform?: string }
      const list = await this.devices()
      if (list.length >= 20) return json({ error: 'This account already has 20 computers linked. Unlink one first.' }, 409)
      const id = randomToken(9)
      const secret = randomToken(32)
      list.push({ id, name: String(body.name ?? 'Computer').slice(0, 80), platform: String(body.platform ?? '').slice(0, 20), hash: await sha256(secret), createdAt: Date.now(), lastSeen: 0 })
      await this.saveDevices(list)
      return json({ id, secret })
    }

    if (url.pathname === '/devices/self-remove' && request.method === 'POST') {
      const id = request.headers.get('X-RC-Device') ?? ''
      const list = await this.devices()
      const device = list.find((d) => d.id === id)
      if (!device || !same(device.hash, await sha256(request.headers.get('X-RC-Secret') ?? ''))) return json({ error: 'Not linked.' }, 401)
      await this.saveDevices(list.filter((d) => d.id !== id))
      for (const ws of this.socketsOf(`device:${id}`)) ws.close(4001, 'unlinked')
      this.toWeb({ t: 'presence', dev: id, online: false, removed: true })
      return json({ ok: true, dropped: await this.dropDeviceShares(id) })
    }

    const renameMatch = /^\/devices\/([\w-]+)$/.exec(url.pathname)
    if (renameMatch && request.method === 'PATCH') {
      const body = (await request.json()) as { name?: string }
      const list = await this.devices()
      const device = list.find((d) => d.id === renameMatch[1])
      if (!device) return json({ error: 'No such computer.' }, 404)
      device.name = String(body.name ?? device.name).trim().slice(0, 80) || device.name
      await this.saveDevices(list)
      return json({ ok: true })
    }
    if (renameMatch && request.method === 'DELETE') {
      const id = renameMatch[1]
      await this.saveDevices((await this.devices()).filter((d) => d.id !== id))
      // Unlinked: its connection ends now, and its token never works again.
      for (const ws of this.socketsOf(`device:${id}`)) ws.close(4001, 'unlinked')
      this.toWeb({ t: 'presence', dev: id, online: false, removed: true })
      // Its shares go with it.
      return json({ ok: true, dropped: await this.dropDeviceShares(id) })
    }

    // ---- sharing, from the owner's tabs
    if (url.pathname === '/shares' && request.method === 'GET') return json({ shares: (await this.shares()).map(publicShare) })

    if (url.pathname === '/shares/add' && request.method === 'POST') {
      const body = (await request.json()) as { dev?: string; pane?: string | null; paneLabel?: string | null; access?: string; login?: string }
      const login = String(body.login ?? '').trim().replace(/^@/, '')
      if (!isLogin(login)) return json({ error: 'Type their GitHub username.' }, 400)
      const ownerLogin = request.headers.get('X-RC-Login') ?? ''
      if (login.toLowerCase() === ownerLogin.toLowerCase()) return json({ error: 'That’s you. Your own computers are already yours on every browser you sign in to.' }, 400)
      const dev = String(body.dev ?? '')
      if (!(await this.devices()).some((d) => d.id === dev)) return json({ error: 'No such computer.' }, 404)
      const pane = typeof body.pane === 'string' && /^[\w-]{1,80}$/.test(body.pane) ? body.pane : null
      const access: Access = body.access === 'control' ? 'control' : 'watch'
      const list = await this.shares()
      if (list.length >= MAX_SHARES) return json({ error: `You already have ${MAX_SHARES} shares. Revoke one first.` }, 409)
      const secret = randomToken(24)
      const share: Share = {
        id: randomToken(9),
        dev,
        pane,
        paneLabel: pane ? String(body.paneLabel ?? '').slice(0, 120) || null : null,
        access,
        login,
        uid: null,
        hash: await sha256(secret),
        ownerLogin,
        createdAt: Date.now(),
        acceptedAt: null
      }
      list.push(share)
      await this.saveShares(list)
      return json({ share: publicShare(share), secret })
    }

    const shareMatch = /^\/shares\/([\w-]+)$/.exec(url.pathname)
    if (shareMatch && request.method === 'DELETE') return json(await this.revoke(shareMatch[1]))

    // ---- an invite, opened by the account it's for
    if (url.pathname === '/shares/invite' && request.method === 'POST') {
      const body = (await request.json()) as { id?: string; secret?: string; accept?: boolean }
      const uid = request.headers.get('X-RC-Uid') ?? ''
      const login = request.headers.get('X-RC-Login') ?? ''
      const list = await this.shares()
      const share = list.find((s) => s.id === body.id)
      // Accepted already by this account: opening the link again just goes there.
      if (share && share.uid && share.uid === uid) return json({ ok: true, accepted: true, dev: share.dev, pane: share.pane, ownerLogin: share.ownerLogin })
      if (!share || !share.hash || !same(share.hash, await sha256(String(body.secret ?? '')))) return json({ error: 'This invite isn’t valid any more. It may have been used or revoked; ask for a new one.' }, 404)
      if (Date.now() - share.createdAt > INVITE_MS) return json({ error: 'This invite expired. Ask for a new one.' }, 410)
      const device = (await this.devices()).find((d) => d.id === share.dev)
      const info = {
        ownerLogin: share.ownerLogin,
        forLogin: share.login,
        device: device?.name ?? 'A computer',
        pane: share.pane,
        paneLabel: share.paneLabel,
        access: share.access
      }
      if (share.login.toLowerCase() !== login.toLowerCase()) return json({ ...info, error: `This invite is for @${share.login}. You’re signed in as @${login}.` }, 403)
      if (!body.accept) return json(info)
      share.uid = uid
      share.hash = null
      share.acceptedAt = Date.now()
      await this.saveShares(list)
      return json({ ok: true, accepted: true, dev: share.dev, pane: share.pane, ownerLogin: share.ownerLogin })
    }

    // ---- what other accounts shared with this one
    if (url.pathname === '/incoming' && request.method === 'GET') return json({ owners: await this.sharedWithMe() })
    if (url.pathname === '/incoming/add' && request.method === 'POST') {
      const body = (await request.json()) as Incoming
      const list = (await this.incoming()).filter((i) => !(i.owner === body.owner && i.share === body.share))
      list.push({ owner: String(body.owner), ownerLogin: String(body.ownerLogin ?? ''), share: String(body.share) })
      await this.ctx.storage.put('incoming', list)
      return json({ ok: true })
    }
    if (url.pathname === '/incoming/remove' && request.method === 'POST') {
      const body = (await request.json()) as { owner?: string; share?: string }
      await this.ctx.storage.put('incoming', (await this.incoming()).filter((i) => !(i.owner === body.owner && (body.share === undefined || i.share === body.share))))
      return json({ ok: true })
    }

    // ---- the computer itself: who it's shared with, and taking it back (Settings → Remote devices)
    if (url.pathname === '/devices/self-shares' && request.method === 'GET') {
      const device = await this.deviceBySecret(request)
      if (!device) return json({ error: 'Not linked.' }, 401)
      return json({ shares: (await this.shares()).filter((s) => s.dev === device.id).map(publicShare) })
    }
    const selfRevoke = /^\/devices\/self-shares\/([\w-]+)$/.exec(url.pathname)
    if (selfRevoke && request.method === 'DELETE') {
      const device = await this.deviceBySecret(request)
      if (!device) return json({ error: 'Not linked.' }, 401)
      return json(await this.revoke(selfRevoke[1], device.id))
    }

    if (url.pathname === '/device' && request.headers.get('Upgrade') === 'websocket') {
      const id = request.headers.get('X-RC-Device') ?? ''
      const secret = request.headers.get('X-RC-Secret') ?? ''
      const list = await this.devices()
      const device = list.find((d) => d.id === id)
      if (!device || !same(device.hash, await sha256(secret))) return new Response('This computer isn’t linked to the account any more.', { status: 401 })
      // One connection per computer: a reconnect replaces the old one.
      for (const old of this.socketsOf(`device:${id}`)) old.close(4000, 'replaced')
      device.lastSeen = Date.now()
      const sent = request.headers.get('X-RC-Name')
      if (sent) {
        try {
          device.name = decodeURIComponent(sent).trim().slice(0, 80) || device.name
        } catch {
          /* keep the name it has */
        }
      }
      await this.saveDevices(list)
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1], ['device', `device:${id}`])
      pair[1].serializeAttachment({ kind: 'device', id } satisfies Who)
      this.toWeb({ t: 'presence', dev: id, online: true, name: device.name })
      await this.toGuests(id, { t: 'presence', dev: id, online: true, name: device.name })
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    if (url.pathname === '/web' && request.headers.get('Upgrade') === 'websocket') {
      const conn = randomToken(9)
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1], ['web', `web:${conn}`])
      pair[1].serializeAttachment({ kind: 'web', conn, login: request.headers.get('X-RC-Login') ?? '' } satisfies Who)
      this.send(pair[1], { t: 'hello', conn, devices: await this.deviceList(), shared: await this.sharedWithMe() })
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    if (url.pathname === '/guest' && request.headers.get('Upgrade') === 'websocket') {
      const uid = request.headers.get('X-RC-Uid') ?? ''
      const devices = await this.guestDevices(uid)
      if (!uid || !devices.length) return new Response('Nothing is shared with you here any more.', { status: 403 })
      const conn = randomToken(9)
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1], ['guest', `guest:${uid}`, `web:${conn}`])
      pair[1].serializeAttachment({ kind: 'guest', conn, uid, login: request.headers.get('X-RC-Login') ?? '' } satisfies Who)
      this.send(pair[1], { t: 'hello', conn, devices })
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    return json({ error: 'not found' }, 404)
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    if (text.length > MAX_MESSAGE) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    const who = ws.deserializeAttachment() as Who | null
    if (!who) return

    if (who.kind === 'guest') {
      const dev = String(message.dev ?? '')
      if (!permits(grantsFor(await this.shares(), who.uid, dev), message)) {
        if (message.t === 'req') this.send(ws, { t: 'res', id: message.id, dev, status: 403, body: { error: { code: 'forbidden', message: 'That wasn’t shared with you.' } } })
        return
      }
      const target = this.socketsOf(`device:${dev}`)[0]
      if (!target) {
        if (message.t === 'req') this.send(ws, { t: 'res', id: message.id, dev, status: 503, body: { error: { code: 'offline', message: 'That computer is offline.' } } })
        return
      }
      // The computer hears who it is, so it can say so.
      this.send(target, { ...message, dev: undefined, from: who.conn, guest: who.login })
      return
    }

    if (who.kind === 'web') {
      const dev = String(message.dev ?? '')
      const target = this.socketsOf(`device:${dev}`)[0]
      if (!target) {
        if (message.t === 'req') this.send(ws, { t: 'res', id: message.id, dev, status: 503, body: { error: { code: 'offline', message: 'That computer is offline. Open Eaon on it, or check its internet.' } } })
        return
      }
      this.send(target, { ...message, dev: undefined, from: who.conn })
      return
    }

    // From a computer: to one tab, or every tab.
    const to = String(message.to ?? '')
    const out = { ...message, to: undefined, dev: who.id }
    if (to === '*') this.toWeb(out)
    else for (const tab of this.socketsOf(`web:${to}`)) this.send(tab, out)
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const who = ws.deserializeAttachment() as Who | null
    if (who?.kind === 'device') {
      // A replaced connection isn't the computer going offline.
      if (this.socketsOf(`device:${who.id}`).filter((s) => s !== ws).length === 0) {
        this.toWeb({ t: 'presence', dev: who.id, online: false })
        await this.toGuests(who.id, { t: 'presence', dev: who.id, online: false })
      }
    } else if (who?.kind === 'web' || who?.kind === 'guest') {
      // The computers stop streaming to a tab that's gone.
      for (const device of this.socketsOf('device')) this.send(device, { t: 'gone', from: who.conn })
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws)
  }
}
