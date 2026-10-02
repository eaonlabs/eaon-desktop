import { readFile } from 'node:fs/promises'
import { BrowserWindow, type NativeImage } from 'electron'
import type { BrowserInput } from '@shared/agentBrowser'
import type { AgentTool, ToolSource } from '../../agent/tools'
import type { NeutralImage } from '../../providers/adapters/types'

/**
 * Every worker's own web browser, driven through BetterWright
 * (`betterwright/electron`): a hidden window per worker, in its own persistent
 * session (`persist:worker-<id>`), so each keeps its own logins and cookies
 * and none of them touches the user's Chrome. The user can show the window
 * to watch, or to sign a worker in somewhere; hiding it again hands it back.
 *
 * BetterWright attaches over an authenticated, loopback-only CDP endpoint to
 * exactly that one page and routes its traffic through its policy proxy; it
 * runs the agent's steps in a worker process. We expose a small set of
 * actions rather than raw Playwright code: small local models drive them
 * reliably, and each one is checked before it runs (see `catastrophic`).
 *
 * Pinned to 2.8.8. It declares Electron ≥ 43 as a peer; Eaon is on 33, where
 * everything used here was verified (open, snapshot, click by ref, type,
 * press, read, screenshot). Revisit when Eaon moves to a newer Electron.
 */

type BetterWrightInstance = { run: (code: string) => Promise<{ result?: unknown; error?: string } | unknown>; close: () => Promise<void> }

interface Session {
  window: BrowserWindow
  browser: BetterWrightInstance | null
  takeover: AbortController
  /** role + name per ref from the latest snapshot, to judge a click or a typed field before it happens. */
  refs: Map<string, { role: string; name: string }>
  queue: Promise<unknown>
  /** Where the agent's on-page cursor last was, so the next move starts there (a new page loses the overlay). */
  cursor: { x: number; y: number } | null
  /** Set while the user has taken over: the agent's next step waits for `done`. */
  control: { done: Promise<void>; release: () => void } | null
}

type FrameListener = (image: NativeImage) => void

/**
 * The agent's cursor, drawn into the page itself so it shows in the live view
 * and in the real window alike: a pointer that glides from where it last was
 * to the element, a ring around the element, and a ripple on a click. It sits
 * in a shadow root marked aria-hidden, so snapshots and `find` never see it,
 * and it ignores the pointer, so it can't swallow a click.
 */
const CURSOR_SCRIPT = `async ({ x, y, fromX, fromY, box, mode }) => {
  const id = '__eaon_agent_cursor'
  let host = document.getElementById(id)
  if (!host) {
    host = document.createElement('div')
    host.id = id
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none'
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<style>' +
      '.c{position:fixed;left:0;top:0;width:24px;height:24px;transition:transform 420ms cubic-bezier(.3,.7,.2,1);filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}' +
      '.tag{position:absolute;left:20px;top:20px;font:600 11px -apple-system,system-ui,sans-serif;color:#fff;background:#0A84FF;padding:2px 6px;border-radius:5px;white-space:nowrap}' +
      '.ring{position:fixed;border:2px solid #0A84FF;border-radius:6px;box-shadow:0 0 0 4px rgba(10,132,255,.2);opacity:0;transition:opacity 180ms}' +
      '.ripple{position:fixed;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:rgba(10,132,255,.4);opacity:0}' +
      '.ripple.go{animation:r 460ms ease-out}@keyframes r{0%{transform:scale(.2);opacity:.9}100%{transform:scale(1.7);opacity:0}}' +
      '</style><div class="ring"></div><div class="ripple"></div>' +
      '<div class="c"><svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 2.5l6.8 18.2 2.5-7.1 7.2-2.6z" fill="#0A84FF" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg><span class="tag">Eaon</span></div>'
    document.documentElement.appendChild(host)
  }
  const root = host.shadowRoot
  const cursor = root.querySelector('.c')
  const ring = root.querySelector('.ring')
  const ripple = root.querySelector('.ripple')
  if (!host.dataset.placed) {
    cursor.style.transition = 'none'
    cursor.style.transform = 'translate(' + (fromX - 4) + 'px,' + (fromY - 2) + 'px)'
    cursor.getBoundingClientRect()
    cursor.style.transition = ''
    host.dataset.placed = '1'
  }
  ring.style.left = (box.x - 4) + 'px'
  ring.style.top = (box.y - 4) + 'px'
  ring.style.width = (box.width + 8) + 'px'
  ring.style.height = (box.height + 8) + 'px'
  ring.style.opacity = '1'
  cursor.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 2) + 'px)'
  await new Promise((r) => setTimeout(r, 440))
  if (mode === 'click') {
    ripple.style.left = x + 'px'
    ripple.style.top = y + 'px'
    ripple.classList.remove('go')
    ripple.getBoundingClientRect()
    ripple.classList.add('go')
    await new Promise((r) => setTimeout(r, 120))
  }
  setTimeout(() => { ring.style.opacity = '0' }, mode === 'click' ? 500 : 1400)
}`

