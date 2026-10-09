import { strict as assert } from 'node:assert'
import { createServer } from 'node:net'
import { after, describe, it } from 'node:test'
import { WebSocket } from 'ws'
import { BROWSER_ACTIONS, V1_ACTIONS, type DesktopMessage } from '@shared/browserBridge'
import { BrowserBridge, type PairingRecord } from '../src/main/features/browser/server'
import { createBrowserTool } from '../src/main/features/browser/tool'

/**
 * Extension 1.2.0's additions on the app side: `links`, `clear` and
 * `get_text`. The extension is a script that says hello with its features and
 * answers the calls it is sent; what the real one does with them is proved in
 * real Chrome by browser-extension-live.test.ts.
 */

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const V11 = [
  'navigate', 'new_tab', 'list_tabs', 'switch_tab', 'close_tab', 'snapshot', 'click', 'type', 'press', 'scroll',
  'select', 'hover', 'back', 'forward', 'wait', 'screenshot', 'get_url', 'read', 'find', 'fill', 'reload', 'self-update', 'ask'
]
const V12 = [...V11, 'links', 'clear', 'get_text']

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

/** A scripted extension: says hello, answers calls, records what the app sends. */
class Extension {
  calls: { action: string; params: Record<string, unknown> }[] = []
  messages: DesktopMessage[] = []
  reply: (action: string, params: Record<string, unknown>) => Record<string, unknown> = () => ({ message: 'ok' })
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as DesktopMessage
      this.messages.push(message)
      if (message.type === 'call') {
        this.calls.push({ action: message.action, params: message.params })
        ws.send(JSON.stringify({ type: 'result', id: message.id, ok: true, result: this.reply(message.action, message.params) }))
      }
    })
  }
  static async connect(port: number, hello: Record<string, unknown>): Promise<Extension> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN })
    const extension = new Extension(ws)
    await new Promise<void>((resolve, reject) => ws.once('open', () => resolve()).once('error', reject))
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, browser: 'Chrome 153', ...hello }))
    await until('a welcome', () => extension.messages.some((m) => m.type === 'welcome'))
    return extension
  }
}

const PAGE = {
  tabId: 7,
  docId: 'doc1',
  text: 'Tab 7\n[1] textbox "Search"\n[2] textbox "Password"\n[3] textbox "Card number"',
  elements: [
    { ref: 1, role: 'textbox', name: 'Search', inputType: 'search' },
    { ref: 2, role: 'textbox', name: 'Password', inputType: 'password' },
    { ref: 3, role: 'textbox', name: 'Card number', autocomplete: 'cc-number' }
  ]
}

