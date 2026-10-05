/**
 * Launches the built Eaon app and drives it over the DevTools protocol.
 *
 * Each launch gets its own profile (`--user-data-dir`) and its own HOME, so
 * nothing reads or writes the user's real Eaon data, `~/Eaon` (Work's default
 * folder), `~/.claude` or `~/.codex`, and `--use-mock-keychain` keeps vault
 * writes away from the real keychain. The debug ports are picked by the OS
 * (`=0`) and read back from the app's own output, so runs never collide.
 *
 * Two ends are driven:
 * - pages (each window's renderer), through `--remote-debugging-port`;
 * - the main process, through Node's inspector (`--inspect`), where
 *   `includeCommandLineAPI` makes `require('electron')` available.
 *
 * Quitting closes the inspector socket right after `app.quit()`: with a
 * debugger attached, `--inspect` keeps the process alive ("Waiting for the
 * debugger to disconnect"), which looks exactly like a quit hang.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Cdp, callExpression, evaluate } from './cdp.mjs'

export const repo = resolve(import.meta.dirname, '../..')
const require = createRequire(join(repo, 'package.json'))
/** The real Electron binary. `node_modules/.bin/electron` is a wrapper whose death leaves Electron running. */
export const electronBinary = /** @type {string} */ (require('electron'))

/** Where profiles, logs and screenshots go. Inside out/ (gitignored) unless told otherwise. */
export const artifactsDir = resolve(process.env.EAON_E2E_ARTIFACTS || join(repo, 'out', 'e2e'))
export const screensDir = resolve(process.env.EAON_E2E_SCREENS || join(artifactsDir, 'screens'))
export const mainEntry = join(repo, 'out', 'main', 'index.js')

const isLinux = process.platform === 'linux'

/**
 * Every built-in local runtime. They are enabled by default and probed on
 * loopback at launch, so a developer's own Ollama, vLLM or even a running
 * Eaon's Local API Server (port 1337, Jan's default) would otherwise show up
 * as models. Each is pointed at a closed port before launch; `checkIsolated`
 * fails loudly if a new one appears in the catalog.
 */
export const LOCAL_RUNTIME_IDS = ['ollama', 'lm-studio', 'llama-cpp', 'mlx', 'vllm', 'jan']

/** A loopback port nothing listens on: connecting is refused straight away. */
export async function closedPort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)))
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  await new Promise((done) => server.close(() => done(undefined)))
  return port
}

/** @returns {{ pid: number, ppid: number, command: string }[]} */
function processTable() {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return out
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m?.[1]), ppid: Number(m?.[2]), command: String(m?.[3]) }))
  } catch {
    return []
  }
}

/** @param {number} root @param {ReturnType<typeof processTable>} table */
function descendants(root, table) {
  const found = []
  const queue = [root]
  while (queue.length) {
    const parent = queue.shift()
    for (const row of table) {
      if (row.ppid === parent) {
        found.push(row)
        queue.push(row.pid)
      }
    }
  }
  return found
}

/**
 * Writes JSON store files into a profile before launch, merged over what is
 * there (`store/providers.json`, `store/settings.json`, …).
 * @param {string} profileDir
 * @param {Record<string, Record<string, unknown>>} files
 */
function seedStore(profileDir, files) {
  const dir = join(profileDir, 'store')
  mkdirSync(dir, { recursive: true })
  for (const [name, value] of Object.entries(files)) {
    const path = join(dir, name)
    let current = {}
    try {
      current = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      /* new file */
    }
    const merged = { ...current }
    for (const [key, entry] of Object.entries(value)) {
      merged[key] = entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...(current[key] ?? {}), ...entry } : entry
    }
    writeFileSync(path, JSON.stringify(merged, null, 2))
  }
}

/**
 * @typedef {{
 *   name: string,
 *   profileDir: string,
 *   homeDir: string,
 *   fresh?: boolean,
 *   offlinePort?: number,
 *   seed?: Record<string, Record<string, unknown>>,
 *   args?: string[],
 *   env?: Record<string, string>,
 *   startTimeout?: number
 * }} LaunchOptions
 */

/**
 * Starts the built app and connects to its main process and first window.
 * @param {LaunchOptions} options
 */
