import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { BrowserBridge, type PairingRecord } from '../src/main/features/browser/server'
import { createBrowserTool } from '../src/main/features/browser/tool'

/**
 * Extension 1.1 for real, without a model: a copy of extension/ loaded into
 * an isolated Chrome for Testing profile, paired through its own popup, and
 * driven through the agent's actual `browser` tool — read, find, fill,
 * reload, relative navigation — against a local site. Then the self-update:
 * the copy's version is bumped on disk, the app asks, and the extension must
 * come back as the new version on the same pairing. Nothing touches the
 * user's own browser.
 *
 * It is installed the way a user installs it — Developer mode on, then Load
 * unpacked (CDP Extensions.loadUnpacked) — not with --load-extension:
 * Chrome disables a reloaded unpacked extension ("unsupportedDeveloperExtension")
 * when Developer mode is off, which only happens to command-line installs.
 *
 * Opt-in: EAON_LIVE=1 and Chrome for Testing (Playwright's download, or EAON_TEST_CHROME).
 */

const CHROME =
  process.env.EAON_TEST_CHROME ??
  join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const EXTENSION = resolve(import.meta.dirname, '../../extension')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => done(port))
    })
  })
}

async function until<T>(what: string, check: () => Promise<T | null | undefined> | T | null | undefined, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(200)
  }
}

async function evaluate(wsUrl: string, expression: string): Promise<unknown> {
  const ws = new WebSocket(wsUrl)
  await new Promise((r, j) => ws.once('open', r).once('error', j))
  const reply = await new Promise<{ result?: { result?: { value?: unknown } } }>((r) => {
    ws.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.id === 1) r(message)
    })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  return reply.result?.result?.value
}

const ARTICLE = `<!doctype html><title>Field guide</title>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<main>
  <h1>Field guide</h1>
  <p>Everything about the <a href="/pricing">pricing plans</a> and how to sign up.</p>
  <h2>Plans</h2>
  <ul><li>Starter — free</li><li>Pro — $12 a month</li></ul>
  <table><tr><th>Plan</th><th>Seats</th></tr><tr><td>Starter</td><td>1</td></tr><tr><td>Pro</td><td>10</td></tr></table>
  ${'<p>Filler paragraph about the product, repeated so the page is long enough to page through.</p>'.repeat(200)}
  <h2>Refund policy</h2>
  <p>Refunds are available within 30 days.</p>
  <h2>Sign up</h2>
  <form action="/done">
    <label>Your name <input name="name"></label>
    <label>Email <input name="email" type="email"></label>
    <label>Plan <select name="plan"><option>Starter</option><option>Pro</option></select></label>
    <button>Create account</button>
  </form>
</main>`