const SENSITIVE = /password|passcode|card ?number|credit card|\bcvc\b|\bcvv\d?\b|security code|expir|\biban\b|routing number|account number|one-time|verification code|\b2fa\b|\bpin\b/i
const SPENDING = /\b(buy|purchase|pay|checkout|check out|place (?:your |my |the )?order|order now|complete (?:order|purchase|payment)|confirm (?:order|purchase|payment|booking)|book now|subscribe|donate|transfer|withdraw)\b/i

/** `- button "Sign in" [ref=e12]` → e12 → { role: button, name: Sign in }. */
export function parseRefs(snapshot: string): Map<string, { role: string; name: string }> {
  const refs = new Map<string, { role: string; name: string }>()
  for (const line of snapshot.split('\n')) {
    const match = /-\s*([\w-]+)(?:\s+"([^"]*)")?[^\n]*\[ref=(f?\d*e\d+)\]/.exec(line)
    if (match) refs.set(match[3], { role: match[1], name: match[2] ?? '' })
  }
  return refs
}

/** A snapshot ref ("e12", "f1e3") or one of find's own ("find-3", stable until the next find). */
const isRef = (value: unknown): value is string => typeof value === 'string' && /^(f?\d*e\d+|find-\d+)$/.test(value)
const locatorFor = (ref: string): string =>
  ref.startsWith('find-') ? `page.locator('[data-eaon-find="${ref.slice(5)}"]')` : `page.locator(${JSON.stringify(`aria-ref=${ref}`)})`
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Clipped: a snapshot of a long page can run to tens of thousands of characters. */
const clip = (text: string, max = 12_000): string => (text.length > max ? `${text.slice(0, max)}\n…(cut; scroll or use read for more)` : text)

function resultText(value: unknown): string {
  const out = value && typeof value === 'object' && 'result' in value ? (value as { result: unknown }).result : value
  if (value && typeof value === 'object' && 'error' in value && (value as { error?: unknown }).error) {
    throw new Error(String((value as { error: unknown }).error))
  }
  // BetterWright hands long results back as a preview.
  if (out && typeof out === 'object' && typeof (out as { preview?: unknown }).preview === 'string') {
    return `${(out as { preview: string }).preview}\n…(cut)`
  }
  return typeof out === 'string' ? out : JSON.stringify(out ?? '')
}

export class WorkerBrowsers {
  private sessions = new Map<string, Session>()
  /** Live views watching each browser's frames; see `watchFrames`. */
  private frameWatchers = new Map<string, Set<FrameListener>>()

  /**
   * `partition` names each browser's persistent session; workers get
   * `persist:worker-<id>`. The chat agent's one browser (features/agentBrowser.ts)
   * uses its own, so its logins are never a worker's.
   */
  constructor(private readonly options: { partition?: (id: string) => string; title?: string } = {}) {}

