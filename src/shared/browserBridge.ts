/**
 * The contract between the desktop bridge (`src/main/features/browser/`) and
 * the Eaon Chrome extension (`extension/`).
 *
 * The extension is plain JavaScript with no build step, so it cannot import
 * this file. The message shapes are mirrored by hand in
 * `extension/lib/connection.js`; bump BRIDGE_PROTOCOL when either side changes
 * a shape the other relies on, and the bridge will refuse the mismatched
 * version with a message telling the user which side to update.
 */

export const BRIDGE_PROTOCOL = 1

/**
 * The extension's Chrome Web Store listing.
 *
 * FILL THIS IN AFTER PUBLISHING (@SansCreates): paste the listing URL, e.g.
 * 'https://chromewebstore.google.com/detail/eaon-browser-control/<extension-id>'.
 * While it is empty, Settings → Browser extension hides the store button and
 * offers only the "Load unpacked" route. See extension/STORE_LISTING.md.
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
  'get_url'
] as const

export type BrowserAction = (typeof BROWSER_ACTIONS)[number]

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
   * than this needs a reload in chrome://extensions to pick up the update.
   */
  bundledExtensionVersion: string | null
}

export interface BrowserClientInfo {
  /** e.g. "Chrome 153". */
  browser: string
  extensionVersion: string
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
    }
  | { type: 'result'; id: string; ok: true; result: unknown }
  | { type: 'result'; id: string; ok: false; error: string }
  | { type: 'state'; paused: boolean; agentTab: { title: string; url: string } | null }
  | { type: 'ping' }
  /** The user unpaired from the popup; the app forgets the token too. */
  | { type: 'unpair' }

export type RejectReason = 'bad-token' | 'bad-code' | 'protocol' | 'replaced' | 'unpaired' | 'timeout' | 'malformed'

export type DesktopMessage =
  | { type: 'welcome'; protocol: number; appVersion: string; token?: string }
  | { type: 'rejected'; reason: RejectReason; message: string }
  | { type: 'call'; id: string; action: BrowserAction; params: Record<string, unknown> }
  | { type: 'cancel'; id: string }
  | { type: 'pong' }