export async function launchApp(options) {
  const { name, profileDir, homeDir, fresh = true, args = [], env = {}, startTimeout = 45_000 } = options
  if (!existsSync(mainEntry)) throw new Error(`No build at ${mainEntry}. Run \`npx electron-vite build\` (npm run test:e2e does it for you).`)
  if (fresh) {
    rmSync(profileDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  }
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  const offlinePort = options.offlinePort ?? (await closedPort())
  if (fresh) {
    const isolated = Object.fromEntries(LOCAL_RUNTIME_IDS.map((id) => [id, { baseUrl: `http://127.0.0.1:${offlinePort}/v1` }]))
    seedStore(profileDir, { 'providers.json': isolated })
  }
  if (options.seed) seedStore(profileDir, options.seed)

  const childEnv = { ...process.env, HOME: homeDir, ...env }
  // Any of these would change what launches: a node instead of Electron, a
  // dev server's page, or the screenshot harness (which wipes the store).
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'EAON_CAPTURE', 'EAON_CAPTURE_STEPS', 'NODE_OPTIONS']) delete childEnv[key]
  if (isLinux) {
    childEnv.XDG_CONFIG_HOME = join(homeDir, '.config')
    childEnv.XDG_DATA_HOME = join(homeDir, '.local', 'share')
    childEnv.XDG_CACHE_HOME = join(homeDir, '.cache')
  }

  const child = spawn(
    electronBinary,
    [
      mainEntry,
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      '--inspect=0',
      '--use-mock-keychain',
      // A window behind another one would otherwise stop painting and
      // running timers, and screenshots of it would hang.
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      ...(isLinux ? ['--no-sandbox', '--password-store=basic', '--disable-gpu', '--disable-dev-shm-usage'] : []),
      ...args
    ],
    { cwd: repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const app = new App({ ...options, offlinePort }, child)
  try {
    await app.connect(startTimeout)
  } catch (error) {
    await app.dispose({ reason: 'failed to start' })
    throw error
  }
  return app
}

export class App {
  /** @param {LaunchOptions & { offlinePort: number }} options @param {import('node:child_process').ChildProcess} child */
  constructor(options, child) {
    this.options = options
    this.name = options.name
    this.profileDir = options.profileDir
    this.homeDir = options.homeDir
    this.offlinePort = options.offlinePort
    this.child = child
    this.pid = /** @type {number} */ (child.pid)
    this.log = ''
    this.startedAt = Date.now()
    /** @type {{ code: number | null, signal: string | null } | null} */
    this.exit = null
    this.exited = new Promise((done) =>
      child.once('exit', (code, signal) => {
        this.exit = { code, signal }
        done(this.exit)
      })
    )
    /** @type {Map<number, string>} Every process seen under the app, for the orphan check. */
    this.seen = new Map()
    /** @type {Map<string, Page>} */
    this.pagesById = new Map()
    /** @type {Cdp | null} */
    this.mainCdp = null
    this.devtoolsUrl = ''
    this.inspectorUrl = ''
    const onData = (data) => {
      this.log += String(data)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    // Helpers come and go (a shell for a command, a GPU process restart);
    // sampling keeps the orphan check honest about what was ever started.
    this.sampler = setInterval(() => this.sample(), 2000)
    this.sampler.unref()
  }

  get running() {
    return this.exit === null
  }

  sample() {
    if (!this.running) return
    for (const row of descendants(this.pid, processTable())) this.seen.set(row.pid, row.command)
  }

  /** @param {number} timeout */
  async connect(timeout) {
    const deadline = Date.now() + timeout
    while (!this.devtoolsUrl || !this.inspectorUrl) {
      if (!this.running) throw new Error(`${this.name}: Eaon exited during startup (${JSON.stringify(this.exit)}).\n${this.tail()}`)
      if (Date.now() > deadline) throw new Error(`${this.name}: no debug ports within ${timeout} ms.\n${this.tail()}`)
      this.devtoolsUrl ||= /DevTools listening on (ws:\/\/\S+)/.exec(this.log)?.[1] ?? ''
      this.inspectorUrl ||= /Debugger listening on (ws:\/\/\S+)/.exec(this.log)?.[1] ?? ''
      await sleep(50)
    }
    this.devtoolsPort = Number(new URL(this.devtoolsUrl).port)
    this.mainCdp = await Cdp.connect(this.inspectorUrl, `${this.name}/main`)
    await this.waitForPages(1, deadline - Date.now())
    this.sample()
  }

  /** Last lines of the app's output, for failure messages. */
  tail(lines = 40) {
    return this.log.split('\n').slice(-lines).join('\n')
  }

  /**
   * Runs `fn` in the main process. `require` is available inside it.
   * @template T
   * @param {(...args: any[]) => T | Promise<T>} fn
   * @param {...unknown} args
   * @returns {Promise<T>}
   */
  main(fn, ...args) {
    if (!this.mainCdp) throw new Error(`${this.name}: not connected to the main process`)
    return evaluate(this.mainCdp, callExpression(fn, args), { commandLineApi: true })
  }

  /** Page targets of Eaon's own windows (not webviews, not the agent's browser). */
  async targets() {
    const response = await fetch(`http://127.0.0.1:${this.devtoolsPort}/json/list`)
    /** @type {{ id: string, type: string, url: string, webSocketDebuggerUrl: string }[]} */
    const list = await response.json()
    return list.filter((t) => t.type === 'page' && /\/renderer\/index\.html/.test(t.url))
  }

  /** Waits until at least `count` app windows exist and returns their pages, oldest first. */
  async waitForPages(count, timeout = 20_000) {
    const deadline = Date.now() + timeout
    for (;;) {
      if (!this.running) throw new Error(`${this.name}: Eaon exited (${JSON.stringify(this.exit)}).\n${this.tail()}`)
      let targets = []
      try {
        targets = await this.targets()
      } catch {
        /* endpoint not up yet */
      }
      if (targets.length >= count) {
        for (const target of targets) {
          if (!this.pagesById.has(target.id)) {
            const cdp = await Cdp.connect(target.webSocketDebuggerUrl, `${this.name}/page${this.pagesById.size + 1}`)
            const page = new Page(this, target.id, cdp)
            await page.init()
            this.pagesById.set(target.id, page)
          }
        }
        const live = new Set(targets.map((t) => t.id))
        return [...this.pagesById.values()].filter((p) => live.has(p.targetId))
      }
      if (Date.now() > deadline) throw new Error(`${this.name}: expected ${count} window(s) within ${timeout} ms, found ${targets.length}`)
      await sleep(100)
    }
  }

  /** Waits until exactly `count` app windows are open (after one closes). */
  async waitForWindowCount(count, timeout = 10_000) {
    const deadline = Date.now() + timeout
    let found = -1
    while (Date.now() < deadline) {
      found = (await this.targets()).length
      if (found === count) return
      await sleep(100)
    }
    throw new Error(`${this.name}: expected ${count} window(s), still ${found} after ${timeout} ms`)
  }

  /** The first window's page. */
  get page() {
    const first = this.pagesById.values().next().value
    if (!first) throw new Error(`${this.name}: no window`)
    return first
  }

  /** Opens another Eaon window (as File → New Window does) and returns its page once it has rendered. */
  async openWindow() {
    const before = new Set((await this.targets()).map((t) => t.id))
    await this.page.eval(() => window.api.window.open())
    const pages = await this.waitForPages(before.size + 1)
    const page = pages.find((p) => !before.has(p.targetId))
    if (!page) throw new Error(`${this.name}: the new window has no page`)
    await page.waitForApp()
    return page
  }

  /** Errors and uncaught exceptions any window reported. */
  pageErrors() {
    return [...this.pagesById.values()].flatMap((p) => p.errors)
  }

  /**
   * Quits the way the menu's Quit does and waits for the process to exit.
   *
   * Two times come back. `appMs` is Eaon's own quit: from app.quit() to
   * Node's `exit`, after the held before-quit and will-quit (see "Quitting:
   * held before-quit, will-quit and app.exit"). `ms` is until the process is
   * gone; Electron's native teardown after `exit` is usually ~100 ms but was
   * seen taking 2–17 s on a machine with a load average of 150, so it gets
   * its own, generous timeout.
   * @returns {Promise<{ code: number | null, signal: string | null, ms: number, appMs: number | null }>}
   */
  async quit({ timeout = 60_000 } = {}) {
    if (!this.running) return { ...(this.exit ?? { code: null, signal: null }), ms: 0, appMs: null }
    this.sample()
    const started = Date.now()
    // Scheduled, so the evaluation returns before the quit begins. The quit's
    // stages go to the app's output, so a slow or stuck quit says where it was.
    // (`require` only exists while the evaluation runs, so it is taken first.)
    await this.main(() => {
      const { app, BrowserWindow } = require('electron')
      const t0 = Date.now()
      const mark = (stage) => console.log(`[e2e] quit: ${stage} at +${Date.now() - t0} ms (${BrowserWindow.getAllWindows().length} windows)`)
      for (const stage of ['before-quit', 'window-all-closed', 'will-quit', 'quit']) app.on(stage, () => mark(stage))
      process.on('exit', () => mark('exit'))
      setTimeout(() => app.quit(), 0)
      return true
    })
    this.closeConnections()
    const result = await Promise.race([this.exited, sleep(timeout).then(() => null)])
    if (!result) {
      this.child.kill('SIGKILL')
      await this.exited
      throw new Error(`${this.name}: did not exit within ${timeout} ms of app.quit() (killed).\n${this.tail()}`)
    }
    const appMs = /\[e2e\] quit: exit at \+(\d+) ms/.exec(this.log)?.[1]
    return { ...result, ms: Date.now() - started, appMs: appMs === undefined ? null : Number(appMs) }
  }

  /** Kills the app as a crash would: SIGKILL, no cleanup. */
  async kill() {
    if (!this.running) return
    this.sample()
    this.closeConnections()
    this.child.kill('SIGKILL')
    await this.exited
  }

  closeConnections() {
    clearInterval(this.sampler)
    for (const page of this.pagesById.values()) page.cdp.close()
    this.mainCdp?.close()
  }

  /**
   * Waits for every process the app started to be gone; kills and returns
   * whatever is left. Electron helpers carry the profile path on their
   * command line, so those are caught even if sampling missed them.
   */
  async orphans(timeout = 8000) {
    const deadline = Date.now() + timeout
    let left = []
    do {
      const table = processTable()
      left = table.filter(
        (row) => row.pid !== process.pid && ((this.seen.has(row.pid) && this.seen.get(row.pid) === row.command) || row.command.includes(this.profileDir))
      )
      if (left.length === 0) return []
      await sleep(200)
    } while (Date.now() < deadline)
    for (const row of left) {
      try {
        process.kill(row.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    return left.map((row) => `${row.pid} ${row.command.slice(0, 200)}`)
  }

  /** Kills the app if it is still running and saves its output to the logs folder. */
  async terminate({ reason = 'teardown' } = {}) {
    clearInterval(this.sampler)
    if (this.running) {
      this.sample()
      this.closeConnections()
      this.child.kill('SIGKILL')
      await Promise.race([this.exited, sleep(5000)])
    }
    try {
      mkdirSync(join(artifactsDir, 'logs'), { recursive: true })
      writeFileSync(join(artifactsDir, 'logs', `${this.name}.log`), `# ${reason}\n${this.log}`)
    } catch {
      /* logging is best effort */
    }
  }

  /**
   * Ends the app however it is and checks nothing is left behind. With
   * several apps on one profile, terminate them all before checking any.
   * @returns {Promise<string[]>} orphaned processes (already killed)
   */
  async dispose({ reason = 'teardown' } = {}) {
    await this.terminate({ reason })
    return this.orphans()
  }

  /**
   * Starts Eaon again on the same profile and HOME (after a quit or a kill).
   * @param {Partial<LaunchOptions>} [overrides]
   */
  async relaunch(overrides = {}) {
    if (this.running) throw new Error(`${this.name}: relaunch while still running`)
    return launchApp({ ...this.options, ...overrides, fresh: false, name: overrides.name ?? `${this.name}-again` })
  }

  /** A file in the profile's store, parsed (`chats.json`, `settings.json`, …). */
  readStore(file) {
    const path = join(this.profileDir, 'store', file)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  }
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  Comma: { key: ',', code: 'Comma', windowsVirtualKeyCode: 188 },
  a: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }
}
const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

export class Page {
  /** @param {App} app @param {string} targetId @param {Cdp} cdp */
  constructor(app, targetId, cdp) {
    this.app = app
    this.targetId = targetId
    this.cdp = cdp
    /** @type {string[]} */
    this.errors = []
  }

  async init() {
    this.cdp.on('Runtime.exceptionThrown', (p) => this.errors.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`))
    this.cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') this.errors.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500)}`)
    })
    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Page.enable')
    // Keyboard events and :focus behave as if the window were in front, which
    // it may not be while several windows (or the developer's editor) are open.
    await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
  }

  /**
   * Runs `fn` in the page and returns its (JSON) value; awaits a Promise.
   * @template T
   * @param {(...args: any[]) => T | Promise<T>} fn
   * @param {...unknown} args
   * @returns {Promise<T>}
   */
  eval(fn, ...args) {
    return evaluate(this.cdp, callExpression(fn, args))
  }

  /**
   * Polls `fn` until it returns something truthy and returns that. An async
   * `fn` is awaited on every try (unlike waitForFunction, which treats the
   * Promise itself as truthy). Errors while polling (a reload in progress)
   * count as "not yet".
   * @template T
   * @param {(...args: any[]) => T | Promise<T>} fn
   * @param {{ args?: unknown[], timeout?: number, interval?: number, message?: string }} [options]
   * @returns {Promise<NonNullable<Awaited<T>>>}
   */
  async waitFor(fn, { args = [], timeout = 15_000, interval = 100, message = '' } = {}) {
    const deadline = Date.now() + timeout
    let last
    let lastError
    for (;;) {
      try {
        last = await evaluate(this.cdp, callExpression(fn, args), { timeout: Math.max(1000, Math.min(10_000, deadline - Date.now())) })
        if (last) return last
      } catch (error) {
        lastError = error
        if (this.cdp.closed) throw error
      }
      if (Date.now() > deadline) {
        const why = message || fn.toString().slice(0, 200)
        throw new Error(`${this.cdp.label}: timed out after ${timeout} ms waiting for ${why}` + (lastError ? `\n  last error: ${lastError.message}` : `\n  last value: ${JSON.stringify(last)}`))
      }
      await sleep(interval)
    }
  }

  /** Waits until the app has rendered its shell after a load or reload. */
  waitForApp(timeout = 30_000) {
    return this.waitFor(() => document.readyState === 'complete' && Boolean(window.api) && document.querySelector('#root')?.childElementCount > 0 && Boolean(document.querySelector('.mode-switch, .composer__input, .settings')), {
      timeout,
      message: 'the app to render'
    })
  }

  async reload() {
    await this.cdp.send('Page.reload', { ignoreCache: false })
    // The old document can still answer for a moment after the reload is sent.
    await sleep(150)
    await this.waitForApp()
  }

  /**
   * Finds a visible element by CSS selector, optionally the one whose text
   * matches, and returns where it is.
   * @param {string} selector
   * @param {{ text?: string | RegExp, timeout?: number, enabled?: boolean }} [options]
   */
  async find(selector, { text, timeout = 10_000, enabled = false } = {}) {
    const textSource = text instanceof RegExp ? { source: text.source, flags: text.flags } : text === undefined ? null : { literal: text }
    return this.waitFor(
      (selector, textSource, enabled) => {
        const matches = (el) => {
          if (!textSource) return true
          const content = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()
          return textSource.literal !== undefined ? content.includes(textSource.literal) : new RegExp(textSource.source, textSource.flags).test(content)
        }
        for (const el of document.querySelectorAll(selector)) {
          if (!matches(el)) continue
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue
          if (enabled && (el.disabled || el.getAttribute('aria-disabled') === 'true')) continue
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, text: (el.innerText || '').trim().slice(0, 80) }
        }
        return null
      },
      { args: [selector, textSource, enabled], timeout, message: `${selector}${text ? ` with text ${text}` : ''}${enabled ? ' (enabled)' : ''}` }
    )
  }

  /**
   * Clicks an element the way a person would: scrolled into view, a real
   * mouse press at its centre. Fails if something else covers that point.
   * @param {string} selector
   * @param {{ text?: string | RegExp, timeout?: number, enabled?: boolean }} [options]
   */
  async click(selector, options = {}) {
    await this.find(selector, { enabled: true, ...options })
    const textSource = options.text instanceof RegExp ? { source: options.text.source, flags: options.text.flags } : options.text === undefined ? null : { literal: options.text }
    const point = await this.eval(
      (selector, textSource) => {
        const matches = (el) => {
          if (!textSource) return true
          const content = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()
          return textSource.literal !== undefined ? content.includes(textSource.literal) : new RegExp(textSource.source, textSource.flags).test(content)
        }
        const el = [...document.querySelectorAll(selector)].find((e) => matches(e) && e.getBoundingClientRect().width > 0)
        if (!el) return { error: 'gone' }
        el.scrollIntoView({ block: 'center', inline: 'center' })
        const rect = el.getBoundingClientRect()
        const x = rect.x + rect.width / 2
        const y = rect.y + rect.height / 2
        const hit = document.elementFromPoint(x, y)
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
          return { error: `covered by <${hit.tagName.toLowerCase()} class="${hit.className}">` }
        }
        return { x, y }
      },
      selector,
      textSource
    )
    if ('error' in point) throw new Error(`${this.cdp.label}: cannot click ${selector}${options.text ? ` (${options.text})` : ''}: ${point.error}`)
    await this.mouse(point.x, point.y)
  }

  /** A real left click at a point in the page. */
  async mouse(x, y) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }

  /** Types into whatever has focus, as an input method would (React sees onChange). */
  async type(text) {
    await this.cdp.send('Input.insertText', { text })
  }

  /** Focuses a field, clears it and types. */
  async fill(selector, text, options = {}) {
    await this.click(selector, options)
    await this.eval((selector) => {
      const el = document.activeElement?.matches(selector) ? document.activeElement : document.querySelector(selector)
      el?.focus()
      el?.select?.()
    }, selector)
    await this.type(text)
  }

  /**
   * Presses a key, with optional modifiers: `press('Enter')`, `press('Meta+Comma')`.
   * @param {string} combo
   */
  async press(combo) {
    const parts = combo.split('+')
    const keyName = parts.pop() ?? ''
    const modifiers = parts.reduce((sum, m) => sum | (MODIFIERS[/** @type {keyof typeof MODIFIERS} */ (m)] ?? 0), 0)
    const key = KEYS[/** @type {keyof typeof KEYS} */ (keyName)] ?? { key: keyName, code: `Key${keyName.toUpperCase()}`, windowsVirtualKeyCode: keyName.toUpperCase().charCodeAt(0), text: keyName }
    const text = modifiers & ~MODIFIERS.Shift ? undefined : key.text
    await this.cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', modifiers, ...key, text, unmodifiedText: text })
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...key, text: undefined })
  }

  /**
   * Saves a PNG of the window into the screenshots folder and returns its path.
   * Falls back to the main process's capturePage if DevTools gets no frame.
   * @param {string} name
   */
  async screenshot(name) {
    mkdirSync(screensDir, { recursive: true })
    const path = join(screensDir, `${name.replace(/[^a-z0-9._-]+/gi, '-')}.png`)
    let data
    try {
      data = (await this.cdp.send('Page.captureScreenshot', { format: 'png' }, { timeout: 10_000 })).data
    } catch {
      data = await this.app.main(async (targetId) => {
        const { webContents } = require('electron')
        const contents = webContents.fromDevToolsTargetId(targetId)
        return contents ? (await contents.capturePage()).toPNG().toString('base64') : null
      }, this.targetId)
    }
    if (data) writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }

  /**
   * Resizes this window's content area (the real window, not an emulated
   * viewport). The app's minimum size still applies, as it does for a person
   * dragging the corner; returns the size it ended up.
   */
  async resize(width, height) {
    const size = await this.app.main(
      (targetId, width, height) => {
        const { webContents, BrowserWindow } = require('electron')
        const contents = webContents.fromDevToolsTargetId(targetId)
        const window = contents && BrowserWindow.fromWebContents(contents)
        if (!window) throw new Error('no window for this page')
        window.setContentSize(width, height)
        return window.getContentSize()
      },
      this.targetId,
      width,
      height
    )
    await this.waitFor((width) => Math.abs(window.innerWidth - width) <= 2, { args: [size[0]], message: `the page to be ${size[0]}px wide` })
    return { width: size[0], height: size[1] }
  }

  /** The window's minimum size as the app set it. */
  minimumSize() {
    return this.app.main((targetId) => {
      const { webContents, BrowserWindow } = require('electron')
      const contents = webContents.fromDevToolsTargetId(targetId)
      return BrowserWindow.fromWebContents(contents).getMinimumSize()
    }, this.targetId)
  }
}
