import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  artUrl,
  DISCORD_BUTTON_LABEL,
  DISCORD_DOWNLOAD_URL,
  type DiscordConnection,
  type DiscordSnapshot
} from '@shared/discordPresence'
import { DiscordRpc, DiscordUnavailable, type Activity } from '../src/main/features/discord/rpc'
import { discordPresenceFeature } from '../src/main/features/discordPresence'
import type { FeatureContext } from '../src/main/features/types'

/**
 * Discord Rich Presence end to end, minus Discord: a fake Discord listens on
 * a real `discord-ipc-0` socket in a temp folder and speaks the same framed
 * protocol — handshake, READY, SET_ACTIVITY replies, and the close Discord
 * sends for an unknown application id.
 */

interface SetActivity {
  pid: number
  activity?: Activity
}

class FakeDiscord {
  server: Server
  sockets = new Set<Socket>()
  handshakes: string[] = []
  activities: SetActivity[] = []
  /** Answer an activity carrying the clickable-image field with an error, like an older Discord. */
  rejectImageLink = false

  constructor(readonly path: string) {
    this.server = createServer((socket) => this.accept(socket))
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.path, resolve))
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 8) {
        const op = buffer.readInt32LE(0)
        const length = buffer.readInt32LE(4)
        if (buffer.length < 8 + length) return
        const message = JSON.parse(buffer.subarray(8, 8 + length).toString('utf8'))
        buffer = buffer.subarray(8 + length)
        this.handle(socket, op, message)
      }
    })
  }

  private handle(socket: Socket, op: number, message: Record<string, unknown>): void {
    if (op === 0) {
      this.handshakes.push(String(message.client_id))
      if (message.client_id === 'unknown-app') {
        send(socket, 2, { code: 4000, message: 'Invalid Client ID' })
        socket.end()
        return
      }
      send(socket, 1, {
        cmd: 'DISPATCH',
        evt: 'READY',
        data: { v: 1, user: { id: '42', username: 'sanscreates', global_name: 'Sans' } }
      })
      return
    }
    if (op !== 1 || message.cmd !== 'SET_ACTIVITY') return
    const args = message.args as SetActivity
    if (this.rejectImageLink && args.activity?.assets?.large_url) {
      send(socket, 1, { cmd: 'SET_ACTIVITY', evt: 'ERROR', nonce: message.nonce, data: { code: 4000, message: '"large_url" is not allowed' } })
      return
    }
    this.activities.push(args)
    send(socket, 1, { cmd: 'SET_ACTIVITY', evt: null, nonce: message.nonce, data: args.activity ?? null })
  }
}

function send(socket: Socket, op: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload))
  const header = Buffer.alloc(8)
  header.writeInt32LE(op, 0)
  header.writeInt32LE(body.length, 4)
  socket.write(Buffer.concat([header, body]))
}

