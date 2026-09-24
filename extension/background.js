/*
 * Service worker: connects to the Eaon desktop app, runs the actions its
 * agent sends, and keeps the popup and the on-page indicator in step.
 *
 * Every listener is registered synchronously at the top level. Chrome only
 * delivers an event to a suspended worker if the listener was registered on
 * the worker's first run, so nothing here may be added after an await.
 */

import { perform, onControlled, PAUSED_MESSAGE, setIndicatorFor } from './lib/actions.js'
import { connect, connection, ensureConnected, pair, retryNow, send, setConnectionHandlers, unpair } from './lib/connection.js'
import { getLocal, getSession, onStateChange, patchSession, setLocal } from './lib/state.js'
import { currentTab, forgetGroup, forgetTab, getTab, inAgentGroup, setCurrentTab, shareTab, tabLabel, unshareTab } from './lib/tabs.js'

/** The indicator comes down after this long without an action on the tab. */
const IDLE_MS = 60_000
const RECONNECT_ALARM = 'eaon-reconnect'

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
  }
})

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

function updateBadge() {
  chrome.action.setBadgeText({ text: controlled.size ? 'ON' : '' }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ color: '#0169cc' }).catch(() => {})
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
    paired: Boolean(local.token),
    port: local.port,
    paused: session.paused,
    agentTab,
    activeTab,
    sharedCount: session.sharedTabIds.length,
    version: chrome.runtime.getManifest().version
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
})

// -------------------------------------------------------------- Tab events

chrome.tabs.onRemoved.addListener((tabId) => {
  controlled.delete(tabId)
  updateBadge()
  forgetTab(tabId)
})

chrome.tabGroups.onRemoved.addListener((group) => {
  forgetGroup(group.id)
})

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
chrome.runtime.onInstalled.addListener(() => ensureConnected())

chrome.alarms.get(RECONNECT_ALARM).then((existing) => {
  if (!existing) chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
})

// Every time the worker starts — install, browser launch, or a wake-up
// after being suspended — try to reach the app.
connect()
