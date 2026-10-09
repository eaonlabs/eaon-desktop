import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../src/main/agent/tools'
import { devtoolsUrl, listening } from '../src/main/features/browserUse/chromium'
import { browserCatastrophic, browserRisk, PageMemory } from '../src/main/features/browserUse/policy'
import { BrowserUseSession, browserUseEnv, writeConfig } from '../src/main/features/browserUse/session'
import { install, installState, layout, uvEnv } from '../src/main/features/browserUse/setup'
import { browserUseAgentTools, OFFERED, type BrowserUseLink } from '../src/main/features/browserUse/tools'

/**
 * Browser control through Browser Use: Eaon's rules around it with a
 * stand-in, and — with EAON_BROWSER_USE_LIVE=1, since it downloads ~300 MB —
 * the real thing installed into a scratch folder and attached to a throwaway
 * headless Chrome, never the user's own browser or profile.
 */

const scratch = mkdtempSync(join(tmpdir(), 'browser-use-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function ctx(signal = new AbortController().signal): ToolContext {
  return {
    request: { chatId: 'c1', messageId: 'm1', chatTitle: 'Chat' },
    turn: { notes: [] },
    cwd: scratch,
    signal,
    emit: () => undefined,
    toolId: 't',
    depth: 0,
    readOnly: false,
    settings: {},
    progress: () => undefined,
    confirm: async () => true
  } as unknown as ToolContext
}

const STATE = JSON.stringify({
  url: 'http://shop.test/',
  interactive_elements: [
    { index: 18, tag: 'label', text: 'Card number' },
    { index: 3, tag: 'input', text: '' },
    { index: 21, tag: 'label', text: 'Email' },
    { index: 4, tag: 'input', text: '' },
    { index: 5, tag: 'input', text: '', placeholder: 'Password' },
    { index: 6, tag: 'button', text: 'Place order' },
    { index: 7, tag: 'button', text: 'Send message' },
    { index: 8, tag: 'button', text: 'Save draft' },
    { index: 27, tag: 'a', text: 'Help', href: '/help' }
  ]
})

test('risk is judged on what the page holds: fields get their labels, buttons their words', () => {
  const page = new PageMemory()
  page.remember(STATE)
  const risky = (tool: string, input: Record<string, unknown>): [boolean, boolean] => [browserRisk(tool, input, page), browserCatastrophic(tool, input, page)]
  assert.deepEqual(risky('browser_type', { index: 3, text: '4111' }), [true, true], 'the card field, by its label')
  assert.deepEqual(risky('browser_type', { index: 5, text: 'x' }), [true, true], 'a password field, by its placeholder')
  assert.deepEqual(risky('browser_type', { index: 4, text: 'al@example.com' }), [false, false], 'an email field')
  assert.deepEqual(risky('browser_click', { index: 6 }), [true, true], 'placing an order spends money')
  assert.deepEqual(risky('browser_click', { index: 7 }), [true, false], 'sending asks, but is not spending')
  assert.deepEqual(risky('browser_click', { index: 8 }), [false, false])
  assert.deepEqual(risky('browser_click', { index: 99 }), [true, true], 'an element never read')
  assert.deepEqual(risky('browser_click', { coordinate_x: 10, coordinate_y: 10 }), [true, true], 'a click by coordinates')
  assert.equal(browserRisk('browser_navigate', { url: 'http://localhost:3000/admin' }, page), true)
  assert.equal(browserRisk('browser_navigate', { url: 'https://example.com' }, page), false)
  page.forget()
  assert.equal(browserRisk('browser_click', { index: 8 }, page), true, 'after the page changed, nothing read applies')
})

/** A stand-in for Browser Use: records calls and answers as it would. */
function fakeLink() {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  let owns = false
  let connected = { ok: true } as { ok: true } | { ok: false; text: string }
  const link: BrowserUseLink = {
    connect: async () => connected,
    call: async (name, args) => {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: name === 'browser_get_state' ? STATE : `${name} done` }], isError: false }
    },
    ownsTab: () => owns,
    setOwnsTab: (o) => (owns = o)
  }
  return { link, calls, refuse: (text: string) => (connected = { ok: false, text }) }
}

const toolList = OFFERED.map((name) => ({ name, description: `${name} (Browser Use)`, inputSchema: { type: 'object' } }))