async function waitFor(check: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const dir = mkdtempSync(join(tmpdir(), 'eaon-discord-'))
const saved = { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
let discord: FakeDiscord

before(async () => {
  // Point every place the client looks at the temp folder, so a real Discord
  // running on this machine is never touched.
  for (const key of Object.keys(saved)) process.env[key] = dir
  discord = new FakeDiscord(join(dir, 'discord-ipc-0'))
  await discord.listen()
})

after(async () => {
  discordPresenceFeature.dispose?.()
  await discord.close()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('Discord RPC client', () => {
  it('handshakes, learns the user and sets an activity', async () => {
    const rpc = await DiscordRpc.connect('test-app')
    assert.equal(rpc.user?.username, 'sanscreates')
    await rpc.setActivity({ details: 'Testing', buttons: [{ label: 'Go', url: 'https://eaon.dev' }] })
    const last = discord.activities.at(-1)
    assert.equal(last?.pid, process.pid)
    assert.equal(last?.activity?.details, 'Testing')
    await rpc.setActivity(null)
    assert.equal(discord.activities.at(-1)?.activity, undefined, 'clearing sends no activity at all')
    rpc.close()
  })

  it("reports Discord's reason when it refuses the application", async () => {
    await assert.rejects(DiscordRpc.connect('unknown-app'), /Invalid Client ID/)
  })

  it('says Discord is unavailable when nothing is listening', async () => {
    const saved = process.env.TMPDIR
    const empty = mkdtempSync(join(dir, 'empty-'))
    for (const key of ['XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP']) process.env[key] = empty
    try {
      await assert.rejects(DiscordRpc.connect('test-app'), (error) => error instanceof DiscordUnavailable)
    } finally {
      for (const key of ['XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP']) process.env[key] = saved
    }
  })
})

describe('Discord presence feature', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const statuses: DiscordConnection[] = []
  const sender = new EventEmitter()
  const ctx: FeatureContext = {
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
      on: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
    } as never,
    getWindow: () => null,
    send: (channel, status) => {
      if (channel === 'discord:status') statuses.push(status as DiscordConnection)
    },
    emitStream: () => undefined
  }
  const sync = (snapshot: DiscordSnapshot | null): unknown => handlers.get('discord:sync')!({ sender }, snapshot)
  const snapshot: DiscordSnapshot = { status: 'thinking', place: 'chat', showStatus: true, showElapsed: true, showButton: true }

  before(() => discordPresenceFeature.register(ctx))

  it('shows the card with the animated art and the download button', async () => {
    const before = discord.activities.length
    const startedAround = Date.now()
    sync(snapshot)
    await waitFor(() => discord.activities.length > before, 3000, 'an activity')
    const status = statuses.at(-1)
    assert.equal(status?.state, 'connected')
    assert.equal(status?.state === 'connected' && status.user, 'Sans', 'the display name, not the handle')

    const { activity } = discord.activities.at(-1)!
    assert.ok(activity)
    assert.equal(activity.details, 'Thinking through a reply')
    assert.equal(activity.state, 'In a chat')
    assert.equal(activity.assets?.large_image, artUrl('presence'))
    assert.equal(activity.assets?.small_image, artUrl('thinking'))
    assert.equal(activity.assets?.large_url, DISCORD_DOWNLOAD_URL)
    assert.deepEqual(activity.buttons, [{ label: DISCORD_BUTTON_LABEL, url: DISCORD_DOWNLOAD_URL }])
    assert.ok(activity.timestamps?.start && activity.timestamps.start >= startedAround - 5, 'elapsed time counts from now')
    assert.ok(DISCORD_BUTTON_LABEL.length <= 32, 'Discord caps button labels at 32 characters')
  })

  it('holds back a change until the rate limit allows, then sends only the latest', async () => {
    const before = discord.activities.length
    sync({ ...snapshot, status: 'working' })
    sync({ ...snapshot, status: 'ready' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(discord.activities.length, before, 'nothing sent inside the 4 s window')
    await waitFor(() => discord.activities.length > before, 6000, 'the held update')
    assert.equal(discord.activities.at(-1)?.activity?.details, 'Ready for the next prompt')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(discord.activities.length, before + 1, 'the intermediate status was coalesced away')
  })

  it('leaves out the status, timer and button when they are turned off', async () => {
    sync(null)
    await waitFor(() => statuses.at(-1)?.state === 'off', 1000, 'off')
    const before = discord.activities.length
    sync({ ...snapshot, showStatus: false, showElapsed: false, showButton: false })
    await waitFor(() => discord.activities.length > before, 3000, 'an activity')
    const { activity } = discord.activities.at(-1)!
    assert.equal(activity?.details, undefined)
    assert.equal(activity?.state, undefined)
    assert.equal(activity?.timestamps, undefined)
    assert.equal(activity?.buttons, undefined)
    assert.equal(activity?.assets?.small_image, undefined)
    assert.equal(activity?.assets?.large_image, artUrl('presence'), 'the animated art always shows')
  })

  it('clears the presence and disconnects when the window closes', async () => {
    const before = discord.activities.length
    sender.emit('destroyed')
    await waitFor(() => discord.activities.length > before, 2000, 'the clear')
    assert.equal(discord.activities.at(-1)?.activity, undefined)
    assert.equal(statuses.at(-1)?.state, 'off')
    await waitFor(() => discord.sockets.size === 0, 2000, 'the socket to close')
  })

  it('drops the clickable-image field for a Discord that rejects it', async () => {
    discord.rejectImageLink = true
    const before = discord.activities.length
    sync(snapshot)
    await waitFor(() => discord.activities.length > before, 7000, 'the retried activity')
    const { activity } = discord.activities.at(-1)!
    assert.equal(activity?.assets?.large_url, undefined)
    assert.equal(activity?.assets?.large_image, artUrl('presence'))
    assert.equal(statuses.at(-1)?.state, 'connected')
    sync(null)
  })
})
