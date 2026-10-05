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
import { get } from 'node:http'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Cdp, callExpression, evaluate } from './cdp.mjs'
import { scaled, timeoutScale } from './timing.mjs'

export { scaled, timeoutScale }

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

/**
 * Resolves with `promise`, or rejects with `message` after `ms`. The timer is
 * cleared either way: a pending one would keep the test file's process alive
 * (and node --test waiting) long after the test ended.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
export function within(promise, ms, message) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), scaled(ms))
  })
  return /** @type {Promise<T>} */ (Promise.race([promise, timeout])).finally(() => clearTimeout(timer))
}

/**
 * GETs JSON without keep-alive. fetch() keeps its connection open for a few
 * seconds, which holds the test file's process open after the last test.
 * @param {string} url
 * @returns {Promise<any>}
 */
function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false, timeout: 5000 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error(`GET ${url} timed out`)))
    request.on('error', reject)
  })
}

/** @returns {{ pid: number, ppid: number, command: string }[]} */
function processTable() {
  try {
    // Every process with its full command line. (`-e` lists all processes on
    // Linux but means "show the environment" on macOS, hence two spellings.)
    const all = process.platform === 'darwin' ? '-ax' : '-e'
    const out = execFileSync('ps', [all, '-o', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
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
  const { name, profileDir, homeDir, fresh = true, args = [], env = {}, startTimeout = scaled(45_000) } = options
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
  installCleanup()
  live.add(child)
  child.once('exit', () => live.delete(child))
  const app = new App({ ...options, offlinePort }, child)
  try {
    await app.connect(startTimeout)
  } catch (error) {
    await app.dispose({ reason: 'failed to start' })
    throw error
  }
  return app
}

/** Every app this process started and has not seen exit. */
const live = new Set()
let cleanupInstalled = false

/** Kills what is still running when the test process ends, however it ends. */
function installCleanup() {
  if (cleanupInstalled) return
  cleanupInstalled = true
  const killAll = () => {
    for (const child of live) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
  process.on('exit', killAll)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      killAll()
      process.exit(1)
    })
  }
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
    /** Screenshots that could not be taken, and why. */
    this.screenshotFailures = []
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
    // Links and "View docs" buttons would open the developer's real browser;
    // they are recorded instead (`openedUrls()`).
    await this.main(() => {
      const { shell } = require('electron')
      globalThis.__e2eOpened = []
      shell.openExternal = async (url) => {
        globalThis.__e2eOpened.push(String(url))
      }
      return true
    })
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
    // Only an async function is awaited. Asking the inspector to await the
    // result of a plain function made it fail now and then, right after the
    // app started, with "Promise was collected": it wraps the value in a
    // promise it holds weakly, and a collection in between loses it.
    const isAsync = typeof fn === 'function' && /^async\b/.test(fn.toString())
    return evaluate(this.mainCdp, callExpression(fn, args), { commandLineApi: true, awaitPromise: isAsync })
  }

  /** Page targets of Eaon's own windows (not webviews, not the agent's browser). */
  async targets() {
    /** @type {{ id: string, type: string, url: string, webSocketDebuggerUrl: string }[]} */
    const list = await getJson(`http://127.0.0.1:${this.devtoolsPort}/json/list`)
    return list.filter((t) => t.type === 'page' && /\/renderer\/index\.html/.test(t.url))
  }

  /** Waits until at least `count` app windows exist and returns their pages, oldest first. */
  async waitForPages(count, timeout = 20_000) {
    timeout = scaled(timeout)
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
    timeout = scaled(timeout)
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

  /** URLs the app asked the OS to open (recorded, never opened). */
  openedUrls() {
    return this.main(() => globalThis.__e2eOpened ?? [])
  }

  /**
   * Starts recording which IPC handlers the renderer invokes (channel names,
   * in order). Handlers registered later are wrapped on the next call.
   */
  recordIpc() {
    return this.main(() => {
      const { ipcMain } = require('electron')
      globalThis.__e2eIpc ??= []
      for (const [channel, handler] of ipcMain._invokeHandlers) {
        if (handler.__e2e) continue
        const wrapped = function (...args) {
          globalThis.__e2eIpc.push(channel)
          return handler.apply(this, args)
        }
        wrapped.__e2e = true
        ipcMain._invokeHandlers.set(channel, wrapped)
      }
      return ipcMain._invokeHandlers.size
    })
  }

  /** IPC channels invoked since `recordIpc()`, emptied by reading. */
  takeIpc() {
    return this.main(() => (globalThis.__e2eIpc ?? []).splice(0))
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
   * seen taking 2–43 s on a machine with a load average of 150–340, so it
   * gets its own, generous timeout.
   *
   * If Eaon's own quit finished (the `exit` marker is in its output) but the
   * process still lingers after the timeout, it is killed and `forced` is
   * set: everything Eaon had to write was written before `exit`, and what
   * hangs after it is Electron's native shutdown, which is not what is being
   * tested. A quit that never reaches `exit` throws: that one is Eaon's.
   * @returns {Promise<{ code: number | null, signal: string | null, ms: number, appMs: number | null, forced: boolean }>}
   */
  async quit({ timeout = 60_000 } = {}) {
    if (!this.running) return { ...(this.exit ?? { code: null, signal: null }), ms: 0, appMs: null, forced: false }
    this.sample()
    const started = Date.now()
    // Scheduled, so the evaluation returns before the quit begins. The quit's
    // stages go to the app's output, so a slow or stuck quit says where it was.
    // (`require` only exists while the evaluation runs, so it is taken first.)
    //
    // The inspector is closed by the app itself just before it quits: with a
    // debugger still attached Node waits for it at exit ("Waiting for the
    // debugger to disconnect..."), and closing the socket from here races
    // the quit, which finishes in a quarter of a second.
    await this.main(() => {
      const { app, BrowserWindow } = require('electron')
      const inspector = require('inspector')
      const t0 = Date.now()
      const mark = (stage) => console.log(`[e2e] quit: ${stage} at +${Date.now() - t0} ms (${BrowserWindow.getAllWindows().length} windows)`)
      for (const stage of ['before-quit', 'window-all-closed', 'will-quit', 'quit']) app.on(stage, () => mark(stage))
      process.on('exit', () => mark('exit'))
      setTimeout(() => {
        inspector.close()
        app.quit()
      }, 0)
      return true
    })
    this.closeConnections()
    const result = await within(this.exited, timeout, 'quit timed out').catch(() => null)
    const appMs = /\[e2e\] quit: exit at \+(\d+) ms/.exec(this.log)?.[1]
    if (!result) {
      this.child.kill('SIGKILL')
      const killed = await this.exited
      if (appMs === undefined) throw new Error(`${this.name}: Eaon's quit did not finish within ${timeout} ms of app.quit() (killed).\n${this.tail()}`)
      return { ...killed, ms: Date.now() - started, appMs: Number(appMs), forced: true }
    }
    return { ...result, ms: Date.now() - started, appMs: appMs === undefined ? null : Number(appMs), forced: false }
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
    timeout = scaled(timeout)
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
      await within(this.exited, 5000, 'still running after SIGKILL').catch(() => undefined)
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
    timeout = scaled(timeout)
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
    // The old document can still answer for a moment after the reload is
    // sent; a mark on it tells the two apart.
    await this.eval(() => {
      window.__e2eBeforeReload = true
    })
    await this.cdp.send('Page.reload', { ignoreCache: false })
    await this.waitFor(() => !window.__e2eBeforeReload, { message: 'the page to reload' })
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
   * mouse press at its centre. The element is found, checked (visible,
   * enabled, nothing covering its centre) and measured in one evaluation, and
   * the whole thing is retried until the timeout: a button whose label or
   * state is changing under the page (an unread badge appearing, a menu still
   * animating in) is clicked once it settles, never at where it used to be.
   * @param {string} selector
   * @param {{ text?: string | RegExp, timeout?: number, enabled?: boolean }} [options]
   */
  async click(selector, { text, timeout = 10_000, enabled = true } = {}) {
    timeout = scaled(timeout)
    const textSource = text instanceof RegExp ? { source: text.source, flags: text.flags } : text === undefined ? null : { literal: text }
    const what = `${selector}${text ? ` with text ${text}` : ''}`
    const deadline = Date.now() + timeout
    for (;;) {
      const probe = await this.eval(
        (selector, textSource, enabled) => {
          const matches = (el) => {
            if (!textSource) return true
            const content = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()
            return textSource.literal !== undefined ? content.includes(textSource.literal) : new RegExp(textSource.source, textSource.flags).test(content)
          }
          const candidates = [...document.querySelectorAll(selector)].filter(matches)
          if (candidates.length === 0) return { why: 'no such element' }
          const visible = candidates.filter((el) => {
            const rect = el.getBoundingClientRect()
            const style = getComputedStyle(el)
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
          })
          if (visible.length === 0) return { why: 'not visible' }
          const usable = visible.filter((el) => !enabled || !(el.disabled || el.getAttribute('aria-disabled') === 'true'))
          if (usable.length === 0) return { why: 'disabled' }
          const el = usable[0]
          el.scrollIntoView({ block: 'center', inline: 'center' })
          const rect = el.getBoundingClientRect()
          const x = rect.x + rect.width / 2
          const y = rect.y + rect.height / 2
          const hit = document.elementFromPoint(x, y)
          if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
            return { why: `covered by <${hit.tagName.toLowerCase()} class="${hit.className}">` }
          }
          return { x, y }
        },
        selector,
        textSource,
        enabled
      )
      if (probe.x !== undefined) {
        await this.mouse(probe.x, probe.y)
        return
      }
      if (Date.now() > deadline) throw new Error(`${this.cdp.label}: cannot click ${what}: ${probe.why} (after ${timeout} ms)`)
      await sleep(100)
    }
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
   * Saves a PNG of the window into the screenshots folder and returns its
   * path, or null if no frame could be had. A screenshot is evidence for a
   * person reading the run, not an assertion, so failing to take one is
   * reported (`app.screenshotFailures`) rather than failing the scenario.
   *
   * DevTools can refuse a capture for a moment (a window that has just
   * reloaded or resized has no frame yet), so it is retried after waiting for
   * two animation frames, and finally asked of the main process, whose own
   * capture is given a deadline: capturePage on a window that never paints
   * never settles.
   * @param {string} name
   * @returns {Promise<string | null>}
   */
  async screenshot(name) {
    mkdirSync(screensDir, { recursive: true })
    const path = join(screensDir, `${name.replace(/[^a-z0-9._-]+/gi, '-')}.png`)
    const failures = []
    let data = null
    for (let attempt = 1; attempt <= 3 && !data; attempt++) {
      try {
        await this.eval(
          () =>
            new Promise((done) => {
              const timer = setTimeout(done, 1500)
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  clearTimeout(timer)
                  done(true)
                })
              )
            })
        )
        data = (await this.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, { timeout: 10_000 })).data
      } catch (error) {
        failures.push(`attempt ${attempt}: ${error instanceof Error ? error.message.split('\n')[0] : error}`)
        await this.cdp.send('Page.bringToFront').catch(() => undefined)
      }
    }
    if (!data) {
      try {
        data = await this.app.main(async (targetId) => {
          const { webContents } = require('electron')
          const contents = webContents.fromDevToolsTargetId(targetId)
          if (!contents) return null
          const image = await Promise.race([contents.capturePage(), new Promise((resolve) => setTimeout(() => resolve(null), 5000))])
          return image ? image.toPNG().toString('base64') : null
        }, this.targetId)
      } catch (error) {
        failures.push(`main: ${error instanceof Error ? error.message.split('\n')[0] : error}`)
      }
    }
    if (!data) {
      this.app.screenshotFailures.push(`${name}: ${failures.join('; ')}`)
      return null
    }
    writeFileSync(path, Buffer.from(data, 'base64'))
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