  private async session(workerId: string): Promise<Session> {
    let session = this.sessions.get(workerId)
    if (session && !session.window.isDestroyed()) return session
    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 860,
      title: this.options.title ?? 'Worker browser',
      webPreferences: {
        partition: this.options.partition?.(workerId) ?? `persist:worker-${workerId}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // The live view captures this window while it is hidden; a throttled one stops painting.
        backgroundThrottling: false
      }
    })
    // Closing the window only hides it: the session, its logins and the
    // worker's place in a task survive the user looking away.
    window.on('close', (event) => {
      if (!this.sessions.has(workerId)) return
      event.preventDefault()
      window.hide()
    })
    await window.webContents.loadURL('about:blank')
    session = { window, browser: null, takeover: new AbortController(), refs: new Map(), queue: Promise.resolve(), cursor: null, control: null }
    this.sessions.set(workerId, session)
    // A live view may already be waiting for this browser's first page.
    if (this.frameWatchers.get(workerId)?.size) this.subscribe(workerId, window)
    return session
  }

  private async attach(session: Session): Promise<BetterWrightInstance> {
    if (session.browser) return session.browser
    const [{ BetterWright }, { createElectronHostTarget }] = await Promise.all([import('betterwright'), import('betterwright/electron')])
    session.browser = new BetterWright({
      hostTarget: createElectronHostTarget({ contents: session.window.webContents, signal: session.takeover.signal }),
      headless: false,
      parkBackgroundPages: false
    }) as unknown as BetterWrightInstance
    return session.browser
  }

  /** Runs one step's code in the worker's browser, one step at a time per worker. */
  async run(workerId: string, code: string): Promise<string> {
    const session = await this.session(workerId)
    const step = session.queue.then(async () => {
      const browser = await this.attach(session)
      return resultText(await browser.run(code))
    })
    session.queue = step.catch(() => {})
    return step
  }

  async snapshot(workerId: string, diff = false): Promise<string> {
    const code = `return await snapshot({ interactive: true, maxChars: 20000${diff ? ', diff: true' : ''} })`
    let text = ''
    // Caught between two pages (a click that navigates): again, once it has landed.
    for (let attempt = 0; ; attempt++) {
      try {
        text = await this.run(workerId, code)
        break
      } catch (error) {
        const transient = /context was destroyed|navigat|Target closed/i.test(String(error))
        if (transient && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 800))
          continue
        }
        // Some pages (XHTML ones, like iana.org) can't be snapshotted: give their text instead.
        if (/does not match any element/i.test(String(error))) {
          const page = await this.run(workerId, `return (await page.title()) + '\\n' + page.url() + '\\n\\n' + (await page.evaluate(() => document.body?.innerText ?? document.documentElement?.innerText ?? '')).slice(0, 8000)`)
          return `${clip(page, 8000)}\n\n(This page can't be snapshotted; above is its text. Use find {text} to get refs for links or buttons.)`
        }
        throw error
      }
    }
    // A page with thousands of links (Wikipedia) is too big to read whole.
    if (/^Snapshot is \d+ chars, over the/.test(text) || /\nSnapshot is \d+ chars, over the/.test(text)) {
      const head = text.split('\n')[0]
      return `${head.startsWith('page ') ? `${head}\n` : ''}This page is too big for a whole snapshot. Use find {text} to get the refs of the links or buttons you want, or read for its text.`
    }
    const session = this.sessions.get(workerId)
    if (session && !diff) session.refs = parseRefs(text)
    else if (session) for (const [ref, info] of parseRefs(text)) session.refs.set(ref, info)
    return clip(text)
  }

  /**
   * After a step that navigated (a link to another site, back): wait for
   * Electron to say the page has loaded, then reconnect BetterWright. On
   * Electron 33, Playwright's view of a page that swapped renderer process
   * goes stale — evaluate sees the new page, but snapshots and load waits
   * don't — and a fresh connection to the same window sees it correctly. The
   * page itself, its session and logins are untouched.
   */
  async landed(workerId: string): Promise<void> {
    const session = this.sessions.get(workerId)
    if (!session || session.window.isDestroyed()) return
    // Reconnect first — the old connection's view of a page that changed
    // process is what hangs — then wait, through the fresh one, until the new
    // page is usable. Straight away, too: the page's traffic goes through
    // BetterWright's guard proxy, and with no connection it can't load.
    await sleep(300)
    session.queue = session.queue.then(async () => {
      const browser = session.browser
      session.browser = null
      await browser?.close().catch(() => {})
      await (await this.attach(session))
        .run(`await page.waitForFunction(() => document.readyState !== 'loading', null, { timeout: 12000 }).catch(() => {}); return 1`)
        .catch(() => {})
    })
    await session.queue
  }

  /**
   * Opens a page through Electron rather than Playwright: on Electron 33,
   * Playwright sometimes never sees the load events of a page that swapped
   * renderer process, and page.goto waits out its timeout. Electron's own
   * loadURL settles reliably; BetterWright then reconnects to the new page.
   */
  async open(workerId: string, url: string): Promise<void> {
    const session = await this.session(workerId)
    // Connected first: without BetterWright's guard proxy up, the load stalls.
    await this.run(workerId, 'return 1')
    const contents = session.window.webContents
    // Settled when the new page's DOM is ready (or the load failed outright),
    // not when every last resource has loaded.
    // The earliest sign the new page is there — its navigation committing is
    // enough, since landed() then waits (through the fresh connection) until
    // it is usable. dom-ready alone was occasionally never seen.
    const signals = ['did-navigate', 'dom-ready', 'did-stop-loading'] as const
    const arrived = new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        for (const signal of signals) contents.off(signal as 'dom-ready', done)
        contents.off('did-fail-load', failed)
        clearTimeout(timer)
      }
      const done = (): void => {
        cleanup()
        resolve()
      }
      const failed = (_e: unknown, code: number, description: string, _url: string, isMainFrame: boolean): void => {
        if (!isMainFrame || code === -3) return // -3: aborted, e.g. by a redirect
        cleanup()
        reject(new Error(`Could not open ${url}: ${description}`))
      }
      const timer = setTimeout(done, 30_000)
      for (const signal of signals) contents.on(signal as 'dom-ready', done)
      contents.on('did-fail-load', failed)
    })
    contents.loadURL(url).catch(() => {})
    await arrived
    await this.landed(workerId)
  }

  /** The page this worker's browser is on now. */
  url(workerId: string): string {
    const window = this.sessions.get(workerId)?.window
    return window && !window.isDestroyed() ? window.webContents.getURL() : ''
  }

  /** The browser's own back button, with the same wait-and-reconnect as a click that navigates. */
  async back(workerId: string): Promise<boolean> {
    const session = this.sessions.get(workerId)
    const contents = session?.window.webContents
    if (!contents || !contents.canGoBack()) return false
    contents.goBack()
    await this.landed(workerId)
    return true
  }

  /**
   * The interactive elements whose text or label contains `query`, each with
   * a ref — the way into a page too big to snapshot whole.
   */
  async find(workerId: string, query: string): Promise<string> {
    const code =
      `return await page.evaluate((q) => { document.querySelectorAll('[data-eaon-find]').forEach((e) => e.removeAttribute('data-eaon-find')); const out = [];` +
      ` for (const el of document.querySelectorAll('a, button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [contenteditable=true]')) {` +
      ` const name = ((el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.value || '').replace(/\\s+/g, ' ').slice(0, 80);` +
      ` const hay = (name + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('href') || '')).toLowerCase();` +
      ` if (!hay.includes(q)) continue; const rect = el.getBoundingClientRect(); if (!rect.width && !rect.height) continue;` +
      ` const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button' : el.tagName === 'SELECT' ? 'combobox' : el.type === 'password' ? 'password' : el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? 'textbox' : el.tagName.toLowerCase());` +
      ` el.setAttribute('data-eaon-find', String(out.length)); out.push({ role, name, href: el.getAttribute('href') || '' }); if (out.length >= 15) break }` +
      ` return out }, ${JSON.stringify(query.toLowerCase())})`
    const raw = await this.run(workerId, code)
    let found: { role: string; name: string; href: string }[] = []
    try {
      found = JSON.parse(raw)
    } catch {
      found = []
    }
    if (found.length === 0) return `Nothing on this page matches "${query}".`
    const session = this.sessions.get(workerId)
    return found
      .map((el, i) => {
        session?.refs.set(`find-${i}`, { role: el.role, name: el.name })
        return `- ${el.role} "${el.name}"${el.href ? ` (${el.href.slice(0, 80)})` : ''} [ref=find-${i}]`
      })
      .join('\n')
  }

  /** What the latest snapshot says a ref is, for judging a step before it runs. */
  describe(workerId: string, ref: unknown): { role: string; name: string } | undefined {
    return isRef(ref) ? this.sessions.get(workerId)?.refs.get(ref) : undefined
  }

  async screenshot(workerId: string): Promise<NeutralImage> {
    const text = await this.run(workerId, `const shot = await screenshot({ annotate: true, type: 'jpeg', quality: 70 }); return shot.path`)
    const path = text.replace(/^"|"$/g, '')
    return { mime: 'image/jpeg', data: (await readFile(path)).toString('base64') }
  }

  /** The user's view of a worker's browser: shown to watch or to sign in; hidden again after. */
  show(workerId: string): boolean {
    const window = this.sessions.get(workerId)?.window
    if (!window || window.isDestroyed()) return false
    window.show()
    window.focus()
    return true
  }

  has(workerId: string): boolean {
    return this.sessions.has(workerId)
  }

  /** The window itself, for the chat agent's live view; null before its first page. */
  window(workerId: string): BrowserWindow | null {
    const window = this.sessions.get(workerId)?.window
    return window && !window.isDestroyed() ? window : null
  }

  /* --------------------------------------------- live view, cursor and take-over */

  /**
   * Every frame the page paints, for a live view: Electron's own frame
   * subscription, which keeps delivering while the window is hidden (it has
   * `backgroundThrottling: false`). One subscription per window, shared by
   * every view watching it; it stops when the last one leaves.
   */
  watchFrames(workerId: string, listener: FrameListener): () => void {
    let listeners = this.frameWatchers.get(workerId)
    if (!listeners) this.frameWatchers.set(workerId, (listeners = new Set()))
    listeners.add(listener)
    const window = this.window(workerId)
    if (window && listeners.size === 1) this.subscribe(workerId, window)
    return () => {
      listeners!.delete(listener)
      if (listeners!.size > 0) return
      this.frameWatchers.delete(workerId)
      const current = this.window(workerId)
      if (current) current.webContents.endFrameSubscription()
    }
  }

  private subscribe(workerId: string, window: BrowserWindow): void {
    window.webContents.beginFrameSubscription(false, (image) => {
      for (const listener of this.frameWatchers.get(workerId) ?? []) listener(image)
    })
  }

  /** One picture of the page as it is now, for a view that has just opened on a page that isn't repainting. */
  async capture(workerId: string): Promise<NativeImage | null> {
    const window = this.window(workerId)
    return window ? window.webContents.capturePage() : null
  }

  /** The page's own size in CSS pixels, to map a click on a scaled picture back onto it. */
  viewport(workerId: string): { width: number; height: number } {
    const [width, height] = this.window(workerId)?.getContentSize() ?? [0, 0]
    return { width, height }
  }

  /**
   * The user takes over. The step the agent is on finishes; its next one
   * waits until they hand the browser back, then sees the page afresh.
   */
  takeControl(workerId: string): boolean {
    const session = this.sessions.get(workerId)
    if (!session || session.window.isDestroyed()) return false
    if (!session.control) {
      let release = (): void => undefined
      const done = new Promise<void>((resolve) => (release = resolve))
      session.control = { done, release }
    }
    return true
  }

  releaseControl(workerId: string): void {
    const session = this.sessions.get(workerId)
    session?.control?.release()
    if (session) session.control = null
  }

  controlled(workerId: string): boolean {
    return Boolean(this.sessions.get(workerId)?.control)
  }

  /** Waits while the user has control. True when it had to wait, so the caller knows the page may have changed. */
  async waitForUser(workerId: string, signal?: AbortSignal): Promise<boolean> {
    const control = this.sessions.get(workerId)?.control
    if (!control) return false
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      const onAbort = (): void => reject(new Error('aborted'))
      signal?.addEventListener('abort', onAbort, { once: true })
      void control.done.then(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      })
    })
    return true
  }

  /**
   * The user's mouse and keyboard, forwarded as real input to the page —
   * only while they have control, so the live view can never act behind the
   * agent's back. Coordinates are the page's CSS pixels.
   */
  input(workerId: string, event: BrowserInput): boolean {
    const session = this.sessions.get(workerId)
    if (!session?.control || session.window.isDestroyed()) return false
    const contents = session.window.webContents
    switch (event.type) {
      case 'mouseDown':
      case 'mouseUp':
      case 'mouseMove':
        contents.sendInputEvent({ type: event.type, x: Math.round(event.x), y: Math.round(event.y), button: event.button ?? 'left', clickCount: event.clickCount ?? 1 })
        return true
      case 'mouseWheel':
        // The DOM's wheel delta is positive scrolling down; Electron's is the other way round.
        contents.sendInputEvent({ type: 'mouseWheel', x: Math.round(event.x), y: Math.round(event.y), deltaX: -event.deltaX, deltaY: -event.deltaY, canScroll: true })
        return true
      case 'key': {
        const keyCode = KEY_CODES[event.key] ?? (event.key.length === 1 ? event.key : null)
        if (!keyCode) return false
        const modifiers = event.modifiers
        contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
        // A printable key also types its character, unless a shortcut modifier is held.
        if (event.key.length === 1 && !modifiers.includes('control') && !modifiers.includes('meta')) contents.sendInputEvent({ type: 'char', keyCode: event.key, modifiers })
        contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
        return true
      }
      case 'text':
        void contents.insertText(event.text)
        return true
      case 'edit':
        contents[event.command]()
        return true
      default:
        return false
    }
  }

  /** The user typed an address in the live view while in control. */
  async navigate(workerId: string, url: string): Promise<boolean> {
    if (!this.controlled(workerId)) return false
    let target = url.trim()
    if (!target) return false
    if (!/^[a-z][\w+.-]*:/i.test(target)) target = /\s/.test(target) || !/\./.test(target) ? `https://duckduckgo.com/?q=${encodeURIComponent(target)}` : `https://${target}`
    if (!/^https?:/i.test(target)) return false
    await this.open(workerId, target)
    return true
  }

  /**
   * Glides the agent's on-page cursor onto the element a step is about to
   * act on, so whoever is watching sees where it goes. Best effort: an
   * element that can't be measured just isn't pointed at.
   */
  async pointAt(workerId: string, locator: string, mode: 'click' | 'type'): Promise<void> {
    const session = this.sessions.get(workerId)
    if (!session) return
    const from = session.cursor
    const code =
      `const loc = ${locator}; await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});` +
      ` const box = await loc.boundingBox({ timeout: 4000 }).catch(() => null); if (!box) return '';` +
      ` const vp = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));` +
      ` const x = box.x + Math.min(box.width / 2, 40), y = box.y + box.height / 2;` +
      ` await page.evaluate(${CURSOR_SCRIPT}, { x, y, fromX: ${from ? from.x : 'vp.width / 2'}, fromY: ${from ? from.y : 'vp.height / 2'}, box, mode: ${JSON.stringify(mode)} }).catch(() => {});` +
      ` return x + ',' + y`
    try {
      const at = (await this.run(workerId, code)).replace(/^"|"$/g, '')
      const [x, y] = at.split(',').map(Number)
      if (Number.isFinite(x) && Number.isFinite(y)) session.cursor = { x, y }
    } catch {
      /* pointing is decoration; the step itself reports real failures */
    }
  }

  /** A removed worker's browser goes with it; its session data stays in the partition. */
  async close(workerId: string): Promise<void> {
    const session = this.sessions.get(workerId)
    if (!session) return
    this.releaseControl(workerId)
    this.sessions.delete(workerId)
    session.takeover.abort()
    await session.browser?.close().catch(() => {})
    if (!session.window.isDestroyed()) session.window.destroy()
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }
}