test('the agent never reads or takes over the user’s tab: its first page opens in a tab of its own', async () => {
  const { link, calls } = fakeLink()
  const tools = new Map(browserUseAgentTools(link, toolList).map((t) => [t.name, t]))
  const before = await tools.get('browser_get_state')!.run({}, ctx())
  assert.equal(typeof before === 'object' && before.isError, true)
  assert.equal(calls.length, 0, 'nothing read from the tab in front')
  await tools.get('browser_navigate')!.run({ url: 'https://example.com' }, ctx())
  assert.deepEqual(calls[0], { name: 'browser_navigate', args: { url: 'https://example.com', new_tab: true } })
  await tools.get('browser_navigate')!.run({ url: 'https://example.com/next' }, ctx())
  assert.deepEqual(calls[1].args, { url: 'https://example.com/next' }, 'then it carries on in its own tab')
  const state = await tools.get('browser_get_state')!.run({}, ctx())
  assert.equal(typeof state === 'object' && !state.isError, true)
  // What it read decides what asks.
  const click = tools.get('browser_click')!
  assert.equal(click.risky!({ index: 6 }, ctx()), true)
  assert.equal(click.risky!({ index: 8 }, ctx()), false)
  assert.equal(click.describe!({ index: 6 }, ctx()), 'click [6] button "Place order"')
  // Switching to or closing a tab always asks: it may be the user's.
  assert.equal(tools.get('browser_switch_tab')!.risky!({ tab_id: 'ab12' }, ctx()), true)
  assert.equal(tools.get('browser_close_tab')!.risky!({ tab_id: 'ab12' }, ctx()), true)
})

test('only Eaon’s chosen tools are offered: none that call a model of Browser Use’s own', () => {
  const { link } = fakeLink()
  const all = [...toolList, ...['browser_extract_content', 'retry_with_browser_use_agent', 'browser_close_all'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }))]
  assert.deepEqual(
    browserUseAgentTools(link, all).map((t) => t.name),
    [...OFFERED]
  )
})

test('when the browser can’t be reached, the model is told why, and nothing is called', async () => {
  const { link, calls, refuse } = fakeLink()
  refuse('Chrome isn’t open, or it doesn’t allow remote debugging yet.')
  const tools = new Map(browserUseAgentTools(link, toolList).map((t) => [t.name, t]))
  const result = await tools.get('browser_navigate')!.run({ url: 'https://example.com' }, ctx())
  assert.deepEqual(result, { text: 'Chrome isn’t open, or it doesn’t allow remote debugging yet.', isError: true })
  assert.equal(calls.length, 0)
})

test('setup keeps everything in Eaon’s folder; Browser Use runs with telemetry, cloud sync and version checks off', () => {
  const root = join(scratch, 'root')
  const env = uvEnv(root, '/tmp/cache', { PATH: '/bin' })
  for (const key of ['UV_TOOL_DIR', 'UV_TOOL_BIN_DIR', 'UV_PYTHON_INSTALL_DIR']) assert.ok(env[key].startsWith(root), key)
  assert.equal(env.UV_PYTHON_PREFERENCE, 'only-managed', 'never the system Python')
  assert.equal(env.UV_NO_CONFIG, '1')
  const bu = browserUseEnv(root, { PATH: '/bin', HOME: '/Users/al' })
  assert.equal(bu.ANONYMIZED_TELEMETRY, 'false')
  assert.equal(bu.BROWSER_USE_CLOUD_SYNC, 'false')
  assert.equal(bu.BROWSER_USE_VERSION_CHECK, 'false')
  assert.ok(bu.HOME.startsWith(root), 'its scratch files are not in the user’s home')
  assert.equal(installState(root).installed, false)
  writeConfig(root, 'ws://127.0.0.1:9222/devtools/browser/x', '/Users/al/Downloads')
  const config = JSON.parse(readFileSync(join(layout(root).config, 'config.json'), 'utf8'))
  assert.equal(config.browser_profile.eaon.cdp_url, 'ws://127.0.0.1:9222/devtools/browser/x')
  assert.equal(config.browser_profile.eaon.downloads_path, '/Users/al/Downloads')
})

test('a download of uv that fails its checksum is refused', { skip: process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32' ? false : 'no uv for this platform' }, async () => {
  const root = join(scratch, 'bad-uv')
  const tampered = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch
  await assert.rejects(install(root, () => undefined, tampered), /checksum/)
  assert.equal(existsSync(layout(root).uv), false)
})

test('the browser’s debugging address is read from its profile folder; a stale one is noticed without asking the browser anything', async () => {
  const dir = join(scratch, 'profile')
  mkdirSync(dir, { recursive: true })
  assert.equal(devtoolsUrl(dir), null, 'remote debugging not allowed')
  writeFileSync(join(dir, 'DevToolsActivePort'), '1\n/devtools/browser/abc\n')
  assert.equal(devtoolsUrl(dir), 'ws://127.0.0.1:1/devtools/browser/abc')
  assert.equal(await listening('ws://127.0.0.1:1/devtools/browser/abc', 500), false, 'nothing listens there: the browser quit')
  writeFileSync(join(dir, 'DevToolsActivePort'), 'not a port\n')
  assert.equal(devtoolsUrl(dir), null)
})

