import { DurableObject } from 'cloudflare:workers'
import { randomToken, same, sha256, type Env } from './auth'

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

type Who = { kind: 'device'; id: string } | { kind: 'web'; conn: string; login: string }

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
      return json({ ok: true })
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
      return json({ ok: true })
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
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    if (url.pathname === '/web' && request.headers.get('Upgrade') === 'websocket') {
      const conn = randomToken(9)
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1], ['web', `web:${conn}`])
      pair[1].serializeAttachment({ kind: 'web', conn, login: request.headers.get('X-RC-Login') ?? '' } satisfies Who)
      this.send(pair[1], { t: 'hello', conn, devices: await this.deviceList() })
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
      if (this.socketsOf(`device:${who.id}`).filter((s) => s !== ws).length === 0) this.toWeb({ t: 'presence', dev: who.id, online: false })
    } else if (who?.kind === 'web') {
      // The computers stop streaming to a tab that's gone.
      for (const device of this.socketsOf('device')) this.send(device, { t: 'gone', from: who.conn })
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws)
  }
}