/** DOM `KeyboardEvent.key` → Electron's `keyCode` for keys that aren't a single character. */
const KEY_CODES: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ' ': 'Space'
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const js = (value: string): string => JSON.stringify(value)

export interface BrowserToolOptions {
  /** Whose browser a call drives: a worker's id, or the chat agent's fixed one. Null refuses the call. */
  idOf: (ctx: Parameters<AgentTool['run']>[1]) => string | null
  /** How to tell the model to get a sign-in done. */
  signInHint: string
  /** Each step as it starts and ends — the chat agent's live view shows them. */
  onStep?: (ctx: Parameters<AgentTool['run']>[1], step: { action: string; detail: string; done: boolean }) => void
}

/** The `web_browser` tool over `browsers`, for whichever agent `idOf` names. */
export function browserTool(browsers: WorkerBrowsers, options: BrowserToolOptions): AgentTool {
  const self = (ctx: Parameters<AgentTool['run']>[1]): string => {
    const id = options.idOf(ctx)
    if (!id) throw new Error('This agent has no browser of its own.')
    return id
  }
  const tool: AgentTool = {
    name: 'web_browser',
    description: `Your own web browser (a real one, with your own saved logins). open {url} → an interactive snapshot where every element has a ref; then click {ref}, type {ref, text, submit?}, press {key}, scroll {direction}, back, read (the page text), find {text} (refs of the links/buttons matching words — for big pages), snapshot, or screenshot (an image, when layout matters). Refs change when the page changes: act on the latest snapshot. ${options.signInHint}`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'snapshot', 'find', 'click', 'type', 'press', 'scroll', 'back', 'read', 'screenshot'] },
        url: { type: 'string' },
        ref: { type: 'string', description: 'e.g. "e12", from the latest snapshot' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'type: press Enter after' },
        key: { type: 'string', description: 'press: e.g. "Enter", "Escape", "ArrowDown"' },
        direction: { type: 'string', enum: ['up', 'down'] }
      },
      required: ['action']
    },
    mutating: (input) => !['snapshot', 'read', 'screenshot'].includes(str(input.action)),
    // Clicks and typing reach other people's services; a Careful worker is asked (and refused).
    risky: (input) => ['click', 'type', 'press'].includes(str(input.action)),
    // Never alone: typing a password, card number or code, or pressing a button that spends money.
    catastrophic: (input, ctx) => {
      const action = str(input.action)
      if (action !== 'type' && action !== 'click' && action !== 'press') return false
      const id = options.idOf(ctx)
      if (!id) return false
      const el = browsers.describe(id, input.ref)
      if (action === 'type') return !el || SENSITIVE.test(el.name) || /password/i.test(el.role)
      if (action === 'click') return !el || SPENDING.test(el.name)
      return false
    },
    describe: (input) => [str(input.action), str(input.url) || str(input.ref) || str(input.key)].filter(Boolean).join(' '),
    run: async (input, ctx) => {
      const id = self(ctx)
      const action = str(input.action)
      // The user has the wheel: wait until they hand it back, then don't act
      // on a page that may have moved on — show the agent where it is now.
      if (browsers.controlled(id)) {
        options.onStep?.(ctx, { action: 'wait', detail: '', done: false })
        try {
          await browsers.waitForUser(id, ctx.signal)
        } finally {
          options.onStep?.(ctx, { action: 'wait', detail: '', done: true })
        }
        const now = browsers.url(id)
        return `The user took over your browser and has handed it back. Your ${action} was not done, because the page may have changed${
          now ? ` (it is on ${now} now)` : ''
        }. Here it is as it stands; decide your next step from this.\n\n${await browsers.snapshot(id)}`
      }
      const target = browsers.describe(id, input.ref)
      const detail = str(input.url) || (target ? `${target.role} "${target.name}"` : str(input.ref)) || str(input.key) || str(input.text)
      options.onStep?.(ctx, { action, detail, done: false })
      try {
        return await step(id, action, input)
      } finally {
        options.onStep?.(ctx, { action, detail, done: true })
      }
    }
  }

  async function step(id: string, action: string, input: Record<string, unknown>): Promise<Awaited<ReturnType<AgentTool['run']>>> {
    const ref = str(input.ref)
    if (['click', 'type'].includes(action) && !isRef(ref)) return { text: `${action} needs a ref like "e12" from the latest snapshot.`, isError: true }
    const locator = isRef(ref) ? locatorFor(ref) : ''
    switch (action) {
      case 'open': {
        let url = str(input.url).trim()
        if (!url) return { text: 'open needs a url.', isError: true }
        if (!/^[a-z][\w+.-]*:/i.test(url)) url = `https://${url}`
        if (!/^https?:/i.test(url)) return { text: 'Only http(s) pages can be opened.', isError: true }
        await browsers.open(id, url)
        return browsers.snapshot(id)
      }
      case 'snapshot':
        return browsers.snapshot(id)
      case 'click': {
        // A click that opens another page gets that page whole; otherwise, what changed.
        const before = browsers.url(id)
        await browsers.pointAt(id, locator, 'click')
        await browsers.run(id, `await ${locator}.click({ timeout: 10000 }); await page.waitForTimeout(700); return 'ok'`)
        const moved = browsers.url(id) !== before
        if (moved) await browsers.landed(id)
        return browsers.snapshot(id, !moved)
      }
      case 'find':
        if (!str(input.text).trim()) return { text: 'find needs text: words from the link or button you want.', isError: true }
        return browsers.find(id, str(input.text).trim())
      case 'type':
        {
          const before = browsers.url(id)
          const text = str(input.text)
          await browsers.pointAt(id, locator, 'type')
          // Short text is typed key by key, so a watcher sees it go in (and
          // sites that listen for keystrokes get them); long text is filled at once.
          const typing =
            text.length <= 80
              ? `const loc = ${locator}; await loc.fill('', { timeout: 10000 }); if (typeof loc.pressSequentially === 'function') await loc.pressSequentially(${js(text)}, { delay: 28, timeout: 15000 }); else await loc.fill(${js(text)}, { timeout: 10000 });`
              : `await ${locator}.fill(${js(text)}, { timeout: 10000 });`
          await browsers.run(id, `${typing}${input.submit === true ? ` await ${locator}.press('Enter'); await page.waitForTimeout(900);` : ''} return 'ok'`)
          const moved = browsers.url(id) !== before
          if (moved) await browsers.landed(id)
          return browsers.snapshot(id, !moved)
        }
      case 'press':
        await browsers.run(id, `await page.keyboard.press(${js(str(input.key) || 'Enter')}); await page.waitForTimeout(500); return 'ok'`)
        return browsers.snapshot(id, true)
      case 'scroll':
        await browsers.run(id, `await page.mouse.wheel(0, ${str(input.direction) === 'up' ? -900 : 900}); await page.waitForTimeout(300); return 'ok'`)
        return browsers.snapshot(id)
      case 'back':
        if (!(await browsers.back(id))) return { text: 'There is no page to go back to.', isError: true }
        return browsers.snapshot(id)
      case 'read':
        return clip(
          await browsers.run(id, `return (await page.title()) + '\\n' + page.url() + '\\n\\n' + (await page.evaluate(() => document.body?.innerText ?? '')).slice(0, 20000)`),
          20_000
        )
      case 'screenshot':
        return { text: 'Screenshot of your browser (refs are drawn on it).', images: [await browsers.screenshot(id)] }
      default:
        return { text: `Unknown action "${action}".`, isError: true }
    }
  }
  return tool
}

/**
 * The `web_browser` tool: the worker's own browser, action by action. Offered
 * only on a worker's own turn.
 */
export function workerBrowserToolSource(browsers: WorkerBrowsers, onStep?: BrowserToolOptions['onStep']): ToolSource {
  const tool = browserTool(browsers, {
    idOf: (ctx) => ctx.request.workerId ?? null,
    signInHint: 'If a site needs the user to sign in, ask_user; they can watch your browser from your page, take control, sign in and hand it back.',
    ...(onStep ? { onStep } : {})
  })
  return {
    id: 'worker-browser',
    tools: (query) => (query.mode === 'work' && query.depth === 0 && query.request.workerId ? [tool] : []),
    guidance: (query) =>
      query.request.workerId
        ? 'web_browser is your own browser: open a page, act on refs from the latest snapshot, read text with read. Prefer web search for finding pages; use the browser to act on them.'
        : null
  }
}
