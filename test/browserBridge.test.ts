import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { WebSocket } from 'ws'
import { app } from 'electron'
import type { BrowserBridgeStatus, DesktopMessage, PairingCode } from '@shared/browserBridge'
import { store } from '../src/main/store'
import { toolsFor, type AgentTool, type ToolContext, type ToolQuery, type ToolResult } from '../src/main/agent/tools'
import { __bridgeForTests, browserBridgeFeature } from '../src/main/features/browserBridge'
import { BrowserBridge } from '../src/main/features/browser/server'
import type { FeatureContext } from '../src/main/features/types'

/**
 * The browser bridge end to end, minus Chrome: the real feature registers
 * against a stub Electron context, a fake extension connects over a real
 * loopback WebSocket, pairs, and answers the `browser` tool's calls.
 */

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const OTHER_EXTENSION = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba'

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

type Reply = { ok: true; result: unknown } | { ok: false; error: string }

/** Stands in for the extension's service worker. */
class FakeExtension {
  received: DesktopMessage[] = []
  calls: { action: string; params: Record<string, unknown> }[] = []
  closeCode: number | null = null
  onCall: (action: string, params: Record<string, unknown>) => Promise<Reply> | Reply = () => ({ ok: true, result: { message: 'ok' } })
  private waiters: ((message: DesktopMessage) => void)[] = []
  private closed: Promise<number>

  constructor(readonly ws: WebSocket) {
    ws.on('message', async (data) => {
      const message = JSON.parse(String(data)) as DesktopMessage
      this.received.push(message)
      for (const waiter of this.waiters.splice(0)) waiter(message)
      if (message.type === 'call') {
        this.calls.push({ action: message.action, params: message.params })
        const reply = await this.onCall(message.action, message.params)
        ws.send(JSON.stringify({ type: 'result', id: message.id, ...reply }))
      }
    })
    this.closed = new Promise((resolve) =>
      ws.on('close', (code) => {
        this.closeCode = code
        resolve(code)
      })
    )
  }

  static async open(port: number, origin?: string, headers: Record<string, string> = {}): Promise<FakeExtension> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { ...(origin ? { origin } : {}), headers })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
      ws.once('error', reject)
    })
    return new FakeExtension(ws)
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message))
  }

  hello(extra: Record<string, unknown>): void {
    this.send({ type: 'hello', protocol: 1, extensionVersion: '1.0.0', browser: 'Chrome 153', ...extra })
  }

  next(type: DesktopMessage['type']): Promise<DesktopMessage> {
    const seen = this.received.find((m) => m.type === type)
    if (seen) {
      this.received.splice(this.received.indexOf(seen), 1)
      return Promise.resolve(seen)
    }
    return new Promise((resolve) => {
      const wait = (message: DesktopMessage): void => {
        if (message.type === type) {
          this.received.splice(this.received.indexOf(message), 1)
          resolve(message)
        } else this.waiters.push(wait)
      }
      this.waiters.push(wait)
    })
  }

  whenClosed(): Promise<number> {
    return this.closed
  }

  close(): void {
    this.ws.close()
  }
}

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: { channel: string; payload: unknown }[] = []
const ctx: FeatureContext = {
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn), on: () => {} } as never,
  getWindow: () => null,
  send: (channel, payload) => sent.push({ channel, payload }),
  emitStream: () => {}
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel)
  assert.ok(handler, `no IPC handler for ${channel}`)
  return (await handler({}, ...args)) as T
}

function query(overrides: Partial<ToolQuery> = {}): ToolQuery {
  return { mode: 'work', cwd: '/tmp', depth: 0, readOnly: false, settings: store.getSettings(), request: {} as never, ...overrides }
}

function toolCtx(signal = new AbortController().signal): ToolContext {
  return { signal, settings: store.getSettings(), cwd: '/tmp' } as unknown as ToolContext
}

async function run(tool: AgentTool, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const result = await tool.run(input, toolCtx(signal))
  return typeof result === 'string' ? { text: result } : result
}

const SNAPSHOT = {
  tabId: 7,
  docId: 'doc1',
  text: 'Tab 7\nTitle: Shop\nURL: http://127.0.0.1/shop\n\n[1] textbox "Search"\n[2] button "Place order"\n[3] textbox "Card number"\n[4] textbox "Password"',
  elements: [
    { ref: 1, role: 'textbox', name: 'Search', inputType: 'search' },
    { ref: 2, role: 'button', name: 'Place order', form: 'Place order' },
    { ref: 3, role: 'textbox', name: 'Card number', autocomplete: 'cc-number' },
    { ref: 4, role: 'textbox', name: 'Password', inputType: 'password' },
    { ref: 5, role: 'button', name: 'OK', context: 'Delete 3 files?' },
    { ref: 6, role: 'textbox', name: 'Write a message', form: 'Send' }
  ]
}

