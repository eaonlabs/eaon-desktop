/*
 * Which tabs the agent may touch, and the "Eaon" tab group it works in.
 *
 * The rule is simple enough to state in the store listing: the agent can use
 * tabs in the Eaon group (which it opens itself, or which the user drags in)
 * and tabs the user shared from the popup. Every other tab is invisible to
 * it — not listed, not read, not screenshotted.
 *
 * Browsers without tab groups (and popup windows, which cannot hold one) get
 * the same rule by bookkeeping instead: the tabs the agent opened itself are
 * remembered as its own.
 */

import { getSession, patchSession } from './state.js'

const GROUP_TITLE = 'Eaon'
const GROUP_COLOR = 'blue'

/** Some Chromium browsers ship without the tab groups API; nothing may assume it. */
export const GROUPS_SUPPORTED = Boolean(chrome.tabGroups && typeof chrome.tabs.group === 'function')

export async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return null
  }
}

export function usableIn(session, tab) {
  return Boolean(tab && (ownedIn(session, tab) || session.sharedTabIds.includes(tab.id)))
}

/** The agent's own tab: in the Eaon group, or opened by the agent where no group could hold it. */
function ownedIn(session, tab) {
  return session.groupIds.includes(tab.groupId) || (session.ownedTabIds || []).includes(tab.id)
}

export async function canUse(tab) {
  return usableIn(await getSession(), tab)
}

export async function isShared(tabId) {
  return (await getSession()).sharedTabIds.includes(tabId)
}

/** In the Eaon group (or the agent's own tab, where groups are unavailable) — the agent may close it. */
export async function inAgentGroup(tab) {
  return Boolean(tab) && ownedIn(await getSession(), tab)
}

/** The agent's current tab, or null if it has none or lost access to it. */
export async function currentTab() {
  const session = await getSession()
  if (session.agentTabId === null) return null
  const tab = await getTab(session.agentTabId)
  if (!usableIn(session, tab)) {
    await patchSession({ agentTabId: null })
    return null
  }
  return tab
}

export async function setCurrentTab(tabId) {
  await patchSession({ agentTabId: tabId })
}

/** A group of ours that still exists, to put new tabs next to the agent's others. */
async function liveGroup(session) {
  if (!GROUPS_SUPPORTED) return null
  for (const id of session.groupIds) {
    try {
      return await chrome.tabGroups.get(id)
    } catch {
      /* closed; try the next */
    }
  }
  return null
}

/**
 * Puts a tab into the Eaon group, creating and labelling the group if needed.
 * Where that is impossible — no tab groups in this browser, or a popup
 * window — the tab is remembered as the agent's own instead.
 */
export async function adoptTab(tabId) {
  try {
    await groupTab(tabId)
  } catch {
    const session = await getSession()
    const owned = session.ownedTabIds || []
    if (!owned.includes(tabId)) await patchSession({ ownedTabIds: [...owned, tabId] })
  }
}

async function groupTab(tabId) {
  if (!GROUPS_SUPPORTED) throw new Error('This browser has no tab groups.')
  const session = await getSession()
  const tab = await getTab(tabId)
  if (!tab) return
  const group = await liveGroup(session)
  const groupId =
    group && group.windowId === tab.windowId
      ? await chrome.tabs.group({ tabIds: [tabId], groupId: group.id })
      : await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } })
  if (!session.groupIds.includes(groupId)) {
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR })
    await patchSession({ groupIds: [...session.groupIds, groupId] })
  }
}

/**
 * Opens a tab for the agent in the Eaon group — in the window the group
 * already lives in, else the window the user used last — and makes it the
 * agent's current tab.
 */
export async function openAgentTab(url) {
  const session = await getSession()
  const group = await liveGroup(session)
  let windowId = group ? group.windowId : null
  if (windowId === null) {
    try {
      windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id
    } catch {
      windowId = null
    }
  }
  let tab
  if (windowId === null || windowId === undefined) {
    const win = await chrome.windows.create({ url: url || 'about:blank', focused: true })
    tab = win.tabs[0]
  } else {
    tab = await chrome.tabs.create({ windowId, url: url || 'about:blank', active: true })
  }
  await adoptTab(tab.id)
  await setCurrentTab(tab.id)
  return (await getTab(tab.id)) || tab
}

export async function shareTab(tabId) {
  const session = await getSession()
  if (!session.sharedTabIds.includes(tabId)) await patchSession({ sharedTabIds: [...session.sharedTabIds, tabId] })
}

export async function unshareTab(tabId) {
  const session = await getSession()
  await patchSession({
    sharedTabIds: session.sharedTabIds.filter((id) => id !== tabId),
    ...(session.agentTabId === tabId ? { agentTabId: null } : {})
  })
}

/** Tabs the agent may use, in tab-strip order. */
export async function usableTabs() {
  const session = await getSession()
  const all = await chrome.tabs.query({})
  return { usable: all.filter((tab) => usableIn(session, tab)), total: all.length, session }
}

export function tabLabel(tab) {
  return tab.title || (tab.url ? tab.url : tab.pendingUrl || 'New tab')
}

export async function listTabsText() {
  const { usable, total, session } = await usableTabs()
  const lines = usable.map((tab) => {
    const marks = [
      tab.id === session.agentTabId ? 'current' : '',
      session.sharedTabIds.includes(tab.id) ? 'shared by the user' : '',
      tab.active ? 'visible' : ''
    ].filter(Boolean)
    return `- tabId ${tab.id}: ${JSON.stringify(tabLabel(tab))} — ${tab.url || tab.pendingUrl || 'about:blank'}${marks.length ? ` (${marks.join(', ')})` : ''}`
  })
  const others = total - usable.length
  const note = others
    ? `\n${others} other tab${others === 1 ? ' is' : 's are'} open that you cannot use. The user can share one from the Eaon extension popup.`
    : ''
  return lines.length ? `Tabs you can use:\n${lines.join('\n')}${note}` : `You have no tabs yet — navigate {url} opens one.${note}`
}

/** Forget a closed tab everywhere it is remembered. */
export async function forgetTab(tabId) {
  const session = await getSession()
  const docs = { ...session.docs }
  delete docs[tabId]
  const nextRefs = { ...(session.nextRefs || {}) }
  delete nextRefs[tabId]
  await patchSession({
    nextRefs,
    sharedTabIds: session.sharedTabIds.filter((id) => id !== tabId),
    ownedTabIds: (session.ownedTabIds || []).filter((id) => id !== tabId),
    agentTabId: session.agentTabId === tabId ? null : session.agentTabId,
    docs
  })
}

export async function forgetGroup(groupId) {
  const session = await getSession()
  if (session.groupIds.includes(groupId)) await patchSession({ groupIds: session.groupIds.filter((id) => id !== groupId) })
}
