import { lookup } from 'node:dns/promises'
import { copyFile, mkdir, open as openFile, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { BrowserWindow, type NativeImage } from 'electron'
import type { BrowserInput } from '@shared/agentBrowser'
import { isRunning } from '../../agent/loop'
import type { AgentTool, ToolSource } from '../../agent/tools'
import type { NeutralImage } from '../../providers/adapters/types'
import { opensPrivateNetwork } from '../browser/privateTarget'
import { purchaseCovers, redactPaymentSecrets } from '../payments/access'

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
 * Pinned to 2.8.8, which declares Electron ≥ 43 as a peer; Eaon is on 43. One
 * connection lasts for the browser's life: attaching re-points the session's
 * proxy and cuts every open connection, so it must not happen per page (see
 * `landed`).
 *
 * A browser nobody has used for a while has its page parked on about:blank
 * (see `park`). A hidden window renders its page at full rate for as long as
 * it is open, so a page with a video, a carousel or a spinner left behind
 * after a worker's turn kept a core busy for hours. The next step, or the
 * user showing the window or taking over, brings the page back first.
 */

type BetterWrightInstance = { run: (code: string) => Promise<{ result?: unknown; error?: string } | unknown>; close: () => Promise<void> }

/** A file the page tried to download. BetterWright cancels every download; this is what the agent is told instead. */
export interface AttemptedDownload {
  url: string
  filename: string
  mime: string
  size: number
}

interface Session {
  window: BrowserWindow
  browser: BetterWrightInstance | null
  takeover: AbortController
  /** role + name per ref from the latest snapshot, to judge a click or a typed field before it happens. */
  refs: Map<string, { role: string; name: string }>
  /** The frame each `find-N` ref was found in (an index into `page.frames()`); absent means the main page. */
  findFrames: Map<string, number>
  queue: Promise<unknown>
  /** Where the agent's on-page cursor last was, so the next move starts there (a new page loses the overlay). */
  cursor: { x: number; y: number } | null
  /** Set while the user has taken over: the agent's next step waits for `done`. */
  control: { done: Promise<void>; release: () => void } | null
  /** Why the page's renderer died, until the next step reopens it. */
  crashed: string | null
  /** Things that happened between steps that the agent should hear about with its next result. */
  notes: string[]
  /** A new tab or window the page asked for since the last step; there are no tabs, so it opens here. */
  popup: string | null
  /** A download the page started since the last step. */
  download: AttemptedDownload | null
  /** The address of the last download the page started, for a `download` with no url. */
  lastDownloadUrl: string | null
  /** The main page's last HTTP answer, for "404 Not Found" and blocked pages. */
  status: { url: string; code: number; text: string } | null
  /** The main page's last failed load (a link to a site that is down), since the step began. */
  loadError: { url: string; code: number; description: string } | null
  /** A file picker the page opened (intercepted, so no dialog appears): the input it would fill. */
  chooser: { backendNodeId: number; multiple: boolean } | null
  /** Whether the file-picker interception is set up on this window's debugger. */
  intercepting: boolean
  /** Undoes the listeners added to the window's session, which outlives the window. */
  unhook: () => void
  /** Steps queued or running (and opens and backs): a live view is pictured while there are any. */
  busy: number
  /** When the user in control last did something to the page; see `live`. */
  inputAt: number
  /** Parks the page once the browser has gone unused for PARK_AFTER_MS; see `armPark`. */
  parkTimer: ReturnType<typeof setTimeout> | null
  /** Set while the page is parked: where it was, the history entry the park added, and its last picture. */
  parked: { url: string; title: string; index: number; frame: NativeImage | null } | null
}

type FrameListener = (image: NativeImage) => void

/** How often a live view is pictured while a step runs or the user has control: enough to follow the cursor. */
const FRAME_MS = 120
/** One more picture this long after a step, for what loads or animates in just after it. */
const SETTLE_MS = 1000
/** How long after the user in control last touched the page it is still pictured: long enough for what they clicked to load. */
const CONTROL_LIVE_MS = 10_000
/**
 * How long a browser goes unused before its page is parked. Long enough that
 * an agent thinking between two steps never meets it; a page left open after
 * a worker's turn stops costing anything ten minutes later.
 */
const PARK_AFTER_MS = 10 * 60_000
/** Waits, through the connection, until a page that has just arrived is usable. */
const UNTIL_READY = `await page.waitForFunction(() => document.readyState !== 'loading', null, { timeout: 12000 }).catch(() => {}); return 1`

/** `promise`, or undefined once `ms` have passed: a page that never answers must not hold the queue forever. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([promise, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))]).finally(() => clearTimeout(timer))
}

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

/**
 * Electron's default user agent as a plain Chrome would send it: without the
 * app's name and the Electron token, and with the version reduced the way
 * Chrome reduces it (`Chrome/146.0.0.0`).
 */
export function chromeUserAgent(electronAgent: string): string {
  return electronAgent
    .replace(/\s+Electron\/\S+/g, '')
    .replace(/\s+(?!Chrome\/|Safari\/|AppleWebKit\/|Mozilla\/|Version\/|Mobile\/)[\w.-]+\/\d[\w.]*(?=\s+Chrome\/)/g, '')
    .replace(/Chrome\/(\d+)\.[\d.]+/, 'Chrome/$1.0.0.0')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** `- button "Sign in" [ref=e12]` → e12 → { role: button, name: Sign in }. */
export function parseRefs(snapshot: string): Map<string, { role: string; name: string }> {
  const refs = new Map<string, { role: string; name: string }>()
  for (const line of snapshot.split('\n')) {
    // The role starts with a letter, so a diff's "-   - button …" (a removed line) reads as the button.
    const match = /-\s*([a-z][\w-]*)(?:\s+"([^"]*)")?[^\n]*\[ref=(f?\d*e\d+)\]/i.exec(line)
    if (match) refs.set(match[3], { role: match[1], name: match[2] ?? '' })
  }
  return refs
}

/** A snapshot ref ("e12", "f1e3") or one of find's own ("find-3", stable until the next find). */
const isRef = (value: unknown): value is string => typeof value === 'string' && /^(f?\d*e\d+|find-\d+)$/.test(value)
/** Playwright code for a ref's element. A `find-N` ref found inside a frame is looked up in that frame. */
const locatorFor = (ref: string, frame?: number): string =>
  ref.startsWith('find-')
    ? `${frame ? `(page.frames()[${frame}] ?? page)` : 'page'}.locator('[data-eaon-find="${ref.slice(5)}"]')`
    : `page.locator(${JSON.stringify(`aria-ref=${ref}`)})`
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Closes a BetterWright connection without waiting on it forever: closing
 * one whose page crashed sends commands to a renderer that no longer runs,
 * and those never answer. A quit or a worker's removal must not hang on it.
 */
async function closeQuietly(browser: BetterWrightInstance | null): Promise<void> {
  if (!browser) return
  await Promise.race([browser.close().catch(() => {}), sleep(5000)])
}

/* ----------------------------------------------- failures the model can act on */

/**
 * A step that failed in a way the agent should hear plainly: what failed,
 * why, and what to do next. `snapshot` asks for the page as it is now to go
 * with the message, so the model can recover without another round trip.
 */
export class BrowserStepError extends Error {
  constructor(
    message: string,
    readonly snapshot = false
  ) {
    super(message)
  }
}

/** A page load that failed outright, with Chromium's error name ("ERR_NAME_NOT_RESOLVED"). */
export class NavigationFailed extends Error {
  constructor(
    readonly url: string,
    readonly code: string
  ) {
    super(`Could not open ${url}: ${code}`)
  }
}

/** Playwright colours its call logs with ANSI escapes; models get them as noise. */
export const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '')

/**
 * Advice for a page that failed to load, by Chromium's error name. Every
 * request goes through BetterWright's SOCKS proxy, so a name that doesn't
 * resolve and a server that refuses both arrive as ERR_SOCKS_CONNECTION_FAILED;
 * `resolves` (a DNS lookup made here) tells them apart when it is known.
 */
export function netErrorAdvice(code: string, url: string, resolves?: boolean): string {
  let host = url
  try {
    host = new URL(url).host || url
  } catch {
    /* keep the raw text */
  }
  const name = code.replace(/^net::/, '')
  if (/^ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|NETWORK_ACCESS_DENIED)$/.test(name)) {
    return `Could not open ${url}: this computer looks offline (${name}). Wait a moment and try again; if it keeps failing, tell the user their connection is down.`
  }
  if (/^ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED)$/.test(name) || (name === 'ERR_SOCKS_CONNECTION_FAILED' && resolves === false)) {
    return `Could not open ${url}: there is no site at ${host} (its name doesn't resolve). Check the address for typos, or find the right one with web search.`
  }
  if (/^ERR_(SOCKS_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|CONNECTION_REFUSED|ADDRESS_UNREACHABLE|CONNECTION_FAILED)$/.test(name)) {
    return `Could not open ${url}: ${host} refused the connection or couldn't be reached (${name}). The site may be down, or Eaon's browser doesn't allow that address. Try again later, or find the information another way.`
  }
  if (/^ERR_(CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|CONNECTION_ABORTED|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR)$/.test(name)) {
    return `Could not open ${url}: ${host} dropped the connection without answering (${name}). Try once more; if it happens again the site is down or blocking automated browsers, so find the information another way.`
  }
  if (/^ERR_(TIMED_OUT|CONNECTION_TIMED_OUT)$/.test(name)) {
    return `Could not open ${url}: ${host} didn't answer in time (${name}). Try again later, or find the information another way.`
  }
  if (/^ERR_(CERT_|SSL_|BAD_SSL)/.test(name)) {
    return `Did not open ${url}: its security certificate isn't valid (${name}), so the connection can't be trusted. Don't look for a way around this; tell the user.`
  }
  if (name === 'ERR_UNSAFE_PORT') return `Did not open ${url}: browsers refuse that port for safety (${name}). Check the address.`
  if (name === 'ERR_TOO_MANY_REDIRECTS') {
    return `Could not open ${url}: the site keeps redirecting in a loop (${name}), usually a sign-in or cookie problem on its side. Try its home page, or tell the user.`
  }
  if (/^ERR_BLOCKED_BY_(CLIENT|RESPONSE|ADMINISTRATOR|ORB)$/.test(name)) {
    return `Did not open ${url}: it was blocked (${name}). Find the information another way.`
  }
  if (name === 'ERR_INVALID_URL') return `Did not open ${url}: that isn't a valid address. Give a full https:// URL.`
  return `Could not open ${url} (${name || 'the load failed'}). Check the address and try again, or find the information another way.`
}

/** A line on what an HTTP error status means for the agent's next step; null for a page that loaded fine. */
export function httpStatusNote(code: number, text = ''): string | null {
  if (!code || code < 400) return null
  const label = `HTTP ${code}${text ? ` ${text}` : ''}`
  if (code === 401) return `${label}: this page wants a username and password the browser can't give. Ask the user to take control of your browser and sign in, or find another way.`
  if (code === 403) return `${label}: the site refused this page. It may need a sign-in, or it is blocking automated browsers.`
  if (code === 404 || code === 410) return `${label}: there is no page at this address. Go back, or find the right page from the site's own links or web search.`
  if (code === 429) return `${label}: the site is rate-limiting. Wait a minute before trying again, and don't repeat requests quickly.`
  if (code >= 500) return `${label}: the site itself has a problem. Try again in a minute, or find the information elsewhere.`
  return `${label}.`
}

/**
 * Bot walls that answer with a page rather than an error: Cloudflare's "Just
 * a moment…", Akamai's "Access Denied", captchas. Repeating the request only
 * makes them stricter, so the agent is told to hand over instead.
 */