describe('browser bridge', () => {
  let port: number
  let tool: AgentTool
  let token: string

  before(async () => {
    port = await freePort()
    store.patchSettings({ browserExtension: { enabled: true, port } })
    await browserBridgeFeature.register(ctx)
    const found = toolsFor(query()).find((t) => t.name === 'browser')
    assert.ok(found, 'the browser tool is offered in Work mode')
    tool = found
  })

  after(async () => {
    browserBridgeFeature.dispose?.()
    await __bridgeForTests()?.stop()
  })

  it('listens on loopback and offers the tool only to the main Work agent', async () => {
    const status = await invoke<BrowserBridgeStatus>('browser-bridge:status')
    assert.equal(status.listening, true)
    assert.equal(status.port, port)
    assert.equal(status.connected, false)
    assert.equal(toolsFor(query({ mode: 'chat' })).some((t) => t.name === 'browser'), false)
    assert.equal(toolsFor(query({ depth: 1 })).some((t) => t.name === 'browser'), false)
    const path = await invoke<string>('browser-bridge:extension-path')
    assert.ok(existsSync(join(path, 'manifest.json')), `extension folder at ${path}`)
  })

  it('explains how to set up the extension when none is connected', async () => {
    const result = await run(tool, { action: 'snapshot' })
    assert.equal(result.isError, true)
    assert.match(result.text, /not connected/)
    assert.match(result.text, /pairing code/)
  })

  it('refuses handshakes from web pages, missing origins and foreign hosts', async () => {
    await assert.rejects(FakeExtension.open(port, 'https://evil.example'), /HTTP 403/)
    await assert.rejects(FakeExtension.open(port), /HTTP 403/)
    await assert.rejects(FakeExtension.open(port, 'chrome-extension://not-an-id'), /HTTP 403/)
    await assert.rejects(FakeExtension.open(port, EXTENSION_ORIGIN, { Host: `rebound.example:${port}` }), /HTTP 403/)
  })

  it('refuses a made-up token and a wrong pairing code', async () => {
    const withToken = await FakeExtension.open(port, EXTENSION_ORIGIN)
    withToken.hello({ token: 'not-a-real-token' })
    const rejected = await withToken.next('rejected')
    assert.equal(rejected.type === 'rejected' && rejected.reason, 'bad-token')
    assert.equal(await withToken.whenClosed(), 4001)

    await invoke<PairingCode>('browser-bridge:pairing-code', true)
    const withCode = await FakeExtension.open(port, EXTENSION_ORIGIN)
    withCode.hello({ pairingCode: 'ZZZZZZ' })
    const bad = await withCode.next('rejected')
    assert.equal(bad.type === 'rejected' && bad.reason, 'bad-code')
    await withCode.whenClosed()
  })

  it('throws a code away after five wrong guesses', async () => {
    const code = await invoke<PairingCode>('browser-bridge:pairing-code', true)
    for (let i = 0; i < 5; i++) {
      const guess = await FakeExtension.open(port, EXTENSION_ORIGIN)
      guess.hello({ pairingCode: `WRONG${i}` })
      await guess.next('rejected')
      await guess.whenClosed()
    }
    const status = await invoke<BrowserBridgeStatus>('browser-bridge:status')
    assert.equal(status.pairing, null, 'the code is withdrawn')
    const late = await FakeExtension.open(port, EXTENSION_ORIGIN)
    late.hello({ pairingCode: code.code })
    const rejected = await late.next('rejected')
    assert.equal(rejected.type === 'rejected' && rejected.reason, 'bad-code', 'even the right code no longer works')
    await late.whenClosed()
  })

  it('pairs with a code and stores only a hash of the token', async () => {
    const code = await invoke<PairingCode>('browser-bridge:pairing-code', true)
    assert.match(code.code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/)
    const ext = await FakeExtension.open(port, EXTENSION_ORIGIN)
    ext.hello({ pairingCode: code.code.toLowerCase().replace('-', ' ') })
    const welcome = await ext.next('welcome')
    assert.equal(welcome.type, 'welcome')
    token = (welcome as { token?: string }).token ?? ''
    assert.ok(token.length >= 40, 'a long random token')

    const stored = readFileSync(join(app.getPath('userData'), 'store', 'browser-pairing.json'), 'utf8')
    assert.equal(stored.includes(token), false, 'the token itself is never written to disk')
    assert.match(stored, /"tokenHash": "[0-9a-f]{64}"/)

    const status = await invoke<BrowserBridgeStatus>('browser-bridge:status')
    assert.equal(status.connected, true)
    assert.equal(status.client?.browser, 'Chrome 153')
    assert.equal(status.pairing, null, 'the code was used up')
    ext.close()
    await ext.whenClosed()
  })

  it('accepts the token only from the extension that paired', async () => {
    const other = await FakeExtension.open(port, OTHER_EXTENSION)
    other.hello({ token })
    const rejected = await other.next('rejected')
    assert.equal(rejected.type === 'rejected' && rejected.reason, 'bad-token')
    await other.whenClosed()
  })

  describe('with the extension connected', () => {
    let ext: FakeExtension

    before(async () => {
      ext = await FakeExtension.open(port, EXTENSION_ORIGIN)
      ext.hello({ token })
      const welcome = await ext.next('welcome')
      assert.equal((welcome as { token?: string }).token, undefined, 'no new token on reconnect')
    })

    it('round-trips a snapshot and keeps its elements for risk checks', async () => {
      ext.onCall = (action) => (action === 'snapshot' ? { ok: true, result: SNAPSHOT } : { ok: false, error: 'unexpected' })
      const result = await run(tool, { action: 'snapshot' })
      assert.equal(result.isError, undefined)
      assert.match(result.text, /\[2\] button "Place order"/)
      assert.deepEqual(ext.calls.at(-1), { action: 'snapshot', params: { maxChars: 8000 } })

      const risky = (input: Record<string, unknown>): boolean => tool.risky?.(input, toolCtx()) ?? false
      assert.equal(risky({ action: 'click', ref: 1 }), false, 'clicking a search box')
      assert.equal(risky({ action: 'click', ref: 2 }), true, 'placing an order')
      assert.equal(risky({ action: 'click', ref: 5 }), true, '"OK" in a delete dialog')
      assert.equal(risky({ action: 'click', ref: 99 }), true, 'a ref no snapshot vouches for')
      assert.equal(risky({ action: 'type', ref: 1, text: 'shoes' }), false)
      assert.equal(risky({ action: 'type', ref: 1, text: 'shoes', submit: true }), false, 'submitting a search')
      assert.equal(risky({ action: 'type', ref: 3, text: '4242' }), true, 'a card number')
      assert.equal(risky({ action: 'type', ref: 4, text: 'hunter2' }), true, 'a password')
      assert.equal(risky({ action: 'type', ref: 6, text: 'hi', submit: true }), true, 'sending a message')
      assert.equal(risky({ action: 'type', ref: 6, text: 'hi' }), false, 'drafting one is fine')

      const mutating = tool.mutating as (input: Record<string, unknown>, ctx: ToolContext) => boolean
      assert.equal(mutating({ action: 'snapshot' }, toolCtx()), false)
      assert.equal(mutating({ action: 'scroll' }, toolCtx()), false)
      assert.equal(mutating({ action: 'click', ref: 1 }, toolCtx()), true)
      assert.equal(mutating({ action: 'navigate', url: 'example.com' }, toolCtx()), true)
      assert.equal(tool.describe?.({ action: 'click', ref: 2 }), 'click [2] button "Place order"')
    })

    it('clicks by ref and tells the extension what the element was called', async () => {
      ext.onCall = (_action, params) => ({ ok: true, result: { tabId: 7, message: `Clicked [${String(params.ref)}] button "Place order".` } })
      const result = await run(tool, { action: 'click', ref: 2 })
      assert.equal(result.text, 'Clicked [2] button "Place order".')
      assert.deepEqual(ext.calls.at(-1), { action: 'click', params: { ref: 2, expectName: 'Place order' } })
    })

    it('returns screenshots as images', async () => {
      ext.onCall = () => ({ ok: true, result: { tabId: 7, url: 'http://127.0.0.1/shop', title: 'Shop', mime: 'image/jpeg', data: '/9j/AAAA', width: 800, height: 600 } })
      const result = await run(tool, { action: 'screenshot' })
      assert.equal(result.images?.length, 1)
      assert.deepEqual(result.images?.[0], { mime: 'image/jpeg', data: '/9j/AAAA' })
      assert.match(result.text, /Shop.*800×600/)
    })

    it('reports the extension\'s own errors back to the agent', async () => {
      ext.onCall = () => ({ ok: false, error: 'Element [9] is no longer on the page. Take a new snapshot.' })
      const result = await run(tool, { action: 'click', ref: 9 })
      assert.equal(result.isError, true)
      assert.match(result.text, /no longer on the page/)
    })

    it('rejects calls with missing parameters without bothering the browser', async () => {
      const before = ext.calls.length
      const result = await run(tool, { action: 'type', ref: 1 })
      assert.equal(result.isError, true)
      assert.match(result.text, /needs "text"/)
      assert.equal(ext.calls.length, before)
    })

    it('runs calls one at a time, in order', async () => {
      const order: string[] = []
      ext.onCall = async (action) => {
        order.push(`start ${action}`)
        if (action === 'scroll') await new Promise((r) => setTimeout(r, 80))
        order.push(`end ${action}`)
        return action === 'snapshot' ? { ok: true, result: SNAPSHOT } : { ok: true, result: { tabId: 7, message: 'Scrolled.' } }
      }
      await Promise.all([run(tool, { action: 'scroll', direction: 'down' }), run(tool, { action: 'snapshot' })])
      assert.deepEqual(order, ['start scroll', 'end scroll', 'start snapshot', 'end snapshot'])
    })

    it('cancels a call when the turn is stopped', async () => {
      ext.onCall = () => new Promise(() => {}) // never answers
      const controller = new AbortController()
      const pending = run(tool, { action: 'wait', text: 'never' }, controller.signal)
      await new Promise((r) => setTimeout(r, 50))
      controller.abort()
      const result = await pending
      assert.equal(result.isError, true)
      assert.match(result.text, /Stopped/)
      const cancel = await ext.next('cancel')
      assert.equal(cancel.type, 'cancel')
    })

    it('refuses to act once the user stops agent control', async () => {
      ext.send({ type: 'state', paused: true, agentTab: { title: 'Shop', url: 'http://127.0.0.1/shop' } })
      await new Promise((r) => setTimeout(r, 50))
      const status = await invoke<BrowserBridgeStatus>('browser-bridge:status')
      assert.equal(status.paused, true)
      assert.equal(status.agentTab?.title, 'Shop')
      const before = ext.calls.length
      const result = await run(tool, { action: 'snapshot' })
      assert.equal(result.isError, true)
      assert.match(result.text, /Stop agent control/)
      assert.equal(ext.calls.length, before, 'nothing was sent to the browser')
      ext.send({ type: 'state', paused: false, agentTab: null })
      await new Promise((r) => setTimeout(r, 50))
    })

    it('answers pings so the extension\'s service worker stays alive', async () => {
      ext.send({ type: 'ping' })
      assert.equal((await ext.next('pong')).type, 'pong')
    })

    it('unpairing from Settings disconnects the extension and voids its token', async () => {
      const status = await invoke<BrowserBridgeStatus>('browser-bridge:unpair')
      assert.equal(status.paired, false)
      const rejected = await ext.next('rejected')
      assert.equal(rejected.type === 'rejected' && rejected.reason, 'unpaired')
      await ext.whenClosed()

      const again = await FakeExtension.open(port, EXTENSION_ORIGIN)
      again.hello({ token })
      const refused = await again.next('rejected')
      assert.equal(refused.type === 'rejected' && refused.reason, 'bad-token')
      await again.whenClosed()

      const result = await run(tool, { action: 'snapshot' })
      assert.equal(result.isError, true)
      assert.match(result.text, /not connected/)
    })
  })

  it('pushes status to the renderer as things change', () => {
    assert.ok(sent.some((s) => s.channel === 'browser-bridge:status' && (s.payload as BrowserBridgeStatus).connected === true))
  })
})

