import type { Settings, Workspace } from './types'

/**
 * The top bar's tabs, which the user picks and orders in Settings → General
 * → Tabs (and in the first-run setup).
 *
 * Chat and the IDE share the chat workspace, its chats and its projects. An
 * ordinary chat is Chat's; a chat that works in a project folder, with the
 * code panel beside it, is the IDE's. The IDE only ever lists its own, Chat
 * there or not: plain chats in the IDE would make it a second Chat. Chat
 * without the IDE beside it has every chat, as it did before the IDE had a tab.
 */
export type AppTab = 'chat' | 'ide' | 'workers' | 'ade'

/** Every tab, in the order a new install shows them. */
export const APP_TABS: readonly AppTab[] = ['chat', 'workers', 'ide', 'ade']

/** The workspace behind each tab. */
export const TAB_KIND: Record<AppTab, Workspace['kind']> = { chat: 'chat', ide: 'chat', workers: 'workers', ade: 'code' }

export const TAB_LABEL: Record<AppTab, string> = { chat: 'Chat', ide: 'IDE', workers: 'Workers', ade: 'ADE' }

/** What each tab is for, for its tooltip and the Tabs settings. */
export const TAB_HINT: Record<AppTab, string> = {
  chat: 'Ask anything, or hand Eaon a task',
  ide: 'Code in a project with an agent, the code panel beside it',
  workers: 'Agents that keep working in the background',
  ade: 'Agentic development environment: coding agents in terminals'
}

/** The tabs shown, in order: the setting cleaned of unknown and repeated tabs; every tab when none is left. */
export function shownTabs(tabs: readonly unknown[] | null | undefined): AppTab[] {
  const known = new Set<string>(APP_TABS)
  const out = [...new Set((tabs ?? []).filter((tab): tab is AppTab => typeof tab === 'string' && known.has(tab)))]
  return out.length > 0 ? out : [...APP_TABS]
}

/** Chat and the IDE each list only their own chats: when both are tabs. */
export const splitsChats = (tabs: readonly AppTab[]): boolean => tabs.includes('chat') && tabs.includes('ide')

/**
 * An install set up before the IDE had its own tab updated into four tabs it
 * never chose, so it's asked once which it wants (components/onboarding/
 * TabsPrompt.tsx). Not while the setup, which has its own Tabs step, or the
 * what's-new tour is still to come, and not once it has picked them in
 * Settings.
 */
export function tabsPromptDue(settings: (Pick<Settings, 'onboarding'> & { general?: { tabs?: unknown } }) | null | undefined): boolean {
  if (!settings) return false
  const { onboarding } = settings
  return onboarding.setup !== 'pending' && onboarding.whatsNew !== null && !onboarding.tabsAsked && settings.general?.tabs === undefined
}

/** The chat workspace's two sides. */
export type ChatSide = 'chat' | 'ide'

/**
 * The side of the chat workspace in front, given the side last shown: the
 * IDE's whenever the IDE is the tab in front, even without Chat; null for
 * Chat with no IDE tab, which lists every chat.
 */
export function chatSideIn(side: ChatSide | null | undefined, tabs: readonly AppTab[]): ChatSide | null {
  if (!tabs.includes('ide')) return null
  return activeTab('chat', side, tabs) === 'ide' ? 'ide' : 'chat'
}

/** The tab a chat belongs to: the IDE once it works in a project. */
export const sideOfChat = (chat: { projectId?: string | null }): ChatSide => (chat.projectId ? 'ide' : 'chat')

/**
 * The tab in front: the active workspace's, and for the chat workspace the
 * side last shown. When only one of Chat and the IDE is a tab, that one.
 */
export function activeTab(kind: Workspace['kind'] | undefined, side: ChatSide | null | undefined, tabs: readonly AppTab[]): AppTab {
  if (kind === 'workers') return 'workers'
  if (kind === 'code') return 'ade'
  if (!splitsChats(tabs)) return tabs.includes('ide') && !tabs.includes('chat') ? 'ide' : 'chat'
  return side === 'ide' ? 'ide' : 'chat'
}