const BOT_WALL_TITLE = /just a moment|attention required|access denied|are you a (human|robot)|verify(ing)? (you are|that you'?re) (a )?human|security check|captcha|request blocked|bot detection|pardon our interruption/i
const BOT_WALL_TEXT = /checking (if the site connection is secure|your browser)|enable javascript and cookies to continue|unusual traffic from your (computer|network)|verify (you are|that you'?re) (a )?human|are you a robot|press (and|&) hold|complete the security check|access to this page has been denied|cf-chl|px-captcha|captcha-delivery|why have i been blocked/i

export function botWallNote(page: { title: string; text?: string; status?: number }): string | null {
  const walled = BOT_WALL_TITLE.test(page.title) || (page.text ? BOT_WALL_TEXT.test(page.text.slice(0, 4000)) : false)
  if (!walled) return null
  return `This site is showing an anti-bot check ("${page.title.trim() || 'blocked'}"${page.status ? `, HTTP ${page.status}` : ''}), so it is blocking automated browsers. Don't retry or reload: ask the user to take control of your browser and get past it (they can watch it live), or get the information another way, such as web search or another site.`
}

/**
 * In the page: what is on top at an element's centre when that isn't the
 * element itself (a cookie banner, a dialog's backdrop), as the start of its
 * HTML; null when the element is clear or off screen. Asked of the element's
 * own root, so an element inside a shadow root isn't "covered" by its host.
 */
const COVERED_SCRIPT = `(el) => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null;
  const x = r.left + r.width / 2, y = r.top + r.height / 2; if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
  const root = el.getRootNode(); const top = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
  if (!top || top === el || el.contains(top) || (top.contains && top.contains(el) && getComputedStyle(el).pointerEvents === 'none')) return null;
  if (top.closest && top.closest('#__eaon_agent_cursor')) return null;
  const html = top.outerHTML || ''; const open = html.slice(0, html.indexOf('>') + 1 || 120).slice(0, 120); return open + (html.length > open.length ? '…' : '') }`

/**
 * In Playwright: a hash of every frame's DOM, shadow roots included and the
 * agent's own cursor left out, to tell whether a click changed anything. An
 * interactive snapshot can't: text that appears (a "Saved" message, a
 * result) isn't interactive, so it showed no change for clicks that worked.
 */
const FINGERPRINT_SCRIPT = `async (page) => { let out = ''; for (const f of page.frames().slice(0, 20)) { try { out += await f.evaluate(() => {
  let h = 5381; const add = (s) => { for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0 };
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.id === '__eaon_agent_cursor') continue; if (el.shadowRoot) { add(el.shadowRoot.innerHTML); walk(el.shadowRoot) } } };
  const cursor = document.getElementById('__eaon_agent_cursor'); const html = document.documentElement.innerHTML; add(cursor ? html.replace(cursor.outerHTML, '') : html); walk(document);
  return String(h) + ':' }) } catch { out += 'x:' } } return out }`

/** Words on a snapshot line that make an element a likely way out of a banner or dialog. */
const DISMISS = /\b(accept|agree|allow all|got it|ok(ay)?|close|dismiss|no,? thanks|reject|decline|continue|not now|×|✕)\b/i

/**
 * What a failed step means, in words the model can act on. Playwright's
 * errors are long call logs; each known shape becomes what failed, why, and
 * what to try next. `what` is the step ("click button "Pay""), `refs` the
 * latest snapshot's elements (for suggesting a way out of a banner).
 */
export function explainBrowserError(error: unknown, what: string, refs?: Map<string, { role: string; name: string }>): BrowserStepError {
  if (error instanceof BrowserStepError) return error
  const raw = stripAnsi(error instanceof Error ? error.message : String(error))
  const first = raw.split('\n')[0].replace(/^Error:\s*/, '').trim()
  if (/Target crashed|Page crashed|renderer.*(gone|crash)/i.test(raw)) {
    return new BrowserStepError(`Your browser's page crashed during this step (${what}). It will be reopened on the same address at your next step; check the page then before repeating anything.`)
  }
  if (/intercepts pointer events/i.test(raw)) {
    // "- <div class="consent">…</div> intercepts pointer events", or "… from <…> subtree intercepts …".
    const blocker = /(<[^\n]{1,200}?)\s+(?:from <[^\n]+> subtree\s+)?intercepts pointer events/i.exec(raw)?.[1]
    const ways = [...(refs ?? new Map())].filter(([, el]) => /button|link/.test(el.role) && DISMISS.test(el.name)).slice(0, 3)
    return new BrowserStepError(
      `Could not ${what}: something is covering it${blocker ? ` (${blocker})` : ''}, usually a cookie banner, pop-up or dialog. Close that first${
        ways.length ? `, e.g. ${ways.map(([ref, el]) => `${el.role} "${el.name}" [ref=${ref}]`).join(' or ')}` : ' (look for Accept, Close or ✕ in a snapshot)'
      }, then try again.`
    )
  }
  if (/element is not enabled|element is disabled/i.test(raw)) {
    return new BrowserStepError(`Could not ${what}: it is disabled. Usually a required field is still empty or invalid; fill the form first (read or snapshot shows what is missing).`)
  }
  if (/element is not visible|element is outside of the viewport|element is not attached/i.test(raw)) {
    return new BrowserStepError(
      `Could not ${what}: it is on the page but hidden, e.g. inside a closed menu, a collapsed section or another tab of the page. Open whatever shows it first, or use find to look for a visible one.`,
      true
    )
  }
  if (/Element is not an <input>|not an <input>, <textarea>|is not a <select> element|Element is not a <select>/i.test(raw)) {
    return new BrowserStepError(`Could not ${what}: that element doesn't take text or options. Use a textbox or combobox ref from the latest snapshot.`, true)
  }
  if (/Execution context was destroyed|frame was detached|navigating frame was detached|because of a navigation|Navigation .* interrupted/i.test(raw)) {
    return new BrowserStepError(`The page moved to another address while trying to ${what}, so it may or may not have happened. Check the page below before doing it again.`, true)
  }
  if (/waiting for locator\(['"]?(aria-ref|\[data-eaon-find)/i.test(raw) && !/locator resolved to/i.test(raw)) {
    return new BrowserStepError(`Could not ${what}: that element is no longer on the page. The page changed after the snapshot its ref came from; use a ref from the page as it is now (below).`, true)
  }
  if (/Timeout \d+ms exceeded/i.test(raw)) {
    return new BrowserStepError(`Could not ${what}: the page didn't respond in time. Take a snapshot to see where things stand, then try again or another way.`, true)
  }
  if (/Browser target lease ended|Browser target is unavailable|Target page, context or browser has been closed|has been closed/i.test(raw)) {
    return new BrowserStepError(`Your browser lost its connection to the page while trying to ${what}. It reconnects at your next step; check the page then.`)
  }
  return new BrowserStepError(`Could not ${what}: ${first.slice(0, 300)}. Take a snapshot to see the page as it is, then try a different element or approach.`)
}

/* ---------------------------------------------------- repeated failures */

/**
 * The loop's own guard (agent/guards.ts) stops a call repeated with the very
 * same arguments, but any successful change resets it — and in a browser,
 * re-opening the page counts as one. A model stuck on one button then loops
 * forever: open, click (fails), open, click (fails). This counts failures by
 * what was aimed at — the page, the action, and the element by name — so
 * those retries add up however they are interleaved.
 */
export const MAX_ELEMENT_FAILURES = 3
const FAILURE_MEMORY_MS = 10 * 60_000

export class BrowserFailures {
  private counts = new Map<string, { count: number; last: string; at: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  private static page(url: string): string {
    return url.replace(/#.*$/, '')
  }

  key(browser: string, url: string, action: string, target: string): string {
    return `${browser}\n${BrowserFailures.page(url)}\n${action}\n${target.toLowerCase()}`
  }

  /** A refusal for a step that has already failed too often here, or null. */
  refuse(key: string, what: string): string | null {
    const entry = this.counts.get(key)
    if (!entry || entry.count < MAX_ELEMENT_FAILURES || this.now() - entry.at > FAILURE_MEMORY_MS) return null
    return (
      `Not done: trying to ${what} on this page has failed ${entry.count} times (last: ${entry.last.slice(0, 200)}). Repeating it won't help. ` +
      'Try a different route to the same goal (another button or link, the site\'s search, a different page), or tell the user what is blocking you — they can take control of your browser.'
    )
  }

  failed(key: string, message: string): void {
    const entry = this.counts.get(key)
    const fresh = !entry || this.now() - entry.at > FAILURE_MEMORY_MS
    this.counts.set(key, { count: fresh ? 1 : entry.count + 1, last: message, at: this.now() })
  }

  succeeded(key: string): void {
    this.counts.delete(key)
  }

  /** Typing or choosing changes a form, which can unblock a button that failed before. */
  pageChanged(browser: string, url: string): void {
    const prefix = `${browser}\n${BrowserFailures.page(url)}\n`
    for (const key of [...this.counts.keys()]) if (key.startsWith(prefix)) this.counts.delete(key)
  }
}

/* --------------------------------------------------------------- uploads */

/** Folders whose files are credentials or keys: never sent to a website without the user's say-so. */
const SECRET_PATH = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.azure|\.config[\\/]gcloud|\.config[\\/]gh|Keychains|\.password-store)([\\/]|$)|(^|[\\/])(\.netrc|\.npmrc|\.pypirc|\.env(\.[\w-]+)?|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|credentials(\.json)?)$/i

export function isSecretPath(path: string): boolean {
  return SECRET_PATH.test(path)
}

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
  /** A browser being created, so two calls at once (read-only snapshots run in parallel) share one window. */
  private creating = new Map<string, Promise<Session>>()
  /** Live views watching each browser's frames; see `watchFrames`. */
  private frameWatchers = new Map<string, Set<FrameListener>>()
  /** Each browser's live-view capture loop, while one runs; see `pump`. */
  private pumping = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * `partition` names each browser's persistent session; workers get
   * `persist:worker-<id>`. The chat agent's one browser (features/agentBrowser.ts)
   * uses its own, so its logins are never a worker's.
   */
  /** Runs sharing one browser (the chat agent's, used by every chat): which one is using it now. */
  private holders = new Map<string, { runId: string; label: string }>()

  constructor(
    private readonly options: {
      partition?: (id: string) => string
      title?: string
      /** How long `open` waits for a page to start showing before giving up on it. */
      openTimeoutMs?: number
    } = {}
  ) {}

  private session(workerId: string): Promise<Session> {
    const session = this.sessions.get(workerId)
    if (session && !session.window.isDestroyed()) return Promise.resolve(session)
    let creating = this.creating.get(workerId)
    if (!creating) {
      creating = this.create(workerId).finally(() => this.creating.delete(workerId))
      this.creating.set(workerId, creating)
    }
    return creating
  }

  private async create(workerId: string): Promise<Session> {
    let session = this.sessions.get(workerId)
    const notes: string[] = []
    if (session) {
      // The window went away under us. Its connection still holds the
      // session's lease, and a new one can't attach until it lets go.
      this.sessions.delete(workerId)
      session.unhook()
      await closeQuietly(session.browser)
      notes.push('Your browser window was closed and has been opened again, on a blank page; open the page you were on.')
    }
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
    // Look like the Chrome it is. Electron's default agent names Electron and
    // the app ("eaon-desktop/2026.6.0 … Electron/43.7.7"), which bot checks
    // (Cloudflare, Akamai, Google sign-in) answer with a challenge, a block
    // or a stripped-down page.
    window.webContents.setUserAgent(chromeUserAgent(window.webContents.getUserAgent()))
    // Closing the window only hides it: the session, its logins and the
    // worker's place in a task survive the user looking away.
    window.on('close', (event) => {
      if (!this.sessions.has(workerId)) return
      event.preventDefault()
      window.hide()
    })
    const contents = window.webContents
    const fresh: Session = {
      window,
      browser: null,
      takeover: new AbortController(),
      refs: new Map(),
      findFrames: new Map(),
      queue: Promise.resolve(),
      cursor: null,
      control: null,
      crashed: null,
      notes,
      popup: null,
      download: null,
      lastDownloadUrl: null,
      status: null,
      loadError: null,
      chooser: null,
      intercepting: false,
      unhook: () => undefined,
      busy: 0,
      inputAt: 0,
      parkTimer: null,
      parked: null
    }
    // There are no tabs. A link with target=_blank or a window.open() would
    // otherwise become a real, visible window on the user's screen, in this
    // agent's session, which the agent never sees — and which stops
    // BetterWright attaching again, since it needs the session to itself.
    // The address is kept and opened in this window after the step.
    // The exception is the user in the real window, signing in: a sign-in
    // pop-up works there as in any browser.
    contents.setWindowOpenHandler(({ url }) => {
      if (window.isVisible()) return { action: 'allow', overrideBrowserWindowOptions: { parent: window } }
      if (/^https?:/i.test(url)) fresh.popup = url
      return { action: 'deny' }
    })
    // A killed or crashed renderer leaves a dead page that every later step
    // would time out on; the next step reopens it (see `recover`).
    contents.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') fresh.crashed = details.reason
    })
    contents.on('did-navigate', (_event, url, code, text) => {
      fresh.status = { url, code, text }
    })
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is a load given up for another (a redirect, a download).
      if (isMainFrame && code !== -3) fresh.loadError = { url, code, description }
    })
    // BetterWright cancels every download (its policy: no files without the
    // host's say-so). Without this the agent's click on "Download" seemed to
    // do nothing at all; now it is told what the file was and how to get it.
    const onDownload = (_event: Electron.Event, item: Electron.DownloadItem, from: Electron.WebContents): void => {
      if (from !== contents) return
      fresh.download = { url: item.getURL(), filename: item.getFilename(), mime: item.getMimeType(), size: item.getTotalBytes() }
      fresh.lastDownloadUrl = fresh.download.url
    }
    contents.session.on('will-download', onDownload)
    fresh.unhook = () => contents.session.removeListener('will-download', onDownload)
    // The intercepted file picker (see `intercept`) is announced on the
    // window's own debugger session, which has no session id.
    contents.debugger.on('message', (_event, method, params, sessionId) => {
      if (method === 'Page.fileChooserOpened' && !sessionId) {
        fresh.chooser = { backendNodeId: Number(params.backendNodeId), multiple: params.mode === 'selectMultiple' }
      }
    })
    await contents.loadURL('about:blank')
    session = fresh
    this.sessions.set(workerId, session)
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

  /**
   * File pickers are intercepted through the window's own debugger session
   * (the one BetterWright shares and never detaches): clicking a file input
   * in this hidden window otherwise opens a native Open dialog, which shows
   * the window on the user's screen and waits there for them. Intercepted,
   * the page reports which input wanted a file, and `upload` fills it. Needs
   * the Page domain enabled on this session, or the dialog still opens.
   */
  private async intercept(session: Session): Promise<void> {
    if (session.intercepting || session.window.isDestroyed()) return
    const dbg = session.window.webContents.debugger
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
      await dbg.sendCommand('Page.enable')
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      session.intercepting = true
    } catch {
      /* uploads then fail with a clear message; nothing else depends on this */
    }
  }

  /**
   * A page whose renderer died (killed, out of memory, a crash) is reopened
   * before the next step: its old connection is closed, the window is put on
   * a blank page (which needs no network, since the closed connection's
   * proxy is gone), a new connection is attached and the last address is
   * loaded again. The agent hears about it with that step's result.
   */
  private async recover(session: Session): Promise<void> {
    const reason = session.crashed
    if (!reason || session.window.isDestroyed()) return
    session.crashed = null
    const contents = session.window.webContents
    const last = session.status?.url && /^https?:/i.test(session.status.url) ? session.status.url : contents.getURL()
    const browser = session.browser
    session.browser = null
    session.intercepting = false
    session.refs = new Map()
    session.cursor = null
    // The page first: closing the old connection sends commands to the dead
    // renderer, which wait until a new one is running (measured: forever
    // before, 15 ms after).
    await Promise.race([contents.loadURL('about:blank').catch(() => {}), sleep(10_000)])
    await closeQuietly(browser)
    const fresh = await this.attach(session)
    resultText(await fresh.run('return 1'))
    await this.intercept(session)
    let where = 'a blank page'
    if (/^https?:/i.test(last)) {
      const loaded = await this.navigateContents(session, last, this.options.openTimeoutMs ?? 30_000).catch(() => 'failed' as const)
      where = loaded === 'arrived' ? last : `a blank page (reopening ${last} failed)`
      if (loaded === 'arrived') await this.waitReady(fresh)
    }
    session.notes.push(
      `Your browser's page crashed (${reason.replace(/-/g, ' ')}) and was reopened on ${where}. Anything typed there that wasn't submitted is gone, and your last step may not have finished; check the page before repeating it.`
    )
  }

  /** Waits, through `browser`, until the page's DOM is usable. Bounded; a slow page is used as it is. */
  private async waitReady(browser: BetterWrightInstance): Promise<void> {
    await browser.run(UNTIL_READY).catch(() => undefined)
  }

  /**
   * Loads `url` in the window through Electron, settling on the first sign
   * the new page is there (its navigation committing, dom-ready, or the load
   * stopping — dom-ready alone was sometimes never seen). A load that fails
   * outright rejects with what to do about it; one where nothing arrives in
   * `timeoutMs` is stopped, leaving the page that was there, and resolves
   * 'timeout'. Aborting stops the load.
   */
  private navigateContents(
    session: Session,
    url: string,
    timeoutMs: number,
    signal?: AbortSignal,
    go: () => void = () => void session.window.webContents.loadURL(url).catch(() => {})
  ): Promise<'arrived' | 'timeout'> {
    const contents = session.window.webContents
    const signals = ['did-navigate', 'dom-ready', 'did-stop-loading'] as const
    return new Promise<'arrived' | 'timeout'>((resolve, reject) => {
      const cleanup = (): void => {
        for (const name of signals) contents.off(name as 'dom-ready', done)
        contents.off('did-fail-load', failed)
        signal?.removeEventListener('abort', aborted)
        clearTimeout(timer)
      }
      const done = (): void => {
        cleanup()
        resolve('arrived')
      }
      const failed = (_e: unknown, code: number, description: string, _url: string, isMainFrame: boolean): void => {
        if (!isMainFrame || code === -3) return // -3: given up for another load, e.g. a redirect or a download
        cleanup()
        reject(new NavigationFailed(url, description || String(code)))
      }
      const aborted = (): void => {
        cleanup()
        if (!contents.isDestroyed()) contents.stop()
        reject(new Error('Stopped by the user.'))
      }
      const timer = setTimeout(() => {
        cleanup()
        // Whatever is still loading would otherwise land later, under the agent's next step.
        if (!contents.isDestroyed()) contents.stop()
        resolve('timeout')
      }, timeoutMs)
      if (signal?.aborted) return aborted()
      signal?.addEventListener('abort', aborted, { once: true })
      for (const name of signals) contents.on(name as 'dom-ready', done)
      contents.on('did-fail-load', failed)
      go()
    })
  }

  /** Runs one step's code in the worker's browser, one step at a time per worker. */
  async run(workerId: string, code: string): Promise<string> {
    const session = await this.session(workerId)
    return this.enqueue(workerId, session, async (browser) => {
      const out = resultText(await browser.run(code))
      if (!session.intercepting) await this.intercept(session)
      return out
    })
  }

  /** `work` in its turn on the browser's queue: a crashed page reopened, connected, and a parked page brought back first. */
  private enqueue<T>(workerId: string, session: Session, work: (browser: BetterWrightInstance) => Promise<T>): Promise<T> {
    this.begin(workerId, session)
    const step = session.queue.then(async () => {
      await this.recover(session)
      const browser = await this.attach(session)
      await this.unpark(session)
      return work(browser)
    })
    session.queue = step.catch(() => {})
    const done = (): void => this.end(workerId, session)
    void step.then(done, done)
    return step
  }

  /** Something starts on the page (a step, an open, a back): it must not be parked under it, and a live view follows. */
  private begin(workerId: string, session: Session): void {
    session.busy++
    if (session.parkTimer) clearTimeout(session.parkTimer)
    session.parkTimer = null
    this.pump(workerId)
  }

  private end(workerId: string, session: Session): void {
    session.busy = Math.max(0, session.busy - 1)
    if (session.busy > 0 || this.sessions.get(workerId) !== session) return
    this.armPark(workerId, session)
    if (this.frameWatchers.get(workerId)?.size) setTimeout(() => void this.deliver(workerId), SETTLE_MS).unref?.()
  }

  /* ----------------------------------------------------------------- parking */

  /** Parks the page once the browser has gone PARK_AFTER_MS without a step. */
  private armPark(workerId: string, session: Session): void {
    if (session.parkTimer) clearTimeout(session.parkTimer)
    session.parkTimer = setTimeout(() => {
      session.parkTimer = null
      if (session.busy > 0 || this.sessions.get(workerId) !== session || session.window.isDestroyed()) return
      // In use all the same: the user has taken over, or is looking at the real window. Later, then.
      if (session.control || session.window.isVisible()) return this.armPark(workerId, session)
      session.queue = session.queue.then(() => this.park(session)).catch(() => {})
    }, PARK_AFTER_MS)
    session.parkTimer.unref?.()
  }

  /**
   * Puts the page away: about:blank, which costs nothing to keep open, with
   * where it was and a last picture of it kept for the live view. The
   * connection, the logins and the window stay, so bringing it back is one
   * step back through history (`unpark`).
   */
  private async park(session: Session): Promise<void> {
    const { window } = session
    if (session.parked || session.busy > 0 || session.control || window.isDestroyed() || window.isVisible()) return
    const contents = window.webContents
    const url = contents.getURL()
    if (!url || url === 'about:blank') return
    const frame = (await within(contents.capturePage().catch(() => null), 5000)) ?? null
    const title = contents.getTitle()
    // Waits for about:blank itself to commit. loadURL's own promise can fail
    // early while the page goes anyway (the old page's loading stopping looks
    // like a failure to it), and a page that went unrecorded would leave the
    // agent's next step on a blank page.
    // Settled once it has finished loading too, so nothing of it is still to
    // come when the page is brought back.
    await new Promise<void>((resolve) => {
      let committed = false
      const done = (): void => {
        contents.off('did-navigate', navigated)
        contents.off('did-stop-loading', stopped)
        contents.off('did-fail-load', failed)
        clearTimeout(timer)
        resolve()
      }
      const navigated = (_e: unknown, to: string): void => {
        if (to === 'about:blank') committed = true
      }
      const stopped = (): void => {
        if (committed) done()
      }
      const failed = (_e: unknown, _code: number, _description: string, url: string, isMainFrame: boolean): void => {
        if (isMainFrame && url === 'about:blank') done()
      }
      // A page guarding unsaved work (beforeunload) refuses to go, and nothing more is heard.
      const timer = setTimeout(done, 10_000)
      contents.on('did-navigate', navigated)
      contents.on('did-stop-loading', stopped)
      contents.on('did-fail-load', failed)
      contents.loadURL('about:blank').catch(() => {})
    })
    // Refused: it stays as it is.
    if (window.isDestroyed() || contents.getURL() !== 'about:blank') return
    session.parked = { url, title, index: contents.navigationHistory.getActiveIndex(), frame: frame && !frame.isEmpty() ? frame : null }
  }

  /**
   * Brings a parked page back by going back to it, so it is where it was —
   * often straight from the back-forward cache, with what was typed into it
   * — and then drops the blank entry the park added, so back still goes
   * where it went before.
   */
  private async unpark(session: Session): Promise<void> {
    const parked = session.parked
    if (!parked) return
    session.parked = null
    const contents = session.window.webContents
    if (contents.isDestroyed()) return
    const history = contents.navigationHistory
    // Still on the blank page (the user may have gone elsewhere in the real window since).
    if (history.getActiveIndex() === parked.index && contents.getURL() === 'about:blank') {
      const go = history.canGoBack() ? () => history.goBack() : () => void contents.loadURL(parked.url).catch(() => {})
      await within(this.navigateContents(session, parked.url, 30_000, undefined, go).catch(() => undefined), 30_000)
      await session.browser?.run(UNTIL_READY).catch(() => {})
    }
    if (contents.isDestroyed()) return
    if (history.getActiveIndex() !== parked.index && history.getEntryAtIndex(parked.index)?.url === 'about:blank') history.removeEntryAtIndex(parked.index)
  }

  /** Brings a parked page back outside a step: for the user, showing the window or taking over. */
  private wake(workerId: string, session: Session): Promise<void> {
    return this.enqueue(workerId, session, async () => undefined).catch(() => {})
  }

  /** Notes for the agent about what happened since its last step (a crash, a reopened window); cleared once read. */
  takeNotes(workerId: string): string[] {
    const session = this.sessions.get(workerId)
    if (!session || session.notes.length === 0) return []
    const notes = session.notes
    session.notes = []
    return notes
  }

  /** Forgets what the page did since the last look: a step starts clean. */
  beginStep(workerId: string): void {
    const session = this.sessions.get(workerId)
    if (!session) return
    session.popup = null
    session.download = null
    session.loadError = null
    session.chooser = null
  }

  /** The address of a new tab the page asked for during the step, if it did. */
  takePopup(workerId: string): string | null {
    const session = this.sessions.get(workerId)
    const url = session?.popup ?? null
    if (session) session.popup = null
    return url
  }

  /** A download the page started during the step, if it did. */
  takeDownload(workerId: string): AttemptedDownload | null {
    const session = this.sessions.get(workerId)
    const download = session?.download ?? null
    if (session) session.download = null
    return download
  }

  /** The last file the page tried to download, whenever that was. */
  lastDownloadUrl(workerId: string): string | null {
    return this.sessions.get(workerId)?.lastDownloadUrl ?? null
  }

  /** The latest snapshot's elements, for suggesting a way past a banner when a click is blocked. */
  refsOf(workerId: string): Map<string, { role: string; name: string }> {
    return this.sessions.get(workerId)?.refs ?? new Map()
  }

  /** How long `open` waits for a page to start showing. */
  openTimeoutMs(): number {
    return this.options.openTimeoutMs ?? 30_000
  }

  /** A file picker the page opened during the step, if it did. */
  pendingChooser(workerId: string): boolean {
    return Boolean(this.sessions.get(workerId)?.chooser)
  }

  /** The main page's failed load during the step (a link to a site that is down), if there was one. */
  takeLoadError(workerId: string): { url: string; code: number; description: string } | null {
    const session = this.sessions.get(workerId)
    const error = session?.loadError ?? null
    if (session) session.loadError = null
    return error
  }

  /** What the page's last HTTP answer says about it: an error status or a bot wall, for the agent to hear. */
  pageNote(workerId: string): string | null {
    const session = this.sessions.get(workerId)
    if (!session || session.window.isDestroyed()) return null
    const contents = session.window.webContents
    const status = session.status && session.status.url === contents.getURL() ? session.status : null
    const wall = botWallNote({ title: contents.getTitle(), ...(status ? { status: status.code } : {}) })
    if (wall) return wall
    return status ? httpStatusNote(status.code, status.text) : null
  }

  /** The page's visible text, for telling a bot wall served with a 403 from an ordinary refusal. */
  async pageNoteDeep(workerId: string): Promise<string | null> {
    const quick = this.pageNote(workerId)
    const session = this.sessions.get(workerId)
    if (!session || !session.status || session.status.code < 400 || /anti-bot/.test(quick ?? '')) return quick
    const text = await this.run(workerId, `return (await page.evaluate(() => (document.body?.innerText ?? '') + ' ' + document.documentElement.outerHTML.slice(0, 3000))).slice(0, 6000)`).catch(() => '')
    return botWallNote({ title: session.window.webContents.getTitle(), text, status: session.status.code }) ?? quick
  }

  /**
   * Which run is using a browser that several share. The chat agent has one
   * browser for every chat (it keeps its logins there), so two chats — or a
   * chat and a scheduled task — would otherwise click through each other's
   * pages with refs from the wrong snapshot. A second run waits a little for
   * the first to finish, then is told plainly. A run that ended (`alive`
   * false) holds nothing.
   */
  async claim(
    workerId: string,
    run: { id: string; label: string },
    alive: (runId: string) => boolean,
    signal: AbortSignal,
    waitMs = 30_000
  ): Promise<{ ok: true; note: string | null } | { ok: false; text: string }> {
    const until = Date.now() + waitMs
    for (;;) {
      const holder = this.holders.get(workerId)
      if (!holder || holder.runId === run.id || !alive(holder.runId)) {
        this.holders.set(workerId, { runId: run.id, label: run.label })
        const handedOver = holder && holder.runId !== run.id ? holder : null
        return { ok: true, note: handedOver ? `Your browser was last used by another conversation${handedOver.label ? ` ("${handedOver.label}")` : ''}, so its page may not be where you left it.` : null }
      }
      if (signal.aborted) throw new Error('Stopped by the user.')
      if (Date.now() >= until) {
        return {
          ok: false,
          text: `Your browser is busy: another conversation${holder.label ? ` ("${holder.label}")` : ''} is using it right now, and two can't share one page. Use web search or web_fetch for reading meanwhile, or try the browser again once that conversation's reply has finished.`
        }
      }
      await sleep(250)
    }
  }

  async snapshot(workerId: string, diff = false): Promise<string> {
    const code = `return await snapshot({ interactive: true, maxChars: 20000${diff ? ', diff: true' : ''} })`
    let text = ''
    let reattached = false
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
        // A connection that lost track of its page (the old Electron 33 bug,
        // should it come back): attach afresh, once, and look again.
        if (!reattached && /does not match any element|Target closed|has been closed|detached/i.test(String(error))) {
          reattached = true
          await this.reattach(workerId)
          attempt = -1
          continue
        }
        // Some pages (XHTML ones, like iana.org) can't be snapshotted: give their text instead.
        if (/does not match any element/i.test(String(error))) {
          const page = await this.run(workerId, `return (await page.title()) + '\\n' + page.url() + '\\n\\n' + (await page.evaluate(() => document.body?.innerText ?? document.documentElement?.innerText ?? '')).slice(0, 8000)`)
          return `${clip(redactPaymentSecrets(page), 8000)}\n\n(This page can't be snapshotted; above is its text. Use find {text} to get refs for links or buttons.)`
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
    // A checkout snapshot shows what was typed into each field, card number included.
    return clip(redactPaymentSecrets(text))
  }

  /**
   * After a step that navigated (a link to another site, back): wait until
   * the new page is usable, through the same connection.
   *
   * This used to close BetterWright and attach afresh after every navigation
   * — a workaround for Electron 33, where Playwright's view of a page that
   * swapped renderer process went stale. It was the main reason sites loaded
   * slowly or not at all: attaching points the session at that worker's own
   * proxy and calls `closeAllConnections()`, so the page being loaded lost its
   * proxy mid-flight, then had every in-flight request cut, on top of a new
   * worker process starting each time. On Electron 43 the connection follows
   * the navigation, so this only waits; `reattach` stays as the fallback for
   * a connection that really did go stale (see `snapshot`).
   */
  async landed(workerId: string): Promise<void> {
    const session = this.sessions.get(workerId)
    if (!session || session.window.isDestroyed()) return
    await this.run(workerId, UNTIL_READY).catch(() => undefined)
  }

  /** Closes BetterWright and attaches afresh to the same window: for a connection that lost track of its page. */
  private async reattach(workerId: string): Promise<void> {
    const session = this.sessions.get(workerId)
    if (!session || session.window.isDestroyed()) return
    session.queue = session.queue.then(async () => {
      const browser = session.browser
      session.browser = null
      await closeQuietly(browser)
      await (await this.attach(session)).run(UNTIL_READY).catch(() => {})
    })
    await session.queue
  }

  /**
   * Opens a page through Electron rather than Playwright: on Electron 33,
   * Playwright sometimes never sees the load events of a page that swapped
   * renderer process, and page.goto waits out its timeout. Electron's own
   * loadURL settles reliably (see `navigateContents`); `landed` then waits,
   * through the same connection, until the page is usable.
   *
   * 'timeout' means nothing arrived in time and the old page is still there.
   * A load that fails outright throws a `BrowserStepError` saying what to do.
   */
  async open(workerId: string, url: string, signal?: AbortSignal): Promise<'arrived' | 'timeout'> {
    const session = await this.session(workerId)
    // Busy throughout, loading included: a live view follows the page in, and it isn't parked meanwhile.
    this.begin(workerId, session)
    try {
      return await this.openIn(workerId, session, url, signal)
    } finally {
      this.end(workerId, session)
    }
  }

  private async openIn(workerId: string, session: Session, url: string, signal?: AbortSignal): Promise<'arrived' | 'timeout'> {
    // Connected first: without BetterWright's guard proxy up, the load stalls.
    await this.run(workerId, 'return 1')
    session.download = null
    session.loadError = null
    let outcome: 'arrived' | 'timeout'
    try {
      outcome = await this.navigateContents(session, url, this.options.openTimeoutMs ?? 30_000, signal)
    } catch (error) {
      if (!(error instanceof NavigationFailed)) throw error
      // Through the proxy, "no such site" and "refused" look the same; a lookup here tells them apart.
      let resolves: boolean | undefined
      if (/SOCKS_CONNECTION_FAILED/.test(error.code)) {
        try {
          const host = new URL(url).hostname
          resolves = await Promise.race([
            lookup(host).then(
              () => true,
              () => false
            ),
            sleep(3000).then(() => undefined)
          ])
        } catch {
          /* not a URL we can look up */
        }
      }
      throw new BrowserStepError(netErrorAdvice(error.code, url, resolves))
    }
    if (outcome === 'arrived') await this.landed(workerId)
    return outcome
  }

  /** The page this worker's browser is on now (a parked one counts as where it was). */
  url(workerId: string): string {
    return this.page(workerId).url
  }

  /** The page's address and title, for the live view; a parked page's as they were. */
  page(workerId: string): { url: string; title: string } {
    const session = this.sessions.get(workerId)
    if (!session || session.window.isDestroyed()) return { url: '', title: '' }
    if (session.parked) return { url: session.parked.url, title: session.parked.title }
    return { url: session.window.webContents.getURL(), title: session.window.webContents.getTitle() }
  }

  /** The browser's own back button, with the same wait-and-reconnect as a click that navigates. */
  async back(workerId: string): Promise<boolean> {
    const session = this.sessions.get(workerId)
    if (!session || session.window.isDestroyed()) return false
    // Back from the page it was on, not from the blank one it was parked on.
    if (session.parked) await this.wake(workerId, session)
    const contents = session.window.webContents
    if (contents.isDestroyed() || !contents.navigationHistory.canGoBack()) return false
    this.begin(workerId, session)
    try {
      contents.navigationHistory.goBack()
      await this.landed(workerId)
    } finally {
      this.end(workerId, session)
    }
    return true
  }

  /**
   * The interactive elements whose text or label contains `query`, each with
   * a ref — the way into a page too big to snapshot whole.
   */
  async find(workerId: string, query: string): Promise<string> {
    const found = await this.findRefs(workerId, query)
    if (found.length === 0) return `Nothing on this page matches "${query}".`
    return redactPaymentSecrets(found.map((el) => `- ${el.role} "${el.name}"${el.href ? ` (${el.href.slice(0, 80)})` : ''} [ref=${el.ref}]`).join('\n'))
  }

  /**
   * The interactive elements matching `query`, each with a ref (`find-N`)
   * usable until the next find. Looks inside open shadow roots (web
   * components) and in every frame, as the snapshot does; a match in a frame
   * remembers which one, so its ref is looked up there.
   */
  async findRefs(workerId: string, query: string): Promise<{ ref: string; role: string; name: string; href: string }[]> {
    const finder =
      `([q, start, limit]) => { const roots = [document]; const all = [];` +
      ` const sel = 'a, button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=option], [contenteditable=true]';` +
      ` for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll('*')) { if (el.shadowRoot) roots.push(el.shadowRoot); if (el.hasAttribute('data-eaon-find')) el.removeAttribute('data-eaon-find'); if (el.matches(sel)) all.push(el) }` +
      ` const out = []; for (const el of all) { if (out.length >= limit) break;` +
      ` const name = ((el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.value || '').replace(/\\s+/g, ' ').slice(0, 80);` +
      ` const hay = (name + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('href') || '')).toLowerCase();` +
      ` if (!hay.includes(q)) continue; const rect = el.getBoundingClientRect(); if (!rect.width && !rect.height) continue;` +
      ` const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button' : el.tagName === 'SELECT' ? 'combobox' : el.type === 'password' ? 'password' : el.type === 'file' ? 'file input' : el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? 'textbox' : el.tagName.toLowerCase());` +
      ` el.setAttribute('data-eaon-find', String(start + out.length)); out.push({ role, name, href: el.getAttribute('href') || '' }) } return out }`
    const code =
      `const finder = ${finder}; const out = []; const frames = page.frames().slice(0, 20);` +
      ` for (let k = 0; k < frames.length; k++) { let found = []; try { found = await frames[k].evaluate(finder, [${JSON.stringify(query.toLowerCase())}, out.length, Math.max(0, 15 - out.length)]) } catch {}` +
      ` for (const el of found) out.push({ ...el, frame: k }) } return JSON.stringify(out)`
    const raw = await this.run(workerId, code)
    let found: { role: string; name: string; href: string; frame?: number }[] = []
    try {
      found = JSON.parse(raw)
    } catch {
      found = []
    }
    const session = this.sessions.get(workerId)
    session?.findFrames.clear()
    return found.map((el, i) => {
      session?.refs.set(`find-${i}`, { role: el.role, name: el.name })
      if (el.frame) session?.findFrames.set(`find-${i}`, el.frame)
      return { ref: `find-${i}`, role: el.role, name: el.name, href: el.href }
    })
  }

  /** Playwright code for a ref's element in this browser. */
  locator(workerId: string, ref: string): string {
    return locatorFor(ref, this.sessions.get(workerId)?.findFrames.get(ref))
  }

  /**
   * Whether a ref's element is still there and can be acted on — asked at
   * once, rather than learned from a click that waits out its whole timeout
   * (a stale ref used to cost 18 s before failing with a call log). Null
   * when it couldn't be told; the step then goes ahead as before.
   */
  async probe(workerId: string, ref: string): Promise<{ found: false } | { found: true; tag: string; type: string; disabled: boolean; editable: boolean } | null> {
    const code =
      `const loc = ${this.locator(workerId, ref)}; if ((await loc.count()) === 0) return JSON.stringify({ found: false });` +
      ` return JSON.stringify(await loc.first().evaluate((el) => ({ found: true, tag: el.tagName, type: (el.getAttribute('type') || '').toLowerCase(),` +
      ` disabled: Boolean(el.disabled || (el.closest && el.closest('fieldset[disabled]')) || el.getAttribute('aria-disabled') === 'true'),` +
      ` editable: Boolean(el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || /^(textbox|combobox|searchbox|spinbutton|listbox)$/.test(el.getAttribute('role') || '')) }), null, { timeout: 3000 }))`
    try {
      const parsed = JSON.parse(await this.run(workerId, code))
      return parsed && typeof parsed === 'object' && 'found' in parsed ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * Chooses `files` (absolute paths) in the file picker that clicking `ref`
   * opens — a file input, or the "Upload" button standing in for one. The
   * picker is intercepted (see `intercept`), so no dialog appears; the files
   * are set on the input it was opened for, which fires the page's own
   * change events.
   */
  async upload(workerId: string, ref: string, files: string[]): Promise<void> {
    const session = await this.session(workerId)
    await this.run(workerId, 'return 1')
    await this.intercept(session)
    if (!session.intercepting) throw new BrowserStepError('Uploading isn\'t available in this browser right now (its file picker couldn\'t be intercepted). Ask the user to take control of your browser and choose the file.')
    session.chooser = null
    await this.run(workerId, `await ${this.locator(workerId, ref)}.click({ timeout: 10000 }); return 'ok'`)
    // Set by the debugger's message listener while the click runs.
    const opened = (): Session['chooser'] => session.chooser
    for (let i = 0; i < 30 && !opened(); i++) await sleep(100)
    const chooser = opened()
    session.chooser = null
    if (!chooser) {
      throw new BrowserStepError(`Clicking ${ref} didn't open a file picker. Use upload on the file input itself, or on the button next to it that says something like "Upload", "Choose file" or "Browse".`, true)
    }
    if (files.length > 1 && !chooser.multiple) throw new BrowserStepError('That file input takes one file at a time. Upload them one by one.')
    await session.window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { files, backendNodeId: chooser.backendNodeId })
  }

  /**
   * Saves `url` to `dest` through this browser's own session: its cookies
   * (so a file behind the agent's sign-in comes too) and BetterWright's
   * guard proxy (so the same address rules apply). For the downloads
   * BetterWright won't let the page start itself.
   */
  async download(workerId: string, url: string, dest: string, signal: AbortSignal, maxBytes = 500 * 1024 * 1024): Promise<{ path: string; bytes: number; mime: string }> {
    const session = await this.session(workerId)
    await this.run(workerId, 'return 1')
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 5 * 60_000)
    let handle: Awaited<ReturnType<typeof openFile>> | null = null
    let written: string | null = null
    try {
      const response = await session.window.webContents.session.fetch(url, { signal: controller.signal, credentials: 'include' } as RequestInit)
      if (!response.ok) throw new BrowserStepError(`Could not download ${url}: ${httpStatusNote(response.status, response.statusText) ?? `HTTP ${response.status}`}`)
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > maxBytes) throw new BrowserStepError(`Did not download ${url}: it is ${Math.round(declared / 1048576)} MB, over the ${Math.round(maxBytes / 1048576)} MB limit.`)
      const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(response.headers.get('content-disposition') ?? '')?.[1]
      const path = await freePath(/[\\/]$/.test(dest) || !extname(dest) ? join(dest, safeName(named ? decodeURIComponent(named) : basename(new URL(url).pathname) || 'download')) : dest)
      await mkdir(dirname(path), { recursive: true })
      handle = await openFile(path, 'wx')
      written = path
      let bytes = 0
      const reader = response.body?.getReader()
      for (;;) {
        const chunk = reader ? await reader.read() : { done: true as const, value: undefined }
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > maxBytes) {
          controller.abort()
          throw new BrowserStepError(`Stopped downloading ${url}: it passed the ${Math.round(maxBytes / 1048576)} MB limit.`)
        }
        await handle.write(chunk.value)
      }
      written = null
      return { path, bytes, mime: response.headers.get('content-type') ?? '' }
    } catch (error) {
      // A half-written file would look like the real thing.
      if (written) {
        await handle?.close().catch(() => {})
        handle = null
        await rm(written, { force: true }).catch(() => {})
      }
      if (signal.aborted) throw new Error('Stopped by the user.')
      if (error instanceof BrowserStepError) throw error
      throw new BrowserStepError(`Could not download ${url}: ${stripAnsi(String((error as Error)?.message ?? error)).slice(0, 200)}. Check the address; if the file needs a sign-in the browser doesn't have, ask the user.`)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      await handle?.close().catch(() => {})
    }
  }

  /**
   * Types a value the model must not see (a card number) into a ref. The
   * value never comes back: errors have it blanked, and the caller returns
   * no snapshot. A <select> (expiry month or year) gets the matching option.
   */
  async fillSecret(workerId: string, ref: string, value: string): Promise<void> {
    if (!isRef(ref)) throw new Error(`"${ref}" is not a ref from your latest snapshot.`)
    if (!this.window(workerId)) throw new Error('Your browser has no page open.')
    if (this.controlled(workerId)) throw new Error('The user has taken control of your browser. Wait until they hand it back, then snapshot again.')
    const locator = this.locator(workerId, ref)
    await this.pointAt(workerId, locator, 'type')
    const v = js(value)
    const code =
      `const loc = ${locator}; const tag = await loc.evaluate((el) => el.tagName, null, { timeout: 10000 });` +
      ` if (tag === 'SELECT') { const v = ${v}; const tries = [{ value: v }, { label: v }, { value: String(Number(v)) }, { label: String(Number(v)) }, { value: v.slice(-2) }, { label: v.slice(-2) }];` +
      ` let ok = false; for (const t of tries) { try { await loc.selectOption(t, { timeout: 2000 }); ok = true; break } catch {} } if (!ok) throw new Error('no option in that list matched') }` +
      ` else { await loc.click({ timeout: 10000 }); await loc.fill('', { timeout: 10000 }).catch(() => {});` +
      ` if (typeof loc.pressSequentially === 'function') await loc.pressSequentially(${v}, { delay: 35, timeout: 20000 }); else await loc.fill(${v}, { timeout: 10000 }) }` +
      ` return 'ok'`
    try {
      await this.run(workerId, code)
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      throw new Error(`Could not type into ${ref}: ${value ? message.split(value).join('••••') : message}`)
    }
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

  /**
   * A clean PNG of the page, no ref boxes, copied to `dest`. With `fullPage`
   * it first scrolls through the page so lazy images load, then captures the
   * whole scrollable length.
   */
  async saveScreenshot(workerId: string, dest: string, fullPage: boolean): Promise<void> {
    const warm = fullPage
      ? `await page.evaluate(async () => { const step = innerHeight || 800; for (let y = 0; y < document.documentElement.scrollHeight && y < 30000; y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)) } scrollTo(0, 0) }).catch(() => {}); await page.waitForTimeout(300);`
      : ''
    const text = await this.run(workerId, `${warm} const shot = await screenshot({ fullPage: ${fullPage}, type: 'png' }); return shot.path`)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(text.replace(/^"|"$/g, ''), dest)
  }

  async title(workerId: string): Promise<string> {
    return (await this.run(workerId, 'return await page.title()')).replace(/^"|"$/g, '')
  }

  /**
   * Links on the page that stay on `site` (a hostname, subdomains allowed),
   * without fragments, de-duplicated and capped in the page so the list fits
   * one result.
   */
  async siteLinks(workerId: string, site: string): Promise<string[]> {
    const code =
      `return await page.evaluate((site) => { const out = new Set(); let size = 0; for (const a of document.querySelectorAll('a[href]')) {` +
      ` let u; try { u = new URL(a.href, location.href) } catch { continue } if (!/^https?:$/.test(u.protocol)) continue;` +
      ` const host = u.hostname.replace(/^www\\./, ''); if (host !== site && !host.endsWith('.' + site)) continue; u.hash = '';` +
      ` if (u.href.length > 300) continue; out.add(u.href); size += u.href.length + 3; if (size > 9000) break } return [...out] }, ${js(site)})`
    try {
      let parsed: unknown = JSON.parse(await this.run(workerId, code))
      if (typeof parsed === 'string') parsed = JSON.parse(parsed)
      return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : []
    } catch {
      return []
    }
  }

  /** The user's view of a worker's browser: shown to watch or to sign in; hidden again after. */
  async show(workerId: string): Promise<boolean> {
    const session = this.sessions.get(workerId)
    if (!session || session.window.isDestroyed()) return false
    // The page it was on, not the blank one it was parked on.
    if (session.parked) await this.wake(workerId, session)
    if (session.window.isDestroyed()) return false
    session.window.show()
    session.window.focus()
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
   * Pictures of the page for a live view: one as it opens, then one every
   * FRAME_MS while a step runs or the user has control, one as that stops
   * and one more a moment later. A page left alone between steps costs
   * nothing to watch. (This was Electron's frame subscription, which copied
   * the whole page on every paint for as long as a view was open.)
   */
  watchFrames(workerId: string, listener: FrameListener): () => void {
    let listeners = this.frameWatchers.get(workerId)
    if (!listeners) this.frameWatchers.set(workerId, (listeners = new Set()))
    const watching = listeners
    watching.add(listener)
    void this.capture(workerId).then(
      (image) => image && !image.isEmpty() && watching.has(listener) && listener(image),
      () => undefined
    )
    this.pump(workerId)
    return () => {
      watching.delete(listener)
      if (watching.size === 0 && this.frameWatchers.get(workerId) === watching) this.frameWatchers.delete(workerId)
    }
  }

  /**
   * Something is happening on the page: a step (bringing a parked page back,
   * perhaps), or the user in control and using it — not just holding it.
   */
  private live(workerId: string): boolean {
    const session = this.sessions.get(workerId)
    if (!session || session.window.isDestroyed()) return false
    return session.busy > 0 || Boolean(session.control && Date.now() - session.inputAt < CONTROL_LIVE_MS)
  }

  /** Starts the capture loop for the live views, if any are watching and something is happening. */
  private pump(workerId: string): void {
    if (this.pumping.has(workerId) || !this.live(workerId) || !this.frameWatchers.get(workerId)?.size) return
    const tick = async (): Promise<void> => {
      await this.deliver(workerId)
      // The tick that finds it idle has just taken the picture of how it ended up.
      if (this.live(workerId) && this.frameWatchers.get(workerId)?.size) this.pumping.set(workerId, setTimeout(() => void tick(), FRAME_MS))
      else this.pumping.delete(workerId)
    }
    this.pumping.set(workerId, setTimeout(() => void tick(), 0))
  }

  /** One picture to every live view of this browser. */
  private async deliver(workerId: string): Promise<void> {
    if (!this.frameWatchers.get(workerId)?.size) return
    const image = await this.capture(workerId).catch(() => null)
    if (!image || image.isEmpty()) return
    for (const listener of this.frameWatchers.get(workerId) ?? []) listener(image)
  }

  /** One picture of the page as it is now; a parked page's last one. */
  async capture(workerId: string): Promise<NativeImage | null> {
    const session = this.sessions.get(workerId)
    if (!session || session.window.isDestroyed()) return null
    if (session.parked) return session.parked.frame
    return session.window.webContents.capturePage()
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
    // The page back where it was, and pictured while they use it.
    if (session.parked) void this.wake(workerId, session)
    session.inputAt = Date.now()
    this.pump(workerId)
    return true
  }

  releaseControl(workerId: string): void {
    const session = this.sessions.get(workerId)
    session?.control?.release()
    if (!session) return
    session.control = null
    // Unused from now, not from the agent's last step.
    if (session.busy === 0 && this.sessions.get(workerId) === session) this.armPark(workerId, session)
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
    session.inputAt = Date.now()
    this.pump(workerId)
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

  /** Closes a browser (the app quitting, a worker removed); its logins stay in the partition for next time. */
  async close(workerId: string): Promise<void> {
    // One still being created goes too, once it exists.
    await this.creating.get(workerId)?.catch(() => undefined)
    const session = this.sessions.get(workerId)
    this.holders.delete(workerId)
    if (!session) return
    this.releaseControl(workerId)
    this.sessions.delete(workerId)
    if (session.parkTimer) clearTimeout(session.parkTimer)
    session.parkTimer = null
    clearTimeout(this.pumping.get(workerId))
    this.pumping.delete(workerId)
    session.unhook()
    session.takeover.abort()
    await closeQuietly(session.browser)
    if (!session.window.isDestroyed()) session.window.destroy()
  }

  /**
   * Closes a browser and erases what it kept: cookies, logins, storage and
   * cache. For a worker that is deleted — its sign-ins shouldn't linger on
   * disk under a partition nothing will open again.
   */
  async forget(workerId: string): Promise<void> {
    await this.close(workerId)
    const partition = this.options.partition?.(workerId) ?? `persist:worker-${workerId}`
    // Best effort: the worker is removed either way, and a failure here
    // shouldn't turn that into an error.
    try {
      const { session } = await import('electron')
      const stored = session.fromPartition(partition)
      await stored.clearStorageData().catch(() => {})
      await stored.clearCache().catch(() => {})
    } catch (error) {
      console.error(`[browser] could not clear ${partition}:`, error)
    }
  }

  async closeAll(): Promise<void> {
    const ids = new Set([...this.sessions.keys(), ...this.creating.keys()])
    await Promise.all([...ids].map((id) => this.close(id)))
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

/* ------------------------------------------------------------ site capture */

export const MAX_CAPTURE_PAGES = 200
const DEFAULT_CAPTURE_PAGES = 30

/** Files, not pages; and links whose mere opening signs out, unsubscribes or deletes. */
const NOT_A_PAGE = /\.(pdf|zip|gz|tgz|dmg|exe|msi|pkg|apk|png|jpe?g|gif|svg|webp|ico|mp[34]|mov|webm|wav|xml|json|css|js|txt|csv|xlsx?|docx?|pptx?)$/i
const DANGEROUS_PATH = /\/(log-?out|sign-?out|logoff|unsubscribe|delete|remove|deactivate|cancel(?:-account|-subscription)?)(\/|$|\?)/i

/** The page a link stands for: no fragment, no trailing slash, and no query unless asked to keep it. */
export function normalizeCrawlUrl(raw: string, keepQuery: boolean): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol)) return null
  url.hash = ''
  if (!keepQuery) url.search = ''
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href
}

/** Whether a crawl should leave this link alone. */
export function skipCrawl(url: string): boolean {
  try {
    const { pathname } = new URL(url)
    return NOT_A_PAGE.test(pathname) || DANGEROUS_PATH.test(pathname)
  } catch {
    return true
  }
}

/** "003-pricing-plans.png" for the third page, /pricing/plans. */
export function captureFileName(index: number, url: string): string {
  let path = ''
  try {
    path = new URL(url).pathname
  } catch {
    /* falls back to "home" */
  }
  const slug = path.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60) || 'home'
  return `${String(index).padStart(3, '0')}-${slug}.png`
}

