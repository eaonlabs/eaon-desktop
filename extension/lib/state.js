/*
 * Everything the service worker must not lose when Chrome suspends it.
 *
 * An MV3 service worker is torn down after ~30 s without events, so module
 * variables are a cache at best. Pairing lives in storage.local (it has to
 * survive restarts). The agent's working state lives in storage.session: it
 * survives the worker being suspended but is cleared when the browser quits,
 * which is exactly the lifetime of tab ids and tab-group ids.
 */

const LOCAL_DEFAULTS = { token: null, port: 47821 }

const SESSION_DEFAULTS = {
  /** Tab groups this extension created and titled "Eaon". */
  groupIds: [],
  /** The tab the agent acts on when it does not name one. */
  agentTabId: null,
  /** The user's own tabs they explicitly shared from the popup. */
  sharedTabIds: [],
  /** "Stop agent control" was pressed; every action is refused until resumed. */
  paused: false,
  /** tabId → docId of the latest snapshot, so refs from an older page are refused. */
  docs: {},
  /** tabId → the next ref number, so refs keep counting up across a tab's pages. */
  nextRefs: {}
}

let sessionPromise = null
const listeners = new Set()

export function getLocal() {
  return chrome.storage.local.get(LOCAL_DEFAULTS)
}

export async function setLocal(patch) {
  await chrome.storage.local.set(patch)
  emit()
}

export function getSession() {
  sessionPromise ??= chrome.storage.session.get(SESSION_DEFAULTS)
  return sessionPromise
}

/** Merges `patch` into the session state. Always pass fresh arrays and objects. */
export async function patchSession(patch) {
  const session = await getSession()
  Object.assign(session, patch)
  await chrome.storage.session.set(patch)
  emit()
}

/** Called after any state change; used to refresh the popup and tell the desktop app. */
export function onStateChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emit() {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('[eaon] state listener failed', error)
    }
  }
}