describe('browser bridge server', () => {
  it('drops a connection that never says hello', async () => {
    const bridge = new BrowserBridge({ appVersion: 'test', store: { load: () => null, save: () => {} }, helloTimeoutMs: 150 })
    await bridge.start(0)
    try {
      const ext = await FakeExtension.open(bridge.boundPort, EXTENSION_ORIGIN)
      const rejected = await ext.next('rejected')
      assert.equal(rejected.type === 'rejected' && rejected.reason, 'timeout')
      assert.equal(await ext.whenClosed(), 4001)
    } finally {
      await bridge.stop()
    }
  })

  it('refuses an extension speaking a different protocol version', async () => {
    const bridge = new BrowserBridge({ appVersion: 'test', store: { load: () => null, save: () => {} } })
    await bridge.start(0)
    try {
      const code = bridge.pairingCode()
      const ext = await FakeExtension.open(bridge.boundPort, EXTENSION_ORIGIN)
      ext.send({ type: 'hello', protocol: 99, extensionVersion: '9.0.0', browser: 'Chrome', pairingCode: code.code })
      const rejected = await ext.next('rejected')
      assert.equal(rejected.type === 'rejected' && rejected.reason, 'protocol')
      assert.match((rejected as { message: string }).message, /Update Eaon/)
    } finally {
      await bridge.stop()
    }
  })

  it('reports a port that is already taken instead of throwing', async () => {
    const holder = new BrowserBridge({ appVersion: 'test', store: { load: () => null, save: () => {} } })
    await holder.start(0)
    const second = new BrowserBridge({ appVersion: 'test', store: { load: () => null, save: () => {} } })
    try {
      await second.start(holder.boundPort)
      assert.equal(second.listening, false)
      assert.match(second.status().error ?? '', /already in use/)
    } finally {
      await holder.stop()
      await second.stop()
    }
  })
})
