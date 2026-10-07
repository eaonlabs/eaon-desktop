/*
 * Carries out the actions the desktop agent asks for.
 *
 * Tab-level work (opening, switching, history, screenshots) uses the tabs
 * API. Anything inside a page goes through chrome.scripting into
 * content/agent.js, which is injected only when the agent acts on a tab.
 *
 * Why not chrome.debugger: it would give trusted input events, but Chrome
 * shows "Eaon started debugging this browser" across every tab for as long
 * as it is attached, and the Web Store treats it as a high-risk permission.
 * Simulated DOM events plus execCommand cover links, buttons, forms and most
 * rich editors; the few sites that insist on trusted input get an honest
 * "that had no effect" from the agent instead.
 */

import { getSession, patchSession } from './state.js'
import {
  adoptTab,
  canUse,
  currentTab,
  forgetTab,
  getTab,
  inAgentGroup,
  isShared,
  listTabsText,
  openAgentTab,
  setCurrentTab,
  tabLabel,
  usableTabs
} from './tabs.js'

export const PAUSED_MESSAGE =
  'The user pressed "Stop agent control" in the Eaon extension. Do not use the browser again unless they ask you to; they can resume from the extension popup.'
const NO_TAB = 'You have no tab yet. Open one with navigate {url} or new_tab, or ask the user to share a tab from the Eaon extension popup.'
/** Wide enough to read, small enough that a screenshot costs the model ~1.5k tokens. */
const MAX_SHOT_WIDTH = 1280
const MAX_SHOT_HEIGHT = 1600
/** Chrome allows two captureVisibleTab calls per second. */
const CAPTURE_GAP_MS = 550

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The global content/agent.js installs, one per extension version — see the top of that file. */
const AGENT_KEY = `__eaonAgent@${chrome.runtime.getManifest().version}`

/**
 * Every action this version can carry out. Sent to the app in the hello, so
 * a newer app can tell an out-of-date extension apart from a failed action.
 * The last two are capabilities rather than actions.
 */
export const FEATURES = [
  'navigate', 'new_tab', 'list_tabs', 'switch_tab', 'close_tab', 'snapshot', 'click', 'type', 'press', 'scroll',
  'select', 'hover', 'back', 'forward', 'wait', 'screenshot', 'get_url', 'read', 'find', 'fill', 'reload',
  'links', 'clear', 'get_text',
  'self-update', 'ask'
]

class PageError extends Error {}

let controlledListener = () => {}
/** Called with a tab id every time the agent acts on that tab (drives the indicator and badge). */
export function onControlled(listener) {
  controlledListener = listener
}

// ------------------------------------------------------------- Page access

function explain(error, tab) {
  if (error instanceof PageError) return error
  const message = String(error && error.message ? error.message : error)
  const url = (tab && (tab.url || tab.pendingUrl)) || ''
  let out
  if (/cannot be scripted|cannot access|chrome:\/\/|chrome-extension:|extensions gallery|webstore|missing host permission/i.test(message)) {
    out = new Error(`Chrome does not let extensions read or control this page (${url || 'a browser page'}). Navigate to a regular website instead.`)
  } else if (/error page/i.test(message)) {
    out = new Error(`The page failed to load (${url}). Check the address, or try again.`)
  } else if (/no tab with id/i.test(message)) {
    out = new Error('That tab was closed.')
  } else if (/frame.*removed|unloaded|navigat/i.test(message)) {
    return new Error('The page navigated away mid-action. Take a new snapshot.')
  } else {
    return new Error(message)
  }
  out.fatal = true
  return out
}

async function inPage(tab, action, params = {}) {
  try {
    // Injecting again is cheap: the script returns at once if it is already there.
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content/agent.js'] })
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: (key, name, args) => globalThis[key].run(name, args),
      args: [AGENT_KEY, action, params]
    })
    const value = injection && injection.result
    if (!value) throw new PageError('The page did not respond. It may still be loading — use wait, then try again.')
    if (value.error) throw new PageError(value.error)
    return value
  } catch (error) {
    throw explain(error, tab)
  }
}

