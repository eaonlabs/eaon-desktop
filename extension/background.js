/*
 * Service worker: connects to the Eaon desktop app, runs the actions its
 * agent sends, and keeps the popup and the on-page indicator in step.
 *
 * Every listener is registered synchronously at the top level. Chrome only
 * delivers an event to a suspended worker if the listener was registered on
 * the worker's first run, so nothing here may be added after an await.
 */

import { perform, onControlled, PAUSED_MESSAGE, setIndicatorFor } from './lib/actions.js'
import { connect, connection, ensureConnected, installType, isConnected, pair, retryNow, send, setConnectionHandlers, unpair } from './lib/connection.js'
import { getLocal, getSession, handOffSession, onStateChange, patchSession, setLocal } from './lib/state.js'
import { currentTab, forgetGroup, forgetTab, getTab, inAgentGroup, setCurrentTab, shareTab, tabLabel, unshareTab } from './lib/tabs.js'

/** The indicator comes down after this long without an action on the tab. */
const IDLE_MS = 60_000
const RECONNECT_ALARM = 'eaon-reconnect'
const MENU = { page: 'eaon-ask-page', selection: 'eaon-ask-selection', link: 'eaon-ask-link' }

/** Newer-than on dotted versions ("1.0.10" > "1.0.9"). */
function isNewer(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/** Desktop call id → AbortController, so "Stop" and cancels can end them. */
const inflight = new Map()
/** Tabs the agent acted on recently → when. */
const controlled = new Map()
let sweepTimer = null

// ------------------------------------------------------------ Desktop calls

function abortAll(reason) {
  for (const controller of inflight.values()) controller.abort(new Error(reason))
}

setConnectionHandlers({
  onCall: async (message) => {
    const controller = new AbortController()
    inflight.set(message.id, controller)
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason || new Error('Cancelled.')), { once: true })
    })
    try {
      const result = await Promise.race([perform(message.action, message.params || {}, controller.signal), aborted])
      send({ type: 'result', id: message.id, ok: true, result })
    } catch (error) {
      send({ type: 'result', id: message.id, ok: false, error: error && error.message ? error.message : String(error) })
    } finally {
      inflight.delete(message.id)
    }
  },
  onCancel: (id) => inflight.get(id)?.abort(new Error('Cancelled by the Eaon app.')),
  onConnected: () => {
    lastReported = ''
    reportState()
  },
  onDisconnected: () => {
    abortAll('The connection to the Eaon app closed.')
    // Nobody can act on these tabs now; do not leave "Eaon is using this tab" up.
    for (const tabId of controlled.keys()) setIndicatorFor(tabId, false)
    controlled.clear()
    updateBadge()
  },
  onUpdate: (message) => selfUpdate(message.version, false)
})

// ------------------------------------------------------------- Self-update

/**
 * Loaded unpacked, this extension updates by reloading from its own folder,
 * which the app keeps current. The app asks when it ships a newer version;
 * the popup's Update button asks on the user's behalf. A store install is
 * updated by the store, so it only asks the store to check.
 *
 * A reload that brings no new version means the extension was loaded from a
 * folder the app does not update; that is reported, not retried in a loop.
 */
async function selfUpdate(target, userAsked) {
  const current = chrome.runtime.getManifest().version
  if (!userAsked && !isNewer(target, current)) return { ok: false, error: 'Already up to date.' }
  if ((await installType()) !== 'development') {
    try {
      await chrome.runtime.requestUpdateCheck()
    } catch {
      /* not every browser implements it */
    }
    send({ type: 'update-status', state: 'store', version: current })
    return { ok: true, store: true }
  }
  const { updateAttempt } = await getLocal()
  const recent = updateAttempt && updateAttempt.from === current && Date.now() - updateAttempt.at < 10 * 60_000
  if (!userAsked && recent && updateAttempt.target === target) {
    send({ type: 'update-status', state: 'stuck', version: current })
    return { ok: false, error: 'Reloading did not update the extension. Load it again from the folder Eaon shows in Settings → Browser extension.' }
  }
  await setLocal({ updateAttempt: { target: target || current, from: current, at: Date.now() } })
  // The agent may be mid-task: its tabs must still be its tabs afterwards.
  await handOffSession()
  send({ type: 'update-status', state: 'reloading', version: current })
  // Long enough for that message to leave before the worker is torn down.
  setTimeout(() => chrome.runtime.reload(), 250)
  return { ok: true }
}