describe('extension 1.2 on the bridge', () => {
  let record: PairingRecord | null = null
  const bridge = new BrowserBridge({ appVersion: '2026.6.1', store: { load: () => record, save: (next) => (record = next) }, bundledVersion: () => '1.2.0' })
  let port = 0
  let token = ''
  const open: Extension[] = []
  const connect = async (hello: Record<string, unknown>): Promise<Extension> => {
    const extension = await Extension.connect(port, token ? { token, ...hello } : { pairingCode: bridge.pairingCode(true).code, ...hello })
    const welcome = extension.messages.find((m) => m.type === 'welcome')
    if (welcome?.type === 'welcome' && welcome.token) token = welcome.token
    open.push(extension)
    return extension
  }
  const { tool } = createBrowserTool(bridge)
  const run = async (input: Record<string, unknown>): ReturnType<typeof tool.run> => tool.run(input, { signal: new AbortController().signal } as never)
  const text = async (input: Record<string, unknown>): Promise<string> => {
    const result = await run(input)
    return typeof result === 'string' ? result : result.text
  }

  after(async () => {
    for (const extension of open) extension.ws.terminate()
    await bridge.stop()
  })

  it('the new actions are additions: a 1.0 extension’s own list does not grow', () => {
    for (const action of ['links', 'clear', 'get_text'] as const) {
      assert.ok(BROWSER_ACTIONS.includes(action))
      assert.ok(!V1_ACTIONS.includes(action))
    }
  })

  it('an extension that cannot do them is told so, and asked to update, instead of failing oddly', async () => {
    port = await freePort()
    await bridge.start(port)
    const old = await connect({ extensionVersion: '1.1.0', features: V11, installType: 'development' })
    assert.equal(bridge.supports('links'), false)
    const message = await text({ action: 'links' })
    assert.match(message, /too old for "links"/)
    await until('the update request', () => old.messages.some((m) => m.type === 'update'))
    assert.equal(old.calls.length, 0, 'nothing was sent that it would not understand')
    old.ws.terminate()
  })

  describe('with 1.2.0 connected', () => {
    let ext: Extension

    it('lists links: the filter and a capped limit go to the page, and its refs are remembered', async () => {
      ext = await connect({ extensionVersion: '1.2.0', features: V12, installType: 'development' })
      await until('1.2.0', () => bridge.supports('links'))
      ext.reply = (action) =>
        action === 'links'
          ? {
              tabId: 7,
              docId: 'doc2',
              text: '2 links matching "pric" on http://x/:\n[11] "Pricing" → /pricing (on screen)\n[12] "Pricing FAQ" → /pricing/faq (below)',
              elements: [
                { ref: 11, role: 'link', name: 'Pricing' },
                { ref: 12, role: 'link', name: 'Pricing FAQ' }
              ]
            }
          : PAGE
      const out = await text({ action: 'links', text: 'pric', limit: 5000 })
      assert.match(out, /\[11\] "Pricing" → \/pricing/)
      assert.deepEqual(ext.calls.at(-1), { action: 'links', params: { text: 'pric', limit: 100 } })
      await text({ action: 'links' })
      assert.deepEqual(ext.calls.at(-1), { action: 'links', params: {} }, 'no filter, no limit: the extension’s default')
      // A link found this way can be clicked, and the app knows its name.
      await text({ action: 'click', ref: 11 })
      assert.deepEqual(ext.calls.at(-1), { action: 'click', params: { ref: 11, expectName: 'Pricing' } })
    })

    it('links and get_text only look, so they need no approval; clear changes a field', () => {
      const mutating = tool.mutating as (input: Record<string, unknown>) => boolean
      assert.equal(mutating({ action: 'links' }), false)
      assert.equal(mutating({ action: 'get_text', ref: 1 }), false)
      assert.equal(mutating({ action: 'clear', ref: 1 }), true)
    })

    it('clear and get_text name an element, and tell the extension what it was called', async () => {
      assert.match(await text({ action: 'clear' }), /needs "ref"/)
      assert.match(await text({ action: 'get_text' }), /needs "ref"/)
      ext.reply = () => PAGE
      await text({ action: 'snapshot' })
      ext.reply = (action) => (action === 'get_text' ? { tabId: 7, text: '[1] textbox "Search" holds "shoes"' } : { tabId: 7, message: 'Cleared [1] textbox "Search".' })
      assert.equal(await text({ action: 'get_text', ref: 1 }), '[1] textbox "Search" holds "shoes"')
      assert.deepEqual(ext.calls.at(-1), { action: 'get_text', params: { ref: 1, expectName: 'Search' } })
      assert.equal(await text({ action: 'clear', ref: 1 }), 'Cleared [1] textbox "Search".')
      assert.deepEqual(ext.calls.at(-1), { action: 'clear', params: { ref: 1, expectName: 'Search' } })
    })

    it('emptying a password or card field, or one nobody has seen, is asked about like typing into it', () => {
      const risky = (input: Record<string, unknown>): boolean => tool.risky?.(input, { signal: new AbortController().signal } as never) ?? false
      assert.equal(risky({ action: 'clear', ref: 1 }), false, 'a search box')
      assert.equal(risky({ action: 'clear', ref: 2 }), true, 'a password')
      assert.equal(risky({ action: 'clear', ref: 3 }), true, 'a card number')
      assert.equal(risky({ action: 'clear', ref: 99 }), true, 'a ref no snapshot vouches for')
      assert.equal(risky({ action: 'get_text', ref: 99 }), false, 'reading is not risky; the extension refuses a password itself')
    })

    it('says in words what each does, for the approval prompt and the transcript', () => {
      assert.equal(tool.describe?.({ action: 'clear', ref: 1 }), 'clear [1] textbox "Search"')
      assert.equal(tool.describe?.({ action: 'links', text: 'pricing' }), 'list links matching "pricing"')
      assert.equal(tool.describe?.({ action: 'links' }), 'list links')
    })
  })
})