export async function setIndicatorFor(tabId, on) {
  const tab = await getTab(tabId)
  if (!tab) return
  try {
    await inPage(tab, 'indicator', { on })
  } catch {
    /* protected or unloaded page: nothing to show it on */
  }
}

// -------------------------------------------------------------- Navigation

async function waitComplete(tabId, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error('Stopped.')
    const tab = await getTab(tabId)
    if (!tab) throw new Error('The tab was closed.')
    if (tab.status === 'complete') return true
    await sleep(100)
  }
  return false
}

/**
 * Watches a tab from just before an action until whatever it triggered has
 * settled: a navigation (reported so the agent knows its refs are now stale),
 * or a new tab the page opened (adopted, so the agent can follow it).
 */
function watchNavigation(tabId) {
  let started = false
  let openedTabId = null
  const onUpdated = (id, info) => {
    if (id === tabId && (info.status === 'loading' || info.url)) started = true
  }
  const onCreated = (tab) => {
    if (tab.openerTabId === tabId && openedTabId === null) openedTabId = tab.id
  }
  chrome.tabs.onUpdated.addListener(onUpdated)
  chrome.tabs.onCreated.addListener(onCreated)
  const stop = () => {
    chrome.tabs.onUpdated.removeListener(onUpdated)
    chrome.tabs.onCreated.removeListener(onCreated)
  }
  return {
    stop,
    async settle({ startWithinMs = 400, loadWithinMs = 15_000 } = {}) {
      try {
        const startBy = Date.now() + startWithinMs
        while (!started && openedTabId === null && Date.now() < startBy) await sleep(50)
        if (openedTabId !== null) return { kind: 'opened', tabId: openedTabId }
        if (!started) return { kind: 'none' }
        return { kind: (await waitComplete(tabId, loadWithinMs)) ? 'loaded' : 'loading' }
      } finally {
        stop()
      }
    }
  }
}

async function describeTab(tabId) {
  const tab = await getTab(tabId)
  return tab ? `${JSON.stringify(tabLabel(tab))} — ${tab.url || tab.pendingUrl || 'about:blank'}` : 'a tab that has since closed'
}

/**
 * `base` lets a path from a page ("/pricing", as read and find show links on
 * the same site) resolve against the page it came from.
 */
function normalizeUrl(raw, base) {
  let text = String(raw || '').trim()
  if (!text) throw new Error('navigate needs a url.')
  if (/^\/(?!\/)/.test(text) && base && /^https?:/i.test(base)) text = new URL(text, base).href
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|javascript|chrome|mailto|blob|view-source|file):/i.test(text)
  if (!hasScheme) text = `${/^(localhost|127\.|\[::1\])/i.test(text) ? 'http' : 'https'}://${text}`
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`"${raw}" is not a valid address.`)
  }
  if (url.protocol === 'about:' && url.href === 'about:blank') return url.href
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) {
    throw new Error(`The agent can only open web pages (http and https addresses), not ${url.protocol} ones.`)
  }
  return url.href
}

async function requireTab() {
  const tab = await currentTab()
  if (!tab) throw new Error(NO_TAB)
  return tab
}

/** Opens a tab the page spawned into the agent's reach. */
async function takeOver(tabId) {
  await adoptTab(tabId)
  await setCurrentTab(tabId)
  await waitComplete(tabId, 15_000)
  controlledListener(tabId)
}

async function navigate(params) {
  let tab = await currentTab()
  const url = normalizeUrl(params.url, tab && tab.url)
  let loaded
  if (!tab) {
    tab = await openAgentTab(url)
    await sleep(100)
    loaded = await waitComplete(tab.id, 30_000)
  } else {
    const watch = watchNavigation(tab.id)
    await chrome.tabs.update(tab.id, { url })
    const outcome = await watch.settle({ startWithinMs: 5_000, loadWithinMs: 30_000 })
    loaded = outcome.kind !== 'loading'
  }
  controlledListener(tab.id)
  await setIndicatorFor(tab.id, true)
  return {
    tabId: tab.id,
    message: `${loaded ? 'Loaded' : 'Still loading'} ${await describeTab(tab.id)}. Take a snapshot to read it.`
  }
}