// ------------------------------------------------------ Control and indicator

onControlled((tabId) => {
  controlled.set(tabId, Date.now())
  updateBadge()
  clearTimeout(sweepTimer)
  sweepTimer = setTimeout(sweepIdle, IDLE_MS + 500)
})

function sweepIdle() {
  const now = Date.now()
  for (const [tabId, at] of controlled) {
    if (now - at < IDLE_MS) continue
    controlled.delete(tabId)
    setIndicatorFor(tabId, false)
  }
  updateBadge()
  if (controlled.size) sweepTimer = setTimeout(sweepIdle, 5_000)
}

/**
 * The toolbar icon says what needs attention without opening the popup:
 * ON while the agent works, OFF when it was stopped, ! when the extension
 * needs pairing or cannot connect, ↑ when the app has a newer version for it.
 * A plain "app not running" stays quiet — that is normal.
 */
let badgeFlash = null
async function updateBadge() {
  if (badgeFlash) return
  const session = await getSession()
  let text = ''
  let color = '#0169cc'
  let title = 'Eaon'
  if (connection.status === 'connected') {
    title = `Eaon — connected${connection.appVersion ? ` to Eaon ${connection.appVersion}` : ''}`
    if (session.paused) {
      text = 'OFF'
      color = '#6b6b70'
      title = 'Eaon — agent control is stopped'
    } else if (controlled.size) {
      text = 'ON'
      title = 'Eaon — the agent is using this browser'
    } else if (connection.latestExtension) {
      text = '↑'
      color = '#1e8e3e'
      title = `Eaon — extension ${connection.latestExtension} is available`
    }
  } else if (connection.status === 'unpaired') {
    text = '!'
    color = '#e8a33d'
    title = 'Eaon — not paired yet. Click to pair with the Eaon app.'
  } else if (connection.status === 'error') {
    text = '!'
    color = '#d93025'
    title = `Eaon — ${connection.message || 'can’t connect'}`
  } else {
    title = 'Eaon — the Eaon app isn’t running'
  }
  chrome.action.setBadgeText({ text }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {})
  chrome.action.setTitle({ title }).catch(() => {})
}

/** A brief "!" on the icon, for a menu or shortcut that could not do anything. */
function flashBadge(title) {
  clearTimeout(badgeFlash)
  chrome.action.setBadgeText({ text: '!' }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' }).catch(() => {})
  chrome.action.setTitle({ title }).catch(() => {})
  badgeFlash = setTimeout(() => {
    badgeFlash = null
    updateBadge()
  }, 4000)
}

async function stopControl() {
  abortAll(PAUSED_MESSAGE)
  // Stopping also withdraws every tab the user shared: resuming later should
  // not quietly hand the agent back their own tabs.
  await patchSession({ paused: true, sharedTabIds: [] })
  for (const tabId of controlled.keys()) setIndicatorFor(tabId, false)
  controlled.clear()
  updateBadge()
}

chrome.runtime.onMessage.addListener((message, sender) => {
  // Only our own content script sends these (the indicator's Stop button).
  if (sender.id !== chrome.runtime.id) return
  if (message && message.type === 'eaon-stop') stopControl()
})

// --------------------------------------------------- Right-click and keyboard

function createMenus() {
  if (!chrome.contextMenus) return
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.selection, title: 'Ask Eaon about “%s”', contexts: ['selection'] })
    chrome.contextMenus.create({ id: MENU.link, title: 'Send link to Eaon', contexts: ['link'] })
    chrome.contextMenus.create({ id: MENU.page, title: 'Ask Eaon about this page', contexts: ['page'] })
  })
}