test('extension 1.1 reads, finds, fills and updates itself in real Chrome', { skip: !process.env.EAON_LIVE, timeout: 300_000 }, async (t) => {
  if (!existsSync(CHROME)) return t.skip('Chrome for Testing not found')

  const submissions: Record<string, string>[] = []
  const site = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (url.pathname === '/done') {
      submissions.push(Object.fromEntries(url.searchParams))
      res.end(`<!doctype html><title>Welcome</title><h1>Welcome, ${url.searchParams.get('name')}</h1>`)
    } else res.end(ARTICLE)
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`

  // A copy the test can bump, standing in for the folder the app keeps current.
  const work = mkdtempSync(join(tmpdir(), 'eaon-ext-live-'))
  const folder = join(work, 'extension')
  cpSync(EXTENSION, folder, { recursive: true })
  const manifestPath = join(folder, 'manifest.json')
  const version = (): string => (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }).version
  const startVersion = version()

  let record: PairingRecord | null = null
  const bridge = new BrowserBridge({
    appVersion: 'test',
    store: { load: () => record, save: (next) => (record = next) },
    bundledVersion: version
  })
  const bridgePort = await freePort()
  await bridge.start(bridgePort)
  const { tool } = createBrowserTool(bridge)
  const run = async (input: Record<string, unknown>): Promise<string> => {
    const result = await tool.run(input, { signal: new AbortController().signal } as never)
    if (result.isError) throw new Error(`${String(input.action)}: ${result.text}`)
    return result.text
  }

  const devtools = await freePort()
  const profile = join(work, 'profile')
  let chrome: ChildProcess | null = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${devtools}`,
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
  )
  // Browser-level CDP over the pipe: NUL-terminated JSON, fd 3 in, fd 4 out.
  const pipeIn = chrome.stdio[3] as NodeJS.WritableStream
  const pipeOut = chrome.stdio[4] as NodeJS.ReadableStream
  let pipeBuffer = ''
  let pipeId = 0
  const pipeWaiting = new Map<number, (message: { result?: Record<string, unknown>; error?: { message: string } }) => void>()
  pipeOut.on('data', (chunk) => {
    pipeBuffer += String(chunk)
    for (let at = pipeBuffer.indexOf('\0'); at >= 0; at = pipeBuffer.indexOf('\0')) {
      const message = JSON.parse(pipeBuffer.slice(0, at))
      pipeBuffer = pipeBuffer.slice(at + 1)
      pipeWaiting.get(message.id)?.(message)
      pipeWaiting.delete(message.id)
    }
  })
  const cdp = (method: string, params: Record<string, unknown> = {}): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> =>
    new Promise((done) => {
      const id = ++pipeId
      pipeWaiting.set(id, done)
      pipeIn.write(`${JSON.stringify({ id, method, params })}\0`)
    })

  try {
    // Developer mode, then Load unpacked — the user's own two steps.
    await until('Chrome', async () => (await fetch(`http://127.0.0.1:${devtools}/json/version`).catch(() => null))?.ok)
    const settingsPage = (await (await fetch(`http://127.0.0.1:${devtools}/json/new?chrome://extensions`, { method: 'PUT' })).json()) as {
      webSocketDebuggerUrl: string
    }
    await sleep(1000)
    await evaluate(settingsPage.webSocketDebuggerUrl, 'new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => r(true)))')
    const loaded = await cdp('Extensions.loadUnpacked', { path: folder })
    assert.ok(loaded.result?.id, `Load unpacked failed: ${loaded.error?.message}`)
    const extensionId = String(loaded.result.id)

    // Pair through the popup, as a user would.
    const code = bridge.pairingCode(true)
    const popup = (await (
      await fetch(`http://127.0.0.1:${devtools}/json/new?chrome-extension://${extensionId}/popup/popup.html`, { method: 'PUT' })
    ).json()) as { webSocketDebuggerUrl: string }
    await sleep(800)
    await evaluate(
      popup.webSocketDebuggerUrl,
      `(() => {
        const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }
        set(document.getElementById('port'), '${bridgePort}')
        set(document.getElementById('code'), '${code.code}')
        document.getElementById('pair-form').requestSubmit()
        return true
      })()`
    )
    await until('pairing', () => bridge.connected)
    const status = bridge.status()
    console.log('connected:', JSON.stringify(status.client), 'canSelfUpdate', status.canSelfUpdate)
    assert.equal(status.client?.installType, 'development', 'loaded unpacked')
    assert.equal(status.canSelfUpdate, true)
    for (const action of ['read', 'find', 'fill', 'reload'] as const) assert.equal(bridge.supports(action), true, action)

    // read: the page as Markdown, paged.
    await run({ action: 'navigate', url: `${siteUrl}/article` })
    const page1 = await run({ action: 'read' })
    console.log('read page 1:\n', page1.slice(0, 600))
    assert.match(page1, /^# Field guide$/m, 'headings as Markdown')
    assert.match(page1, /\[pricing plans\]\(\/pricing\)/, 'links inline')
    assert.match(page1, /^- Pro — \$12 a month$/m, 'list items')
    assert.match(page1, /^\| Pro \| 10 \|$/m, 'table rows')
    assert.doesNotMatch(page1, /About/, 'main content only: the nav is left out')
    const offset = /read again with offset (\d+)/.exec(page1)
    assert.ok(offset, 'a long page comes in parts')
    const page2 = await run({ action: 'read', offset: Number(offset[1]) })
    assert.match(page2, /Refunds are available within 30 days/)

    // find: text and controls, with refs that work.
    const found = await run({ action: 'find', text: 'refund' })
    console.log('find:\n', found)
    assert.match(found, /Found 2 matches/)
    const createButton = /\[(\d+)\] button "Create account"/.exec(await run({ action: 'find', text: 'create account' }))
    assert.ok(createButton, 'find hands out a ref for a matching control')

    // fill: several fields, text and select, in one step.
    const snapshot = await run({ action: 'snapshot' })
    const ref = (name: string): number => Number(new RegExp(`\\[(\\d+)\\] \\w+ "${name}`).exec(snapshot)?.[1])
    const filled = await run({
      action: 'fill',
      fields: [
        { ref: ref('Your name'), text: 'Ada' },
        { ref: ref('Email'), text: 'ada@example.com' },
        { ref: ref('Plan'), text: 'Pro' }
      ]
    })
    console.log('fill:', filled)
    assert.match(filled, /Typed into .*Typed into .*Selected "Pro"/)
    await run({ action: 'click', ref: Number(createButton[1]) })
    await until('the form submission', () => submissions.length > 0, 10_000)
    assert.deepEqual(submissions[0], { name: 'Ada', email: 'ada@example.com', plan: 'Pro' })

    // reload, and a path relative to the current page.
    assert.match(await run({ action: 'reload' }), /Reloaded .*Welcome/)
    assert.match(await run({ action: 'navigate', url: '/article' }), new RegExp(`${siteUrl}/article`))

    // Self-update: the folder gets a newer version; the app asks; the
    // extension reloads from disk and reconnects on the same pairing.
    const tokenBefore = record?.tokenHash
    const [major, minor, patch] = startVersion.split('.').map(Number)
    const next = `${major}.${minor}.${patch + 1}`
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: next }, null, 2))
    assert.equal(bridge.requestUpdate(), true)
    await until(`the extension to come back as ${next}`, () => bridge.connected && bridge.extensionVersion === next, 30_000).catch(async (error) => {
      // Say what the reloaded worker thinks, so a failure here is diagnosable.
      const targets = (await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
      const sw = targets.find((target) => target.type === 'service_worker' && target.url.includes(extensionId))
      const inside = sw
        ? await evaluate(sw.webSocketDebuggerUrl, `(async () => JSON.stringify({ version: chrome.runtime.getManifest().version, local: await chrome.storage.local.get(null) }))()`).catch((e) => String(e))
        : 'no service worker'
      throw new Error(`${(error as Error).message}; bridge ${JSON.stringify(bridge.status())}; worker ${String(inside).replace(/"token":"[^"]+"/, '"token":"…"')}`)
    })
    console.log('updated to', bridge.extensionVersion, 'update state', bridge.status().update)
    assert.equal(record?.tokenHash, tokenBefore, 'the pairing survived the update')
    assert.equal(bridge.status().update, 'idle')

    // The tab the old version injected into is served by the new version's script.
    assert.match(await run({ action: 'read' }), /# Field guide/)
  } finally {
    chrome?.kill()
    chrome = null
    await bridge.stop()
    site.close()
    await sleep(500)
    rmSync(work, { recursive: true, force: true })
  }
})