async function newTab(params) {
  const url = params.url ? normalizeUrl(params.url) : 'about:blank'
  const tab = await openAgentTab(url)
  if (params.url) {
    await sleep(100)
    await waitComplete(tab.id, 30_000)
    controlledListener(tab.id)
    await setIndicatorFor(tab.id, true)
  }
  return { tabId: tab.id, message: `Opened tab ${tab.id} in the Eaon group: ${await describeTab(tab.id)}.` }
}

async function switchTab(params) {
  const tab = await getTab(params.tabId)
  if (!tab || !(await canUse(tab))) throw new Error(`You can't use tab ${params.tabId}. list_tabs shows the tabs you can use.`)
  await setCurrentTab(tab.id)
  await chrome.tabs.update(tab.id, { active: true })
  return { tabId: tab.id, message: `Switched to tab ${tab.id}: ${await describeTab(tab.id)}. Take a snapshot to see it.` }
}

async function closeTab(params) {
  const current = await currentTab()
  const tabId = params.tabId ?? (current && current.id)
  if (tabId === undefined || tabId === null) throw new Error(NO_TAB)
  const tab = await getTab(tabId)
  if (!tab) throw new Error(`Tab ${tabId} is already closed.`)
  if (!(await inAgentGroup(tab))) {
    if (await isShared(tabId)) {
      throw new Error(`Tab ${tabId} is the user's own tab, shared with you, so you can't close it. Use switch_tab to work somewhere else.`)
    }
    throw new Error(`You can't use tab ${tabId}. list_tabs shows the tabs you can use.`)
  }
  await chrome.tabs.remove(tabId)
  await forgetTab(tabId)
  const session = await getSession()
  const { usable } = await usableTabs()
  const next = usable.find((t) => t.id !== tabId && session.groupIds.includes(t.groupId)) || usable.find((t) => t.id !== tabId) || null
  await setCurrentTab(next ? next.id : null)
  return {
    tabId,
    currentTabId: next ? next.id : null,
    message: `Closed tab ${tabId}.${next ? ` Now working in tab ${next.id}: ${await describeTab(next.id)}.` : ' You have no tabs open now.'}`
  }
}

async function history(direction) {
  const tab = await requireTab()
  const watch = watchNavigation(tab.id)
  try {
    if (direction === 'back') await chrome.tabs.goBack(tab.id)
    else await chrome.tabs.goForward(tab.id)
  } catch (error) {
    // Chrome's history-manipulation intervention marks a page as skippable
    // when it was left without user activation — which every simulated click
    // is — and the browser's own back (chrome.tabs.goBack) then skips it,
    // often reporting there is nothing to go back to. The page's own history
    // API is not subject to that, so fall back to it.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        func: (back) => (back ? history.back() : history.forward()),
        args: [direction === 'back']
      })
    } catch {
      watch.stop()
      const message = String(error && error.message ? error.message : error)
      throw new Error(/cannot find|no (next|previous)/i.test(message) ? `There is no page to go ${direction} to.` : message)
    }
  }
  const outcome = await watch.settle({ startWithinMs: 3_000, loadWithinMs: 20_000 })
  controlledListener(tab.id)
  if (outcome.kind === 'none') return { tabId: tab.id, message: `Nothing happened going ${direction}; the tab is still on ${await describeTab(tab.id)}.` }
  return { tabId: tab.id, message: `Went ${direction} to ${await describeTab(tab.id)}. Take a snapshot to read it.` }
}

// ------------------------------------------------------------------ Pages

async function snapshot(params) {
  const tab = await requireTab()
  const before = await getSession()
  const refBase = (before.nextRefs && before.nextRefs[tab.id]) || 1
  const result = await inPage(tab, 'snapshot', { maxChars: params.maxChars || 8000, refBase })
  const session = await getSession()
  await patchSession({
    docs: { ...session.docs, [tab.id]: result.docId },
    nextRefs: { ...(session.nextRefs || {}), [tab.id]: result.nextRef }
  })
  controlledListener(tab.id)
  const shared = session.sharedTabIds.includes(tab.id) ? ' (the user\'s tab, shared with you)' : ''
  return { tabId: tab.id, docId: result.docId, text: `Tab ${tab.id}${shared}\n${result.text}`, elements: result.elements }
}

