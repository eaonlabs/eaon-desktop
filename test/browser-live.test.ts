import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import type { BrowserBridgeStatus, PairingCode } from '@shared/browserBridge'
import type { StreamEvent, StreamRequest } from '@shared/types'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import { store } from '../src/main/store'
import { __bridgeForTests, browserBridgeFeature } from '../src/main/features/browserBridge'
import type { FeatureContext } from '../src/main/features/types'

/**
 * Browser control for real: the shipped extension (extension/) loaded into an
 * isolated Chrome for Testing profile, paired through its own popup the way a
 * user would, and driven by the real agent on a local model to fill in and
 * submit a form on a local page. Nothing touches the user's own Chrome.
 *
 * Opt-in: EAON_LIVE=1, Ollama with EAON_LIVE_MODEL (default qwen3.5:9b), and
 * Chrome for Testing (Playwright's download, or EAON_TEST_CHROME).
 */

const MODEL = process.env.EAON_LIVE_MODEL ?? 'qwen3.5:9b'
const CHROME =
  process.env.EAON_TEST_CHROME ??
  join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const EXTENSION = resolve(import.meta.dirname, '../../extension')

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => done(port))
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until<T>(what: string, check: () => Promise<T | null | undefined> | T | null | undefined, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

/** One Runtime.evaluate over the DevTools protocol, on a page target. */
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

test('the agent completes a web form through the real extension', { skip: !process.env.EAON_LIVE, timeout: 900_000 }, async (t) => {
  if (!existsSync(CHROME)) return t.skip('Chrome for Testing not found')
  try {
    const tags = (await (await fetch('http://127.0.0.1:11434/api/tags')).json()) as { models: { name: string }[] }
    if (!tags.models.some((m) => m.name === MODEL)) return t.skip(`${MODEL} not in Ollama`)
  } catch {
    return t.skip('Ollama not running')
  }

  // A harmless local "workflow": type a name, submit, read the confirmation.
  const submissions: string[] = []
  const site = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    if (url.pathname === '/hello') {
      submissions.push(url.searchParams.get('name') ?? '')
      res.end(`<!doctype html><title>Welcome</title><h1>Hello, ${url.searchParams.get('name')}!</h1><p>Your confirmation code is 4217.</p>`)
    } else {
      res.end('<!doctype html><title>Sign the guestbook</title><h1>Guestbook</h1><form action="/hello"><label>Your name <input name="name"></label> <button>Sign</button></form>')
    }
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`

  // Eaon's side: the real bridge feature against a stub Electron context.
  const bridgePort = await freePort()
  store.patchSettings({ browserExtension: { enabled: true, port: bridgePort }, approvalMode: 'auto' })
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ctx: FeatureContext = {
    ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn), on: () => {} } as never,
    getWindow: () => null,
    send: () => {},
    emitStream: () => {}
  }
  await browserBridgeFeature.register(ctx)
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => (await handlers.get(channel)!({}, ...args)) as T

  // The browser: an isolated profile with only our extension.
  const profile = mkdtempSync(join(tmpdir(), 'eaon-chrome-'))
  const devtools = await freePort()
  let chrome: ChildProcess | null = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${devtools}`,
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  try {
    const worker = await until('the extension service worker', async () => {
      const targets = (await (await fetch(`http://127.0.0.1:${devtools}/json/list`).catch(() => null))?.json().catch(() => [])) as
        | { type: string; url: string }[]
        | undefined
      // Ours by its worker script; Chrome runs component extensions of its own.
      return targets?.find((target) => target.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(target.url))
    })
    const extensionId = new URL(worker.url).host

    // Pair the way a user does: open the popup, type the code, press Pair.
    const code = await invoke<PairingCode>('browser-bridge:pairing-code', true)
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
    const status = await until('the extension to pair and connect', async () => {
      const s = await invoke<BrowserBridgeStatus>('browser-bridge:status')
      return s.connected ? s : null
    }).catch(async (error) => {
      // Say what the popup shows, so a failure here is diagnosable.
      const shown = await evaluate(
        popup.webSocketDebuggerUrl,
        `JSON.stringify({ error: document.getElementById('pair-error')?.textContent, status: document.body.innerText.slice(0, 300) })`
      ).catch(() => 'popup unreachable')
      throw new Error(`${(error as Error).message}; popup says ${String(shown)}`)
    })
    console.log('paired:', JSON.stringify(status.client))

    // The agent does the workflow.
    const events: StreamEvent[] = []
    const request: StreamRequest = {
      chatId: 'browser-live',
      messageId: `m${Date.now()}`,
      providerId: 'ollama',
      modelId: MODEL,
      effort: 'medium',
      mode: 'work',
      history: [
        {
          id: 'u1',
          role: 'user',
          createdAt: 0,
          parts: [
            {
              type: 'text',
              text: `Use the browser tool: open ${siteUrl} , type the name Ada into the form, submit it, and tell me the confirmation code the next page shows.`
            }
          ]
        }
      ],
      summary: null,
      projectInstructions: '',
      cwd: mkdtempSync(join(tmpdir(), 'eaon-browser-live-')),
      work: { swarm: false, plan: false },
      goal: null
    }
    const outcome = await runAgent(request, (e) => events.push(e), { approver: async () => true })
    const actions = events
      .filter((e) => e.type === 'tool-call')
      .map((e) => `${(e as { name: string }).name}:${String((e as { input: Record<string, unknown> }).input.action ?? '')}`)
    console.log('actions:', actions.join(' → '), '| usage:', JSON.stringify(outcome.usage))
    console.log('answer:', outcome.text.slice(-400))
    assert.equal(outcome.error, undefined)
    assert.deepEqual(submissions, ['Ada'], 'the form was really submitted, once, with the name')
    assert.match(outcome.text, /4217/, 'the agent read the result off the page')
    assert.ok(actions.some((a) => a.startsWith('browser:')), 'used the browser tool')
  } finally {
    chrome?.kill()
    chrome = null
    browserBridgeFeature.dispose?.()
    await __bridgeForTests()?.stop()
    site.close()
    await sleep(500)
    rmSync(profile, { recursive: true, force: true })
  }
})
