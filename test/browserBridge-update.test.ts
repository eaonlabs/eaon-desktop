import { strict as assert } from 'node:assert'
import { createServer } from 'node:net'
import { after, describe, it } from 'node:test'
import { WebSocket } from 'ws'
import type { BrowserAsk, DesktopMessage } from '@shared/browserBridge'
import { BrowserBridge, type PairingRecord } from '../src/main/features/browser/server'
import { createBrowserTool } from '../src/main/features/browser/tool'
import { LegacyExtensionDetector } from '../src/main/features/browser/legacy'

/**
 * Extension 1.1.0's additions on the app side: the hello's feature list,
 * self-update for unpacked installs (once per version, never in a loop),
 * "Ask Eaon" from the right-click menu, the agent being told when the
 * extension is too old for an action, and noticing the Swift-era extension.
 */

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const V11_FEATURES = [
  'navigate', 'new_tab', 'list_tabs', 'switch_tab', 'close_tab', 'snapshot', 'click', 'type', 'press', 'scroll',
  'select', 'hover', 'back', 'forward', 'wait', 'screenshot', 'get_url', 'read', 'find', 'fill', 'reload', 'self-update', 'ask'
]

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

async function until(what: string, check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A scripted extension: says hello, records what the app sends. */
class Client {
  messages: DesktopMessage[] = []
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => this.messages.push(JSON.parse(String(data)) as DesktopMessage))
  }
  static async connect(port: number, hello: Record<string, unknown>): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN })
    const client = new Client(ws)
    await new Promise<void>((resolve, reject) => ws.once('open', () => resolve()).once('error', reject))
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, browser: 'Chrome 153', ...hello }))
    await until('a welcome or a rejection', () => client.messages.some((m) => m.type === 'welcome' || m.type === 'rejected'))
    return client
  }
  of<T extends DesktopMessage['type']>(type: T): Extract<DesktopMessage, { type: T }>[] {
    return this.messages.filter((m) => m.type === type) as Extract<DesktopMessage, { type: T }>[]
  }
  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message))
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve())
      this.ws.close()
    })
  }
}