/** A path the agent gave, made absolute against its working folder. */
export function resolveOutPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function stamp(at = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`
}

export interface BrowserToolOptions {
  /** Whose browser a call drives: a worker's id, or the chat agent's fixed one. Null refuses the call. */
  idOf: (ctx: Parameters<AgentTool['run']>[1]) => string | null
  /** How to tell the model to get a sign-in done. */
  signInHint: string
  /** Each step as it starts and ends — the chat agent's live view shows them. */
  onStep?: (ctx: Parameters<AgentTool['run']>[1], step: { action: string; detail: string; done: boolean }) => void
  /**
   * For a browser more than one run can reach (the chat agent's, shared by
   * every chat): whether a run is still going, so one run's steps never land
   * on a page another is in the middle of (see `WorkerBrowsers.claim`).
   */
  shared?: { alive: (runId: string) => boolean; waitMs?: number }
}

export const BROWSER_ACTIONS = ['open', 'snapshot', 'find', 'click', 'type', 'select', 'press', 'scroll', 'back', 'reload', 'wait', 'read', 'screenshot', 'upload', 'download', 'capture_site'] as const

/**
 * What models call these actions when they guess — many learned other
 * browser tools ("navigate", "goto", "new_tab", Playwright's "fill"…). A
 * guess that means the same thing is taken rather than failed.
 */
const ACTION_ALIASES: Record<string, { action: string; direction?: 'up' | 'down' }> = {
  navigate: { action: 'open' },
  goto: { action: 'open' },
  go_to: { action: 'open' },
  go: { action: 'open' },
  visit: { action: 'open' },
  new_tab: { action: 'open' },
  open_tab: { action: 'open' },
  open_url: { action: 'open' },
  open_page: { action: 'open' },
  load: { action: 'open' },
  browse: { action: 'open' },
  tap: { action: 'click' },
  click_element: { action: 'click' },
  click_link: { action: 'click' },
  click_button: { action: 'click' },
  press_button: { action: 'click' },
  fill: { action: 'type' },
  input: { action: 'type' },
  type_text: { action: 'type' },
  enter_text: { action: 'type' },
  write: { action: 'type' },
  fill_input: { action: 'type' },
  select_option: { action: 'select' },
  choose: { action: 'select' },
  dropdown: { action: 'select' },
  key: { action: 'press' },
  keypress: { action: 'press' },
  press_key: { action: 'press' },
  send_keys: { action: 'press' },
  keyboard: { action: 'press' },
  scroll_down: { action: 'scroll', direction: 'down' },
  scroll_up: { action: 'scroll', direction: 'up' },
  page_down: { action: 'scroll', direction: 'down' },
  page_up: { action: 'scroll', direction: 'up' },
  go_back: { action: 'back' },
  navigate_back: { action: 'back' },
  previous: { action: 'back' },
  refresh: { action: 'reload' },
  sleep: { action: 'wait' },
  pause: { action: 'wait' },
  wait_for: { action: 'wait' },
  get_text: { action: 'read' },
  read_page: { action: 'read' },
  extract: { action: 'read' },
  extract_text: { action: 'read' },
  get_content: { action: 'read' },
  get_page_content: { action: 'read' },
  look: { action: 'snapshot' },
  observe: { action: 'snapshot' },
  get_elements: { action: 'snapshot' },
  accessibility_tree: { action: 'snapshot' },
  find_text: { action: 'find' },
  find_element: { action: 'find' },
  search_page: { action: 'find' },
  locate: { action: 'find' },
  take_screenshot: { action: 'screenshot' },
  capture: { action: 'screenshot' },
  crawl: { action: 'capture_site' },
  screenshot_site: { action: 'capture_site' },
  upload_file: { action: 'upload' },
  attach: { action: 'upload' },
  attach_file: { action: 'upload' },
  choose_file: { action: 'upload' },
  set_input_files: { action: 'upload' },
  set_files: { action: 'upload' },
  download_file: { action: 'download' },
  save_file: { action: 'download' },
  save_download: { action: 'download' }
}

const pick = (input: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number') return String(value)
  }
  return ''
}

/**
 * A call as the tool understands it: the action under its own name, and the
 * usual other names for its arguments (`href`, `element`, `value`…) folded in.
 */
export function normalizeBrowserInput(input: Record<string, unknown>): Record<string, unknown> {
  const raw = str(input.action).trim().toLowerCase().replace(/[\s-]+/g, '_')
  const alias = ACTION_ALIASES[raw]
  const action = alias?.action ?? raw
  const out: Record<string, unknown> = { ...input, action }
  if (alias?.direction && !input.direction) out.direction = alias.direction
  const url = pick(input, 'url', 'href', 'link', 'address', 'uri')
  if (url) out.url = url
  else if (action === 'open' && /^(https?:\/\/|www\.|[\w-]+\.[a-z]{2,}(\/|$))/i.test(pick(input, 'text', 'query', 'target').trim())) out.url = pick(input, 'text', 'query', 'target').trim()
  const ref = pick(input, 'ref', 'element', 'element_ref', 'elementRef', 'ref_id', 'id', 'target')
  if (isRef(ref.trim())) out.ref = ref.trim()
  const text = pick(input, 'text', 'value', 'content', 'query', 'search')
  if (text && action !== 'open') out.text = text
  const key = pick(input, 'key', 'keys')
  if (key) out.key = key
  if (action === 'scroll' && !out.direction) out.direction = /up/i.test(pick(input, 'dir', 'amount')) ? 'up' : 'down'
  if (action === 'upload') {
    const many = [input.paths, input.files].find(Array.isArray) as unknown[] | undefined
    const paths = many ? many.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : [pick(input, 'path', 'file', 'file_path', 'filePath', 'filename')].filter(Boolean)
    if (paths.length) out.paths = paths
  }
  if (action === 'download' && !out.save_to) {
    const dest = pick(input, 'save_as', 'path', 'dest', 'destination', 'folder')
    if (dest) out.save_to = dest
  }
  return out
}

/** The words a call names its element by when it has no ref: the visible text, or a field's label. */
function targetWords(input: Record<string, unknown>): string {
  const action = str(input.action)
  return action === 'type' || action === 'select'
    ? pick(input, 'label', 'field', 'placeholder', 'name', 'selector')
    : pick(input, 'label', 'name', 'selector') || (action === 'click' ? str(input.text) : '')
}

/** The `web_browser` tool over `browsers`, for whichever agent `idOf` names. */
export function browserTool(browsers: WorkerBrowsers, options: BrowserToolOptions): AgentTool {
  const self = (ctx: Parameters<AgentTool['run']>[1]): string => {
    const id = options.idOf(ctx)
    if (!id) throw new Error('This agent has no browser of its own.')
    return id
  }
  const failures = new BrowserFailures()
  const tool: AgentTool = {
    name: 'web_browser',
    description: `Your own web browser (a real one, with your own saved logins). open {url} (also for a new page — there are no tabs) → an interactive snapshot where every element has a ref; then click {ref}, type {ref, text, submit?}, select {ref, text} (a dropdown option), press {key}, scroll {direction}, back, reload, wait {seconds}, read (the page text), find {text} (refs of the links/buttons matching words — for big pages), snapshot, or screenshot (an image, when layout matters; with save_to it saves a clean PNG file instead, full_page for the whole scrollable page). upload {ref, path} chooses a file (from the work folder) in a file input or the button that opens one; download {url?, save_to?} saves a file the page links to into the work folder (a click on a download link tells you its url). capture_site {url, max_pages?, folder?} opens a site and saves a full-page screenshot of every page it links to on the same site, with an index — use it when the user wants screenshots of a whole site. Refs change when the page changes: act on the latest snapshot. ${options.signInHint}`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...BROWSER_ACTIONS] },
        seconds: { type: 'number', description: 'wait: how long (default 2, at most 30)' },
        url: { type: 'string' },
        ref: { type: 'string', description: 'e.g. "e12", from the latest snapshot' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'type: press Enter after' },
        key: { type: 'string', description: 'press: e.g. "Enter", "Escape", "ArrowDown"' },
        direction: { type: 'string', enum: ['up', 'down'] },
        path: { type: 'string', description: 'upload: the file to choose (relative to the work folder)' },
        save_to: { type: 'string', description: 'screenshot: a .png path to save a clean screenshot to; download: a file or folder path (default downloads/ in the work folder)' },
        full_page: { type: 'boolean', description: 'screenshot with save_to / capture_site: the whole scrollable page (capture_site defaults to true)' },
        max_pages: { type: 'integer', description: `capture_site: most pages to capture (default ${DEFAULT_CAPTURE_PAGES}, at most ${MAX_CAPTURE_PAGES})` },
        folder: { type: 'string', description: 'capture_site: folder for the screenshots (default screenshots/<site>-<date> in the work folder)' },
        keep_query: { type: 'boolean', description: 'capture_site: treat ?query variants as separate pages (default false)' }
      },
      required: ['action']
    },
    // Looking, finding and scrolling change nothing anyone else sees; a
    // screenshot saved to a file, a download or an upload does.
    mutating: (raw) => {
      const input = normalizeBrowserInput(raw)
      return !['snapshot', 'read', 'wait', 'find', 'scroll'].includes(str(input.action)) && !(str(input.action) === 'screenshot' && !str(input.save_to))
    },
    // Clicks, typing and uploads reach other people's services; a Careful worker is asked (and refused).
    // A page on this computer or the local network is asked about too: a dev
    // server's admin route, the router, a service that trusts anything that reaches it.
    risky: (raw, ctx) => {
      const input = normalizeBrowserInput(raw)
      const action = str(input.action)
      if (['click', 'type', 'select', 'press', 'upload'].includes(action)) return true
      if (action === 'open' || action === 'capture_site') return opensPrivateNetwork(str(input.url))
      if (action === 'reload') return opensPrivateNetwork(browsers.url(options.idOf(ctx) ?? ''))
      return false
    },
    // Never alone: typing a password, card number or code, pressing a button
    // that spends money, or sending a key or credentials file to a website.
    catastrophic: (raw, ctx) => {
      const input = normalizeBrowserInput(raw)
      const action = str(input.action)
      if (action === 'upload') return uploadPaths(input, ctx.cwd).some(isSecretPath)
      if (action !== 'type' && action !== 'click' && action !== 'press') return false
      const id = options.idOf(ctx)
      if (!id) return false
      const el = browsers.describe(id, input.ref)
      // No ref: the element is found by the words given, so judge by those words.
      const name = el?.name ?? targetWords(input)
      if (action === 'type') return (!el && !name) || SENSITIVE.test(name) || /password/i.test(el?.role ?? '')
      // A purchase authorized for this site through payment_card already had its say.
      if (action === 'click') return (!el && !name) || (SPENDING.test(name) && !purchaseCovers(ctx.request.chatId, browsers.url(id)))
      return false
    },
    describe: (raw) => {
      const input = normalizeBrowserInput(raw)
      const files = Array.isArray(input.paths) ? (input.paths as string[]).join(', ') : ''
      return [str(input.action), str(input.url) || str(input.ref) || targetWords(input) || str(input.key), files && `← ${files}`].filter(Boolean).join(' ')
    },
    run: async (raw, ctx) => {
      const input = normalizeBrowserInput(raw)
      const id = self(ctx)
      const action = str(input.action)
      const notes: string[] = []
      // A browser several conversations share is used by one at a time.
      if (options.shared) {
        const claim = await browsers.claim(id, { id: ctx.request.messageId, label: ctx.request.chatTitle ?? '' }, options.shared.alive, ctx.signal, options.shared.waitMs)
        if (!claim.ok) return { text: claim.text, isError: true }
        if (claim.note) notes.push(claim.note)
      }
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
      // Element steps that keep failing on this page are stopped here, however they are interleaved.
      const aimed = ['click', 'type', 'select', 'press', 'upload'].includes(action) || (action === 'open' && str(input.url))
      const failureKey = aimed ? failures.key(id, action === 'open' ? str(input.url) : browsers.url(id), action, target ? `${target.role} "${target.name}"` : str(input.ref) || targetWords(input) || str(input.key) || str(input.url)) : ''
      const what = `${action}${detail ? ` ${detail}` : ''}`
      const refused = failureKey ? failures.refuse(failureKey, what) : null
      if (refused) return { text: refused, isError: true }
      options.onStep?.(ctx, { action, detail, done: false })
      browsers.beginStep(id)
      try {
        const result = await step(id, action, input, ctx)
        const normalized = typeof result === 'string' ? { text: result } : result
        // Whatever happened to the browser between steps (a crash and reopen) comes first.
        const before = [...notes, ...browsers.takeNotes(id)]
        if (failureKey) {
          if (normalized.isError) failures.failed(failureKey, normalized.text.split('\n')[0])
          else failures.succeeded(failureKey)
        }
        if (!normalized.isError && ['type', 'select', 'upload'].includes(action)) failures.pageChanged(id, browsers.url(id))
        return before.length ? { ...normalized, text: `${before.join('\n')}\n\n${normalized.text}` } : normalized
      } catch (error) {
        if (ctx.signal.aborted) throw error
        const explained = explainBrowserError(error, what, browsers.refsOf(id))
        if (failureKey) failures.failed(failureKey, explained.message)
        const before = [...notes, ...browsers.takeNotes(id)]
        // With the page as it is now, so the next step can be decided without another call.
        const now = explained.snapshot ? await browsers.snapshot(id).catch(() => '') : ''
        return { text: [...before, explained.message, now && `\n${now}`].filter(Boolean).join('\n'), isError: true }
      } finally {
        options.onStep?.(ctx, { action, detail, done: true })
      }
    }
  }

  type Ctx = Parameters<AgentTool['run']>[1]

  /**
   * Breadth-first over the site's own links from `start`: each page opened,
   * scrolled through and saved as a full-page PNG, then an index.md that
   * lists them. Links that would sign out, unsubscribe or delete are never
   * opened, and neither are files.
   */
  async function captureSite(id: string, input: Record<string, unknown>, ctx: Ctx): Promise<string> {
    let start = str(input.url).trim() || browsers.url(id)
    if (!start || start === 'about:blank') throw new BrowserStepError('capture_site needs a url.')
    if (!/^[a-z][\w+.-]*:/i.test(start)) start = `https://${start}`
    const keepQuery = input.keep_query === true
    const first = normalizeCrawlUrl(start, keepQuery)
    if (!first) throw new BrowserStepError('Only http(s) sites can be captured.')
    const site = new URL(first).hostname.replace(/^www\./, '')
    const requested = Math.round(Number(input.max_pages ?? DEFAULT_CAPTURE_PAGES))
    const max = Math.min(MAX_CAPTURE_PAGES, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_CAPTURE_PAGES))
    const fullPage = input.full_page !== false
    const folder = resolveOutPath(ctx.cwd, str(input.folder).trim() || join('screenshots', `${site}-${stamp()}`))
    await mkdir(folder, { recursive: true })

    const queue = [first]
    const seen = new Set(queue)
    const saved: { url: string; title: string; file: string }[] = []
    const failed: { url: string; error: string }[] = []
    while (queue.length > 0 && saved.length < max) {
      if (ctx.signal.aborted) break
      if (browsers.controlled(id)) await browsers.waitForUser(id, ctx.signal)
      const url = queue.shift()!
      try {
        browsers.beginStep(id)
        if ((await browsers.open(id, url, ctx.signal)) === 'timeout') {
          failed.push({ url, error: 'did not load in time' })
          continue
        }
        // A link that turned out to be a file leaves the last page showing; it isn't this one.
        if (browsers.takeDownload(id)) {
          failed.push({ url, error: 'is a file download, not a page' })
          continue
        }
        const landed = browsers.url(id)
        const host = new URL(landed).hostname.replace(/^www\./, '')
        if (host !== site && !host.endsWith(`.${site}`)) {
          failed.push({ url, error: `went to another site (${host})` })
          continue
        }
        const file = captureFileName(saved.length + 1, landed)
        await browsers.saveScreenshot(id, join(folder, file), fullPage)
        saved.push({ url: landed, title: await browsers.title(id).catch(() => ''), file })
        seen.add(normalizeCrawlUrl(landed, keepQuery) ?? landed)
        ctx.progress(`Captured ${saved.length} of up to ${max}: ${landed}`)
        for (const link of await browsers.siteLinks(id, site)) {
          const next = normalizeCrawlUrl(link, keepQuery)
          if (next && !seen.has(next) && !skipCrawl(next)) {
            seen.add(next)
            queue.push(next)
          }
        }
      } catch (error) {
        if (ctx.signal.aborted) break
        failed.push({ url, error: stripAnsi(String((error as Error)?.message ?? error)).split('\n')[0].slice(0, 160) })
      }
    }

    const index = [
      `# Screenshots of ${site}`,
      '',
      `Captured ${saved.length} page${saved.length === 1 ? '' : 's'} on ${new Date().toLocaleString()}.`,
      '',
      ...saved.map((s, i) => `${i + 1}. [${s.title || s.url}](${s.file}) — ${s.url}`),
      ...(failed.length ? ['', '## Not captured', '', ...failed.map((f) => `- ${f.url}: ${f.error}`)] : [])
    ].join('\n')
    await writeFile(join(folder, 'index.md'), `${index}\n`)

    const left = queue.length
    return [
      `Saved ${saved.length} full-page screenshot${saved.length === 1 ? '' : 's'} of ${site} to ${folder} (index.md lists them).`,
      ...saved.slice(0, 40).map((s) => `- ${s.file}: ${s.title || s.url}`),
      saved.length > 40 ? `- …and ${saved.length - 40} more` : '',
      failed.length ? `${failed.length} page${failed.length === 1 ? '' : 's'} could not be captured (listed in index.md).` : '',
      left > 0 ? `Stopped at the ${max}-page limit with ${left} more link${left === 1 ? '' : 's'} found; raise max_pages to go further.` : '',
      ctx.signal.aborted ? 'Stopped by the user before finishing.' : ''
    ]
      .filter(Boolean)
      .join('\n')
  }

  /**
   * The ref for a click or a field named by its words instead of a ref: the
   * one match, or the one whose name is exactly those words. Otherwise the
   * matches, for the model to pick from.
   */
  async function resolveRef(id: string, action: string, words: string): Promise<{ ref: string } | { text: string; isError: true }> {
    const fields = action === 'type' || action === 'select'
    const found = (await browsers.findRefs(id, words)).filter(
      (el) => (!fields || /textbox|combobox|searchbox|textarea|input|select/i.test(el.role)) && (action !== 'upload' || /file input|button|link/i.test(el.role))
    )
    const exact = found.filter((el) => el.name.trim().toLowerCase() === words.trim().toLowerCase())
    const only = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : null
    if (only) return { ref: only.ref }
    if (found.length === 0) return { text: `${action} needs a ref like "e12" from the latest snapshot; nothing on this page matches "${words}". Take a snapshot and use a ref from it.`, isError: true }
    return { text: `More than one element matches "${words}"; ${action} the one you mean by its ref:\n${found.map((el) => `- ${el.role} "${el.name}" [ref=${el.ref}]`).join('\n')}`, isError: true }
  }

  /**
   * After a step that may have changed pages: a new tab the page asked for
   * is opened here (there are no tabs), a download it started is described,
   * and a load that failed or a page that is an error or a bot wall is said
   * plainly — each as a line above the snapshot.
   */
  async function aftermath(id: string, ctx: Ctx, moved: boolean): Promise<{ lines: string[]; moved: boolean }> {
    const lines: string[] = []
    const popup = browsers.takePopup(id)
    if (popup) {
      const outcome = await browsers.open(id, popup, ctx.signal)
      moved = true
      lines.push(
        outcome === 'timeout'
          ? `That opens ${popup} in a new tab; there are no tabs here, and opening it in this one timed out.`
          : `That opens ${popup} in a new tab. There are no tabs here, so it opened in this one; use back to return.`
      )
    }
    const download = browsers.takeDownload(id)
    if (download) lines.push(downloadNote(download))
    const failedLoad = browsers.takeLoadError(id)
    if (failedLoad) lines.push(netErrorAdvice(failedLoad.description, failedLoad.url))
    if (browsers.pendingChooser(id)) lines.push('That opened a file picker. To choose a file, use upload {ref, path} on the same element; nothing was chosen yet.')
    if (moved) {
      const note = await browsers.pageNoteDeep(id)
      if (note) lines.push(note)
    }
    return { lines, moved }
  }

  const withLines = (lines: string[], text: string): string => (lines.length ? `${lines.join('\n')}\n\n${text}` : text)

  /** Fails fast, with the page as it is now, when a ref's element is gone or disabled. */
  async function checkTarget(id: string, ref: string, action: string, what: string): Promise<{ text: string; isError: true } | null> {
    const found = await browsers.probe(id, ref)
    if (!found) return null
    const el = browsers.describe(id, ref)
    const name = el ? `${el.role} "${el.name}" (${ref})` : ref
    if (!found.found) {
      const why = el ? `${name} is no longer on the page. The page changed after the snapshot its ref came from` : `there is no element ${ref} on this page (it isn't from your latest snapshot)`
      return { text: `Could not ${what}: ${why}; use a ref from the page as it is now:\n\n${await browsers.snapshot(id)}`, isError: true }
    }
    if (found.disabled && action !== 'upload') {
      return { text: `Could not ${what}: ${name} is disabled. Usually a required field is still empty or invalid; fill the form first (read or a snapshot shows what is missing).`, isError: true }
    }
    if ((action === 'type' || action === 'select') && !found.editable) {
      return { text: `Could not ${what}: ${name} is a ${found.tag.toLowerCase()}, not a field that takes text. Use a textbox or combobox ref from the latest snapshot.`, isError: true }
    }
    return null
  }

  async function step(id: string, action: string, input: Record<string, unknown>, ctx: Ctx): Promise<Awaited<ReturnType<AgentTool['run']>>> {
    let ref = str(input.ref)
    if (['click', 'type', 'select', 'upload'].includes(action) && !isRef(ref)) {
      const words = targetWords(input)
      if (!words) return { text: `${action} needs a ref like "e12" from the latest snapshot.`, isError: true }
      const resolved = await resolveRef(id, action, words)
      if ('isError' in resolved) return resolved
      ref = resolved.ref
    }
    const locator = isRef(ref) ? browsers.locator(id, ref) : ''
    const el = isRef(ref) ? browsers.describe(id, ref) : undefined
    const what = `${action} ${el ? `${el.role} "${el.name}"` : ref}`
    if (locator && ['click', 'type', 'select', 'upload'].includes(action)) {
      const problem = await checkTarget(id, ref, action, what)
      if (problem) return problem
    }
    switch (action) {
      case 'open': {
        let url = str(input.url).trim()
        if (!url) return { text: 'open needs a url.', isError: true }
        if (!/^[a-z][\w+.-]*:/i.test(url)) url = `https://${url}`
        if (!/^https?:/i.test(url)) return { text: 'Only http(s) pages can be opened.', isError: true }
        const before = browsers.url(id)
        if ((await browsers.open(id, url, ctx.signal)) === 'timeout') {
          const still = browsers.url(id)
          return {
            text: `${url} didn't start loading within ${Math.round((browsers.openTimeoutMs()) / 1000)} s (the site is very slow or not answering), so it was stopped${
              still && still !== 'about:blank' ? `; the browser is still on ${still}` : ''
            }. Try again later, or find the information another way.`,
            isError: true
          }
        }
        // A file link doesn't change the page: say so, rather than show the old page as if it were this one.
        const download = browsers.takeDownload(id)
        if (download) return { text: downloadNote(download), isError: browsers.url(id) === before }
        const { lines } = await aftermath(id, ctx, true)
        return withLines(lines, await browsers.snapshot(id))
      }
      case 'snapshot':
        return browsers.snapshot(id)
      case 'click': {
        // A click that opens another page gets that page whole; otherwise, what changed.
        const before = browsers.url(id)
        await browsers.pointAt(id, locator, 'click')
        // Covered (a cookie banner, a dialog) is found out at once rather than
        // after the click's whole timeout; and the page is fingerprinted on
        // either side of the click, to tell "nothing happened" apart.
        const outcome = await browsers.run(
          id,
          `const loc = ${locator}; const covered = await loc.evaluate(${COVERED_SCRIPT}, null, { timeout: 3000 }).catch(() => null);` +
            ` if (covered) throw new Error(covered + ' intercepts pointer events');` +
            ` const fp = ${FINGERPRINT_SCRIPT}; const before = await fp(page).catch(() => '');` +
            ` await loc.click({ timeout: 10000 }); await page.waitForTimeout(700);` +
            ` const after = await fp(page).catch(() => 'gone'); return before && before === after ? 'same' : 'changed'`
        )
        let moved = browsers.url(id) !== before
        if (moved) await browsers.landed(id)
        const after = await aftermath(id, ctx, moved)
        moved = after.moved
        const snapshot = await browsers.snapshot(id, !moved)
        // The click landed but nothing on the page reacted: a page still loading its scripts, usually.
        if (!moved && after.lines.length === 0 && outcome === 'same') {
          after.lines.push("Nothing on the page changed after this click. If it was still loading, wait a moment and click again; otherwise this element may not do anything here (check with read or screenshot).")
        }
        return withLines(after.lines, snapshot)
      }
      case 'find':
        if (!str(input.text).trim()) return { text: 'find needs text: words from the link or button you want.', isError: true }
        return browsers.find(id, str(input.text).trim())
      case 'type': {
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
        let moved = browsers.url(id) !== before
        if (moved) await browsers.landed(id)
        const after = await aftermath(id, ctx, moved)
        moved = after.moved
        return withLines(after.lines, await browsers.snapshot(id, !moved))
      }
      case 'select': {
        const value = str(input.text) || str(input.option)
        if (!value) return { text: 'select needs text: the option to choose.', isError: true }
        await browsers.pointAt(id, locator, 'click')
        // The options are read first, so a wrong name fails at once with the real ones listed.
        const chosen = await browsers.run(
          id,
          `const loc = ${locator}; const want = ${js(value)}.trim().toLowerCase();` +
            ` const options = await loc.evaluate((el) => el.options ? [...el.options].map((o) => ({ label: (o.label || o.text || '').trim(), value: o.value })) : null, null, { timeout: 5000 });` +
            ` if (!options) { await loc.selectOption({ label: ${js(value)} }, { timeout: 5000 }); return 'ok' }` +
            ` const hit = options.find((o) => o.label.toLowerCase() === want) ?? options.find((o) => o.value.toLowerCase() === want) ?? options.find((o) => o.label.toLowerCase().includes(want));` +
            ` if (!hit) return JSON.stringify({ missing: options.map((o) => o.label).filter(Boolean).slice(0, 40) });` +
            ` await loc.selectOption({ value: hit.value }, { timeout: 5000 }); await page.waitForTimeout(400); return 'ok'`
        )
        if (chosen !== 'ok') {
          let options: string[] = []
          try {
            options = (JSON.parse(chosen) as { missing: string[] }).missing
          } catch {
            /* no list to show */
          }
          return { text: `Could not ${what}: it has no option called "${value}".${options.length ? ` Its options are: ${options.map((o) => `"${o}"`).join(', ')}.` : ''}`, isError: true }
        }
        return browsers.snapshot(id, true)
      }
      case 'press': {
        const before = browsers.url(id)
        await browsers.run(id, `await page.keyboard.press(${js(str(input.key) || 'Enter')}); await page.waitForTimeout(500); return 'ok'`)
        let moved = browsers.url(id) !== before
        if (moved) await browsers.landed(id)
        const after = await aftermath(id, ctx, moved)
        moved = after.moved
        return withLines(after.lines, await browsers.snapshot(id, !moved))
      }
      case 'wait': {
        const seconds = Math.min(30, Math.max(0.5, Number(input.seconds ?? input.duration ?? 2) || 2))
        await new Promise<void>((resolve, reject) => {
          const stop = (): void => {
            clearTimeout(timer)
            reject(new Error('Stopped by the user.'))
          }
          const timer = setTimeout(() => {
            ctx.signal.removeEventListener('abort', stop)
            resolve()
          }, seconds * 1000)
          if (ctx.signal.aborted) return stop()
          ctx.signal.addEventListener('abort', stop, { once: true })
        })
        return browsers.snapshot(id, true)
      }
      case 'reload': {
        const url = browsers.url(id)
        if (!url || url === 'about:blank') return { text: 'There is no page to reload. open one first.', isError: true }
        if ((await browsers.open(id, url, ctx.signal)) === 'timeout') return { text: `Reloading ${url} timed out; the site is slow or not answering. Try again later.`, isError: true }
        const { lines } = await aftermath(id, ctx, true)
        return withLines(lines, await browsers.snapshot(id))
      }
      case 'scroll':
        await browsers.run(id, `await page.mouse.wheel(0, ${str(input.direction) === 'up' ? -900 : 900}); await page.waitForTimeout(300); return 'ok'`)
        return browsers.snapshot(id)
      case 'back':
        if (!(await browsers.back(id))) return { text: 'There is no page to go back to.', isError: true }
        return browsers.snapshot(id)
      case 'read':
        // A checkout page's fields hold the card number the agent typed; its text must not carry it back.
        return clip(
          redactPaymentSecrets(
            await browsers.run(id, `return (await page.title()) + '\\n' + page.url() + '\\n\\n' + (await page.evaluate(() => document.body?.innerText ?? '')).slice(0, 20000)`)
          ),
          20_000
        )
      case 'screenshot': {
        const saveTo = str(input.save_to).trim()
        if (!saveTo) return { text: 'Screenshot of your browser (refs are drawn on it).', images: [await browsers.screenshot(id)] }
        if (!browsers.window(id)) return { text: 'Your browser has no page open.', isError: true }
        const dest = resolveOutPath(ctx.cwd, /\.png$/i.test(saveTo) ? saveTo : `${saveTo.replace(/\/+$/, '')}/${captureFileName(1, browsers.url(id))}`)
        await browsers.saveScreenshot(id, dest, input.full_page === true)
        return `Saved a ${input.full_page === true ? 'full-page' : 'viewport'} screenshot of ${browsers.url(id)} to ${dest}.`
      }
      case 'upload': {
        const paths = uploadPaths(input, ctx.cwd)
        if (paths.length === 0) return { text: 'upload needs path: the file to choose, e.g. "report.pdf" in the work folder.', isError: true }
        for (const path of paths) {
          const info = await stat(path).catch(() => null)
          if (!info) return { text: `Could not upload ${path}: there is no such file. Check the name (relative paths are in the work folder, ${ctx.cwd}).`, isError: true }
          if (!info.isFile()) return { text: `Could not upload ${path}: it is a folder, not a file.`, isError: true }
        }
        await browsers.upload(id, ref, paths)
        const names = paths.map((p) => basename(p)).join(', ')
        return withLines([`Chose ${names} in ${el ? `${el.role} "${el.name}"` : ref}.`], await browsers.snapshot(id, true))
      }
      case 'download': {
        const url = str(input.url).trim() || browsers.lastDownloadUrl(id)
        if (!url) return { text: 'download needs url: the address of the file (clicking a download link tells you it).', isError: true }
        if (!/^https?:/i.test(url)) return { text: 'Only http(s) files can be downloaded.', isError: true }
        const saveTo = str(input.save_to).trim()
        const dest = resolveOutPath(ctx.cwd, saveTo || 'downloads/')
        const saved = await browsers.download(id, url, saveTo && !/[\\/]$/.test(saveTo) && extname(saveTo) ? dest : `${dest.replace(/[\\/]+$/, '')}/`, ctx.signal)
        return `Downloaded ${url} to ${saved.path} (${formatBytes(saved.bytes)}${saved.mime ? `, ${saved.mime.split(';')[0]}` : ''}).`
      }
      case 'capture_site':
        return captureSite(id, input, ctx)
      default:
        return { text: `Unknown action "${action}". Use one of: ${BROWSER_ACTIONS.join(', ')}. To go to a page (or a "new tab"), use open {url}.`, isError: true }
    }
  }
  return tool
}