async function pageAction(action, params) {
  const tab = await requireTab()
  const session = await getSession()
  const pageParams = { ...params, docId: session.docs[tab.id] }
  const watch = watchNavigation(tab.id)
  let result
  try {
    result = await inPage(tab, action, pageParams)
    if (action === 'type' && params.submit) {
      const pressed = await inPage(tab, 'press', { ...pageParams, key: 'Enter' })
      result = { message: `${result.message}, then ${pressed.message.charAt(0).toLowerCase()}${pressed.message.slice(1)}` }
    }
  } catch (error) {
    watch.stop()
    throw error
  }
  controlledListener(tab.id)

  if (result.openTab) {
    watch.stop()
    const opened = await openAgentTab(normalizeUrl(result.openTab))
    await takeOver(opened.id)
    return { tabId: opened.id, message: `${result.message}. Now working in tab ${opened.id}: ${await describeTab(opened.id)}. Take a snapshot to see it.` }
  }
  if (action === 'get_text') {
    // Reading changes nothing, so there is no navigation to wait out.
    watch.stop()
    return { tabId: tab.id, text: result.text }
  }
  if (action === 'hover' || action === 'scroll') {
    watch.stop()
    return { tabId: tab.id, message: `${result.message}.` }
  }

  const outcome = await watch.settle()
  if (outcome.kind === 'opened') {
    await takeOver(outcome.tabId)
    return {
      tabId: outcome.tabId,
      message: `${result.message}. That opened tab ${outcome.tabId} (${await describeTab(outcome.tabId)}), which is now your current tab. Take a snapshot to see it.`
    }
  }
  if (outcome.kind === 'loaded') {
    await setIndicatorFor(tab.id, true)
    return { tabId: tab.id, message: `${result.message}. The page navigated to ${await describeTab(tab.id)} — take a new snapshot.` }
  }
  if (outcome.kind === 'loading') {
    return { tabId: tab.id, message: `${result.message}. The page is still loading ${await describeTab(tab.id)}; use wait, then snapshot.` }
  }
  return { tabId: tab.id, message: `${result.message}.` }
}

async function wait(params, signal) {
  const tab = await requireTab()
  const timeoutMs = Math.min(30_000, Math.max(500, params.timeoutMs || 10_000))
  const seconds = Math.round(timeoutMs / 100) / 10
  if (!params.text && !params.selector) {
    const loaded = await waitComplete(tab.id, timeoutMs, signal)
    // Client-rendered pages keep building after "complete"; give them a beat.
    await sleep(300)
    return { tabId: tab.id, message: loaded ? `Finished loading ${await describeTab(tab.id)}.` : `Still loading after ${seconds} s: ${await describeTab(tab.id)}.` }
  }
  const what = params.selector ? `an element matching ${JSON.stringify(params.selector)}` : `the text ${JSON.stringify(params.text)}`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error('Stopped.')
    try {
      const found = await inPage(tab, 'find', { text: params.text, selector: params.selector })
      if (found.found) return { tabId: tab.id, message: `Found ${what}.` }
    } catch (error) {
      // Mid-navigation the page cannot answer; keep polling. A bad selector
      // or a page Chrome protects will not fix itself.
      if (error instanceof PageError || error.fatal) throw error
    }
    await sleep(300)
  }
  throw new Error(`Waited ${seconds} s, but ${what} did not appear.`)
}

async function read(params) {
  const tab = await requireTab()
  const result = await inPage(tab, 'read', { offset: params.offset, maxChars: params.maxChars, all: params.all === true })
  controlledListener(tab.id)
  return { tabId: tab.id, text: result.text, nextOffset: result.nextOffset }
}

/**
 * `find` and `links`. Like snapshot, the refs they hand out belong to this
 * document; record it so they are honoured.
 */
