/**
 * The contract between the desktop bridge (`src/main/features/browser/`) and
 * the Eaon Chrome extension (`extension/`).
 *
 * The extension is plain JavaScript with no build step, so it cannot import
 * this file. The message shapes are mirrored by hand in
 * `extension/lib/connection.js`; bump BRIDGE_PROTOCOL when either side changes
 * a shape the other relies on, and the bridge will refuse the mismatched
 * version with a message telling the user which side to update.
 *
 * Prefer additions over a bump: a bump strands every installed extension
 * until the user reloads it by hand. Since extension 1.1.0 the hello lists
 * the actions the extension supports (`features`), so the app can offer new
 * actions without refusing older extensions, and ask an unpacked install to
 * update itself (`update`).
 */

export const BRIDGE_PROTOCOL = 1

/**
 * The extension's Chrome Web Store listing, once it is published there (it
 * isn't yet). Set it to the listing URL, e.g.
 * 'https://chromewebstore.google.com/detail/eaon-browser-control/<extension-id>';
 * see extension/STORE_LISTING.md. While it is empty, nothing in Eaon mentions
 * the store: Settings → Browser extension offers only "Load unpacked", and the
 * agent's setup help says the same, so no one is sent to a listing that
 * doesn't exist.
 */
export const CHROME_WEB_STORE_URL = ''

export const BROWSER_ACTIONS = [
  'navigate',
  'new_tab',
  'list_tabs',
  'switch_tab',
  'close_tab',
  'snapshot',
  'click',
  'type',
  'press',
  'scroll',
  'select',
  'hover',
  'back',
  'forward',
  'wait',
  'screenshot',
  'get_url',
  // Extension 1.1.0 and later.
  'read',
  'find',
  'fill',
  'reload',
  // Extension 1.2.0 and later.
  'links',
  'clear',
  'get_text'
] as const

export type BrowserAction = (typeof BROWSER_ACTIONS)[number]

/** Newer-than on dotted versions ("1.0.10" > "1.0.9"). */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/** What an extension that sends no `features` (1.0.0) can do. */
export const V1_ACTIONS: readonly BrowserAction[] = BROWSER_ACTIONS.slice(0, BROWSER_ACTIONS.indexOf('read'))

/** Something the user right-clicked in the browser and sent to Eaon. */
export interface BrowserAsk {
  kind: 'page' | 'selection' | 'link'
  /** The selected text, for kind 'selection'. */
  text: string
  url: string
  title: string
  /** For kind 'page': the tab, now shared with the agent, so it can read it. */
  tabId: number | null
}

/** What Settings shows about the bridge. */
export interface BrowserBridgeStatus {
  enabled: boolean
  /** The loopback server is bound and accepting connections. */
  listening: boolean
  port: number
  /** Why the server is not listening (port taken, …), or null. */
  error: string | null
  /** A browser holds a valid token, whether or not it is connected right now. */
  paired: boolean
  connected: boolean
  /** The paired browser, as it last described itself. */
  client: BrowserClientInfo | null
  /** The user pressed "Stop agent control" in the extension. */
  paused: boolean
  /** The tab the agent is currently working in, if any. */
  agentTab: { title: string; url: string } | null
  /** The pairing code on offer, or null when none is (expired, used, or never asked for). */
  pairing: PairingCode | null
  /**
   * Version of the extension folder this app ships. An unpacked install older
   * than this needs a reload to pick up the update — which 1.1.0 and later
   * do themselves when asked.
   */
  bundledExtensionVersion: string | null
  /** The connected extension can update itself (unpacked, 1.1.0+). */
  canSelfUpdate: boolean
  /** Where the last update of the connected extension got to. */
  update: 'idle' | 'reloading' | 'stuck' | 'store'
  /**
   * The Swift-era extension (HTTP polling on port 8823) was heard from in the
   * last minute. It cannot talk to this app and must be replaced.
   */
  legacyExtensionSeenAt: number | null
}

export interface BrowserClientInfo {
  /** e.g. "Chrome 153". */
  browser: string
  extensionVersion: string
  /** 'development' when loaded unpacked, 'normal' from a store; null before 1.1.0. */
  installType: string | null
  pairedAt: number
  lastSeenAt: number
}

export interface PairingCode {
  /** Formatted for display, e.g. "K7Q-M4P". The extension ignores the dash. */
  code: string
  expiresAt: number
}

/**
 * An element from a snapshot, as the extension describes it. The bridge keeps
 * the latest set per tab so approval and risk checks can see what "click 12"
 * actually targets.
 */
export interface SnapshotElement {
  ref: number
  role: string
  name: string
  /** `type` of an <input>. */
  inputType?: string
  /** `autocomplete` hint, which is how card and one-time-code fields identify themselves. */
  autocomplete?: string
  /** Label of the submit button of the form this element belongs to. */
  form?: string
  /** Title of the dialog the element sits in — what an "OK" button is agreeing to. */
  context?: string
}

// ---------------------------------------------------------------- Messages

export type ExtensionMessage =
  | {
      type: 'hello'
      protocol: number
      extensionVersion: string
      browser: string
      /** Long-lived token from an earlier pairing. */
      token?: string
      /** Short code typed into the popup, exchanged once for a token. */
      pairingCode?: string
      /** 1.1.0+: the actions (and 'self-update', 'ask') this version supports. */
      features?: string[]
      /** 1.1.0+: 'development' (unpacked), 'normal' (store), … */
      installType?: string
    }
  | { type: 'result'; id: string; ok: true; result: unknown }
  | { type: 'result'; id: string; ok: false; error: string }
  | { type: 'state'; paused: boolean; agentTab: { title: string; url: string } | null }
  | { type: 'ping' }
  /** The user unpaired from the popup; the app forgets the token too. */
  | { type: 'unpair' }
  /** 1.1.0+: how an `update` request went. 'stuck': reloading changed nothing. */
  | { type: 'update-status'; state: 'reloading' | 'stuck' | 'store'; version: string }
  /** 1.1.0+: the user sent something to Eaon from the right-click menu. */
  | ({ type: 'ask' } & BrowserAsk)

export type RejectReason = 'bad-token' | 'bad-code' | 'protocol' | 'replaced' | 'unpaired' | 'timeout' | 'malformed'

export type DesktopMessage =
  /** `latestExtension`: the version this app ships, when newer than the extension's own. */
  | { type: 'welcome'; protocol: number; appVersion: string; token?: string; latestExtension?: string }
  /** Reload from disk to pick up `version` (unpacked installs), or ask the store to check. */
  | { type: 'update'; version: string }
  | { type: 'rejected'; reason: RejectReason; message: string }
  | { type: 'call'; id: string; action: BrowserAction; params: Record<string, unknown> }
  | { type: 'cancel'; id: string }
  | { type: 'pong' }