/**
 * Starts a chat in the Eaon app about what the user right-clicked. The app
 * puts it in a new chat's composer as a draft — never sends it — so page text
 * never reaches the model without the user reading it first.
 */
async function askEaon(info, tab) {
  if (!isConnected()) {
    flashBadge('Eaon — open the Eaon app (and pair this browser) to send things to it.')
    return
  }
  const kind = info.menuItemId === MENU.selection ? 'selection' : info.menuItemId === MENU.link ? 'link' : 'page'
  const pageUrl = (tab && tab.url) || info.pageUrl || ''
  let sharedTabId = null
  if (kind === 'page' && tab && /^(https?|file):/i.test(pageUrl)) {
    // Asking about a page is choosing to show it to Eaon: share it, exactly
    // as the popup's "Share this tab" would. The popup can take it back.
    await shareTab(tab.id)
    if ((await getSession()).agentTabId === null) await setCurrentTab(tab.id)
    sharedTabId = tab.id
  }
  send({
    type: 'ask',
    kind,
    text: kind === 'selection' ? String(info.selectionText || '').slice(0, 20_000) : '',
    url: kind === 'link' ? String(info.linkUrl || '') : pageUrl,
    title: (tab && tab.title) || '',
    tabId: sharedTabId
  })
}

if (chrome.contextMenus) chrome.contextMenus.onClicked.addListener((info, tab) => void askEaon(info, tab))

if (chrome.commands) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'stop-agent') void stopControl()
  })
}

// ------------------------------------------------------ State for the desktop

let lastReported = ''
let reportTimer = null

async function agentTabSummary() {
  const tab = await currentTab()
  return tab ? { id: tab.id, title: tabLabel(tab), url: tab.url || tab.pendingUrl || '', favIconUrl: tab.favIconUrl || '' } : null
}

function reportState() {
  clearTimeout(reportTimer)
  reportTimer = setTimeout(async () => {
    const session = await getSession()
    const tab = await agentTabSummary()
    const state = { type: 'state', paused: session.paused, agentTab: tab ? { title: tab.title, url: tab.url } : null }
    const text = JSON.stringify(state)
    if (text === lastReported) return
    if (send(state)) lastReported = text
  }, 100)
}

// ------------------------------------------------------------------- Popup

const popups = new Set()

async function popupState() {
  const [local, session, agentTab] = await Promise.all([getLocal(), getSession(), agentTabSummary()])
  let activeTab = null
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab) {
      const url = tab.url || tab.pendingUrl || ''
      activeTab = {
        id: tab.id,
        title: tabLabel(tab),
        url,
        favIconUrl: tab.favIconUrl || '',
        scriptable: /^(https?|file):/i.test(url),
        shared: session.sharedTabIds.includes(tab.id),
        inGroup: await inAgentGroup(tab)
      }
    }
  } catch {
    activeTab = null
  }
  return {
    status: connection.status,
    message: connection.message,
    appVersion: connection.appVersion,
    latestExtension: connection.latestExtension,
    installType: await installType(),
    // "Updated from 1.0.0" stays in the popup for a day after an update.
    lastUpdate: local.lastUpdate && Date.now() - local.lastUpdate.at < 86_400_000 ? local.lastUpdate : null,
    paired: Boolean(local.token),
    port: local.port,
    paused: session.paused,
    agentTab,
    activeTab,
    sharedCount: session.sharedTabIds.length,
    stopShortcut: await stopShortcut(),
    version: chrome.runtime.getManifest().version
  }
}

async function stopShortcut() {
  try {
    const commands = await chrome.commands.getAll()
    return commands.find((command) => command.name === 'stop-agent')?.shortcut || ''
  } catch {
    return ''
  }
}

let popupTimer = null
function pushPopupState() {
  clearTimeout(popupTimer)
  popupTimer = setTimeout(async () => {
    if (!popups.size) return
    const state = await popupState()
    for (const port of popups) port.postMessage({ type: 'state', state })
  }, 30)
}