/* ---------------------------------------------------------------- the real thing */

const live = process.env.EAON_BROWSER_USE_LIVE === '1'
const chromeBin =
  process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'linux' ? '/usr/bin/google-chrome' : null

test(
  'Browser Use, installed into a scratch folder, drives a throwaway Chrome through Eaon’s tools, and leaves the browser running',
  { skip: !live ? 'set EAON_BROWSER_USE_LIVE=1 (downloads ~300 MB)' : !chromeBin || !existsSync(chromeBin) ? 'no Chrome here' : false, timeout: 600_000 },
  async () => {
    const root = join(scratch, 'live')
    const steps: string[] = []
    const state = await install(root, (s) => steps.push(s))
    assert.equal(state.installed, true)
    assert.ok(steps.includes('Ready'), steps.join(' → '))
    assert.deepEqual(readdirSync(root).filter((f) => !['uv', 'tools', 'bin', 'python', 'python-bin', 'installed.json'].includes(f)), [], 'only what setup puts there')

    // A shop page, and a headless Chrome with a throwaway profile.
    const site = createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(
        req.url === '/thanks'
          ? '<title>Thanks</title><h1>Saved</h1>'
          : `<title>Shop</title><h1>Cart</h1><form action="/thanks"><label>Email <input type=email name=email></label><label>Card number <input name=cc autocomplete=cc-number></label><button type=submit>Place order</button></form><button onclick="this.textContent='Draft saved'">Save draft</button>`
      )
    })
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
    const shop = `http://127.0.0.1:${(site.address() as { port: number }).port}/`
    const profile = join(scratch, 'chrome-profile')
    const chrome: ChildProcess = spawn(chromeBin!, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
    const session = new BrowserUseSession(root)
    try {
      let url: string | null = null
      for (let i = 0; i < 100 && !url; i++) {
        url = devtoolsUrl(profile)
        if (!url) await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(url && (await listening(url)), 'Chrome is up with remote debugging')

      let owns = false
      const link: BrowserUseLink = {
        connect: async () => (await session.ensure(url!), { ok: true }),
        call: (name, args, signal) => session.call(name, args, signal),
        ownsTab: () => owns,
        setOwnsTab: (o) => (owns = o)
      }
      await session.ensure(url!)
      const offered = browserUseAgentTools(link, session.knownTools()!)
      assert.deepEqual(
        offered.map((t) => t.name),
        [...OFFERED],
        `Browser Use still has every tool Eaon offers`
      )
      const tools = new Map(offered.map((t) => [t.name, t]))
      const opened = await tools.get('browser_navigate')!.run({ url: shop }, ctx())
      assert.equal(typeof opened === 'object' && opened.isError, undefined, JSON.stringify(opened))
      // Read the page (Browser Use may need a moment after loading).
      let elements: { index: number; tag: string; text?: string }[] = []
      for (let i = 0; i < 10 && !elements.some((e) => /Save draft/.test(e.text ?? '')); i++) {
        const read = await tools.get('browser_get_state')!.run({}, ctx())
        elements = JSON.parse(typeof read === 'string' ? read : read.text).interactive_elements ?? []
        if (!elements.length) await new Promise((r) => setTimeout(r, 300))
      }
      const save = elements.find((e) => /Save draft/.test(e.text ?? ''))
      const order = elements.find((e) => /Place order/.test(e.text ?? ''))
      const card = elements.filter((e) => e.tag === 'input')[1]
      assert.ok(save && order && card, JSON.stringify(elements))
      assert.equal(tools.get('browser_click')!.risky!({ index: save!.index }, ctx()), false)
      assert.equal(tools.get('browser_click')!.catastrophic!({ index: order!.index }, ctx()), true, 'placing the order is never done unattended')
      assert.equal(tools.get('browser_type')!.catastrophic!({ index: card.index, text: '4111' }, ctx()), true, 'the card field, judged on the live page')
      const clicked = await tools.get('browser_click')!.run({ index: save!.index }, ctx())
      assert.equal(typeof clicked === 'object' && clicked.isError, undefined, JSON.stringify(clicked))
      const after = await tools.get('browser_get_state')!.run({}, ctx())
      assert.match(typeof after === 'string' ? after : after.text, /Draft saved/, 'the click ran in the page')
    } finally {
      await session.stop()
      // Ending the session leaves the user's browser running.
      await new Promise((r) => setTimeout(r, 500))
      assert.equal(chrome.exitCode, null, 'Chrome is still running')
      const exited = new Promise((r) => chrome.once('exit', r))
      chrome.kill()
      await exited
      site.close()
    }
  }
)