describe('extension 1.1 on the bridge', () => {
  let record: PairingRecord | null = null
  let bundled = '1.1.0'
  const asks: BrowserAsk[] = []
  const bridge = new BrowserBridge({
    appVersion: '2026.6.0',
    store: { load: () => record, save: (next) => (record = next) },
    bundledVersion: () => bundled,
    onAsk: (ask) => asks.push(ask)
  })
  let port = 0
  let token = ''
  const clients: Client[] = []
  const open = async (hello: Record<string, unknown>): Promise<Client> => {
    const client = await Client.connect(port, token ? { token, ...hello } : { pairingCode: bridge.pairingCode(true).code, ...hello })
    const welcome = client.of('welcome')[0]
    if (welcome?.token) token = welcome.token
    clients.push(client)
    return client
  }

  after(async () => {
    for (const client of clients) client.ws.terminate()
    await bridge.stop()
  })

  it('treats an extension that lists no features as 1.0.0, and tells it a newer one exists', async () => {
    port = await freePort()
    await bridge.start(port)
    const v1 = await open({ extensionVersion: '1.0.0' })
    assert.equal(v1.of('welcome')[0].latestExtension, '1.1.0')
    assert.equal(bridge.supports('snapshot'), true)
    assert.equal(bridge.supports('read'), false, '1.0.0 has no read')
    assert.equal(bridge.status().canSelfUpdate, false)
    assert.equal(bridge.requestUpdate(), false, '1.0.0 cannot update itself')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(v1.of('update').length, 0, 'nothing it would not understand')
  })

  it('tells the agent the extension is too old for a new action rather than failing oddly', async () => {
    const { tool } = createBrowserTool(bridge)
    const result = await tool.run({ action: 'read' }, { signal: new AbortController().signal } as never)
    assert.equal(result.isError, true)
    assert.match(result.text, /too old for "read"/)
    assert.match(result.text, /Settings → Browser extension/)
  })

  it('asks an unpacked 1.1 extension to update to what the app ships, once per version', async () => {
    await clients[0].close()
    bundled = '1.2.0'
    const old = await open({ extensionVersion: '1.1.0', features: V11_FEATURES, installType: 'development' })
    await until('an update request', () => old.of('update').length > 0)
    assert.equal(old.of('update')[0].version, '1.2.0')
    assert.equal(bridge.status().update, 'reloading')
    assert.equal(bridge.status().canSelfUpdate, true)
    assert.equal(bridge.supports('read'), true)

    // The reload lands: the same pairing reconnects as 1.2.0.
    await old.close()
    const updated = await open({ extensionVersion: '1.2.0', features: V11_FEATURES, installType: 'development' })
    assert.equal(updated.of('welcome')[0].latestExtension, undefined, 'nothing newer to offer')
    assert.equal(bridge.status().update, 'idle')
    assert.equal(record?.extensionVersion, '1.2.0')

    // A reload that brought nothing new is not retried on reconnect…
    await updated.close()
    const stuck = await open({ extensionVersion: '1.1.0', features: V11_FEATURES, installType: 'development' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(stuck.of('update').length, 0, 'offered once per version, not in a loop')
    stuck.send({ type: 'update-status', state: 'stuck', version: '1.1.0' })
    await until('the stuck state', () => bridge.status().update === 'stuck')
    // …but the user can still ask for it from Settings.
    assert.equal(bridge.requestUpdate(), true)
    await until('a manual update request', () => stuck.of('update').length === 1)
  })

  it('leaves store installs to the store', async () => {
    await clients.at(-1)!.close()
    bundled = '1.3.0'
    const store = await open({ extensionVersion: '1.1.0', features: V11_FEATURES, installType: 'normal' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(store.of('update').length, 0)
    assert.equal(bridge.status().canSelfUpdate, false)
    assert.equal(store.of('welcome')[0].latestExtension, '1.3.0', 'still told, so its popup can offer a store check')
  })

  it('passes a right-click "Ask Eaon" on, bounded and cleaned, and ignores malformed ones', async () => {
    const client = clients.at(-1)!
    client.send({ type: 'ask', kind: 'selection', text: 'x'.repeat(30_000), url: 'https://example.com/a', title: 'Tab\u0000title\u0007', tabId: null })
    client.send({ type: 'ask', kind: 'page', text: '', url: 'https://example.com/b', title: 'B', tabId: 12 })
    client.send({ type: 'ask', kind: 'run-this', text: 'rm -rf /', url: '', title: '', tabId: null })
    await until('two asks', () => asks.length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(asks.length, 2, 'an unknown kind is dropped')
    assert.equal(asks[0].text.length, 20_000)
    assert.equal(asks[0].title, 'Tab title ')
    assert.deepEqual(asks[1], { kind: 'page', text: '', url: 'https://example.com/b', title: 'B', tabId: 12 })
  })

  it('asks about a fill whose fields it has never seen', () => {
    const { tool } = createBrowserTool(bridge)
    assert.equal(tool.risky?.({ action: 'fill', fields: [{ ref: 3, text: 'Ada' }] }), true)
    assert.equal(tool.mutating?.({ action: 'fill' }), true)
    assert.equal(tool.mutating?.({ action: 'read' }), false, 'reading needs no approval')
    assert.equal(tool.mutating?.({ action: 'find' }), false)
  })
})

describe('the Swift-era extension', () => {
  it('is noticed from its own polling, and not from anything a web page could send', async () => {
    let changes = 0
    const port = await freePort()
    const detector = new LegacyExtensionDetector(() => changes++, port)
    await detector.start()
    try {
      const page = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-eaon-token': 'abc', origin: 'https://evil.example' } })
      assert.equal(page.status, 404)
      const plain = await fetch(`http://127.0.0.1:${port}/health`)
      assert.equal(plain.status, 404)
      assert.equal(detector.seenAt, null, 'neither counts')

      const old = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-eaon-token': 'abc' } })
      assert.equal(old.status, 410, 'the old extension is told it is gone, not that it connected')
      assert.match(((await old.json()) as { error: string }).error, /out of date/)
      assert.ok(detector.seenAt, 'the old extension is noticed')
      assert.equal(changes, 1)
      await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'x-eaon-token': 'abc' } })
      assert.equal(changes, 1, 'Settings hears about it once, not on every poll')
    } finally {
      await detector.stop()
    }
    assert.equal(detector.seenAt, null)
  })

  it('stays out of the way when the port is taken', async () => {
    const holder = createServer()
    const port = await new Promise<number>((resolve) => holder.listen(0, '127.0.0.1', () => resolve((holder.address() as { port: number }).port)))
    const detector = new LegacyExtensionDetector(() => undefined, port)
    await detector.start()
    await detector.stop()
    holder.close()
  })
})