async function handlePopup(message) {
  switch (message.type) {
    case 'pair':
      return pair(message.code, Number(message.port) || undefined)
    case 'unpair':
      await unpair()
      return { ok: true }
    case 'retry':
      retryNow()
      return { ok: true }
    case 'set-port': {
      const port = Number(message.port)
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: 'Use a port between 1024 and 65535.' }
      await setLocal({ port })
      retryNow()
      return { ok: true }
    }
    case 'share': {
      const tab = await getTab(message.tabId)
      if (!tab || !/^(https?|file):/i.test(tab.url || '')) return { ok: false, error: 'Chrome does not let extensions control this page.' }
      await shareTab(tab.id)
      // With nothing else to work in, the shared tab is what the agent meant.
      if ((await getSession()).agentTabId === null) await setCurrentTab(tab.id)
      return { ok: true }
    }
    case 'unshare':
      await unshareTab(message.tabId)
      setIndicatorFor(message.tabId, false)
      controlled.delete(message.tabId)
      updateBadge()
      return { ok: true }
    case 'stop':
      await stopControl()
      return { ok: true }
    case 'resume':
      await patchSession({ paused: false })
      return { ok: true }
    case 'update':
      return selfUpdate(connection.latestExtension, true)
    case 'show-agent-tab': {
      const tab = await currentTab()
      if (!tab) return { ok: false }
      await chrome.tabs.update(tab.id, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      return { ok: true }
    }
    default:
      return { ok: false, error: `Unknown request "${message.type}".` }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup' || port.sender?.id !== chrome.runtime.id) return
  popups.add(port)
  port.onDisconnect.addListener(() => popups.delete(port))
  port.onMessage.addListener(async (message) => {
    let reply
    try {
      reply = await handlePopup(message)
    } catch (error) {
      reply = { ok: false, error: error && error.message ? error.message : String(error) }
    }
    try {
      port.postMessage({ type: 'reply', id: message.id, ...reply })
    } catch {
      /* popup closed while we worked */
    }
    pushPopupState()
  })
  pushPopupState()
})

onStateChange(() => {
  pushPopupState()
  reportState()
  updateBadge()
})

// -------------------------------------------------------------- Tab events

chrome.tabs.onRemoved.addListener((tabId) => {
  controlled.delete(tabId)
  updateBadge()
  forgetTab(tabId)
})

// Not every Chromium browser has tab groups (see lib/tabs.js); a listener on
// a missing API would throw here and take the whole worker down with it.
if (chrome.tabGroups) {
  chrome.tabGroups.onRemoved.addListener((group) => {
    forgetGroup(group.id)
  })
}

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  // A navigation replaces the page, indicator included; put it back while
  // the agent is still working in this tab.
  if (info.status === 'complete' && controlled.has(tabId)) {
    const session = await getSession()
    if (!session.paused) setIndicatorFor(tabId, true)
  }
  if (info.title || info.url || info.status === 'complete') {
    const session = await getSession()
    if (session.agentTabId === tabId) reportState()
  }
  if (popups.size) pushPopupState()
})

chrome.tabs.onActivated.addListener(() => {
  if (popups.size) pushPopupState()
})

// ------------------------------------------------------------- Lifecycle

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) ensureConnected()
})
chrome.runtime.onStartup.addListener(() => ensureConnected())
chrome.runtime.onInstalled.addListener((details) => {
  // Menus outlive the worker, so they are made once per install or update.
  createMenus()
  if (details.reason === 'update' && details.previousVersion !== chrome.runtime.getManifest().version) {
    void setLocal({ lastUpdate: { from: details.previousVersion, to: chrome.runtime.getManifest().version, at: Date.now() }, updateAttempt: null })
  }
  ensureConnected()
})

chrome.alarms.get(RECONNECT_ALARM).then((existing) => {
  if (!existing) chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
})

// Every time the worker starts — install, browser launch, or a wake-up
// after being suspended — try to reach the app.
connect()
updateBadge()