async function findOnPage(params, pageAction = 'search') {
  const tab = await requireTab()
  const before = await getSession()
  const refBase = (before.nextRefs && before.nextRefs[tab.id]) || 1
  const result = await inPage(tab, pageAction, { text: params.text, limit: params.limit, refBase })
  const session = await getSession()
  await patchSession({
    docs: { ...session.docs, [tab.id]: result.docId },
    nextRefs: { ...(session.nextRefs || {}), [tab.id]: result.nextRef }
  })
  controlledListener(tab.id)
  return { tabId: tab.id, docId: result.docId, text: result.text, elements: result.elements }
}

async function reload() {
  const tab = await requireTab()
  const watch = watchNavigation(tab.id)
  await chrome.tabs.reload(tab.id)
  const outcome = await watch.settle({ startWithinMs: 3_000, loadWithinMs: 30_000 })
  controlledListener(tab.id)
  await setIndicatorFor(tab.id, true)
  return {
    tabId: tab.id,
    message: `Reloaded ${await describeTab(tab.id)}${outcome.kind === 'loading' ? ', which is still loading' : ''}. Refs from before the reload no longer work — take a new snapshot.`
  }
}

// ------------------------------------------------------------- Screenshots

let lastCapture = 0

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/**
 * Scales the capture to CSS pixels (a Retina capture is twice the size and
 * no more legible to a model) and re-encodes it as a compact JPEG.
 */
async function downscale(dataUrl, cssWidth) {
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  let scale = Math.min(1, MAX_SHOT_WIDTH / bitmap.width, cssWidth ? cssWidth / bitmap.width : 1)
  if (bitmap.height * scale > MAX_SHOT_HEIGHT) scale = MAX_SHOT_HEIGHT / bitmap.height
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 })
  return { data: toBase64(await out.arrayBuffer()), width, height }
}

async function screenshot() {
  let tab = await requireTab()
  // captureVisibleTab sees only the active tab of a window.
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true })
    await sleep(250)
    tab = (await getTab(tab.id)) || tab
  }
  const win = await chrome.windows.get(tab.windowId)
  if (win.state === 'minimized') {
    throw new Error('The browser window holding your tab is minimized, so it cannot be captured. Use snapshot, or ask the user to restore the window.')
  }
  // The indicator is for the user; keep it out of what the model sees.
  await setIndicatorFor(tab.id, false)
  let dataUrl
  try {
    const wait = lastCapture + CAPTURE_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCapture = Date.now()
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 })
  } catch (error) {
    throw explain(error, tab)
  } finally {
    await setIndicatorFor(tab.id, true)
  }
  const image = await downscale(dataUrl, tab.width)
  controlledListener(tab.id)
  return { tabId: tab.id, url: tab.url, title: tab.title, mime: 'image/jpeg', ...image }
}

async function getUrl() {
  const tab = await requireTab()
  return {
    tabId: tab.id,
    message: `Tab ${tab.id}: ${JSON.stringify(tabLabel(tab))} — ${tab.url || tab.pendingUrl || 'about:blank'} (${tab.status === 'complete' ? 'loaded' : 'still loading'})`
  }
}

// ---------------------------------------------------------------- Dispatch

export async function perform(action, params, signal) {
  const session = await getSession()
  if (session.paused) throw new Error(PAUSED_MESSAGE)
  switch (action) {
    case 'navigate':
      return navigate(params)
    case 'new_tab':
      return newTab(params)
    case 'list_tabs': {
      const current = await currentTab()
      return { text: await listTabsText(), ...(current ? { tabId: current.id } : {}) }
    }
    case 'switch_tab':
      return switchTab(params)
    case 'close_tab':
      return closeTab(params)
    case 'back':
    case 'forward':
      return history(action)
    case 'snapshot':
      return snapshot(params)
    case 'click':
    case 'type':
    case 'press':
    case 'select':
    case 'hover':
    case 'scroll':
    case 'fill':
    case 'clear':
    case 'get_text':
      return pageAction(action, params)
    case 'read':
      return read(params)
    case 'find':
      return findOnPage(params)
    case 'links':
      return findOnPage(params, 'links')
    case 'reload':
      return reload()
    case 'wait':
      return wait(params, signal)
    case 'screenshot':
      return screenshot()
    case 'get_url':
      return getUrl()
    default:
      throw new Error(`Unknown action "${action}".`)
  }
}