/** The files an upload names, made absolute against the work folder. */
function uploadPaths(input: Record<string, unknown>, cwd: string): string[] {
  const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : []
  return paths.map((p) => resolveOutPath(cwd || process.cwd(), p.trim()))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** What the agent is told when a click or an open starts a download instead of showing a page. */
export function downloadNote(download: AttemptedDownload): string {
  const size = download.size > 0 ? `, ${formatBytes(download.size)}` : ''
  return `That is a file download (${download.filename || 'a file'}${download.mime ? `, ${download.mime}` : ''}${size}), not a page, so the page didn't change. To save it into the work folder, use download {url: "${download.url}"}.`
}

/** A file name safe on every OS. */
function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^\.+/, '').trim().slice(0, 120)
  return cleaned || 'download'
}

/** `path`, or "name-2.ext" and so on when it already exists, so a download never overwrites a file. */
async function freePath(path: string): Promise<string> {
  const ext = extname(path)
  const stem = path.slice(0, path.length - ext.length)
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? path : `${stem}-${n}${ext}`
    if (!(await stat(candidate).catch(() => null))) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

/**
 * The `web_browser` tool: the worker's own browser, action by action. Offered
 * only on a worker's own turn.
 */
export function workerBrowserToolSource(browsers: WorkerBrowsers, onStep?: BrowserToolOptions['onStep']): ToolSource {
  const tool = browserTool(browsers, {
    idOf: (ctx) => ctx.request.workerId ?? null,
    signInHint: 'If a site needs the user to sign in, ask_user; they can watch your browser from your page, take control, sign in and hand it back.',
    // A worker runs one turn at a time, but a scheduled wake and a message can overlap.
    shared: { alive: isRunning },
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
