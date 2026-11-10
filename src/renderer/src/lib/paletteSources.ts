import { SETTINGS_PAGES } from '@shared/settingsIndex'
import { isAgentKind, useApp, type WorkspaceKind } from '../state/store'
import { useOnboarding } from '../components/onboarding/onboardingStore'
import { KEYWORDS } from '../components/settings/SettingsShell'
import { registerPaletteSource, type PaletteAction } from './commands'
import { THEMES, releaseAde, themePatch } from './themes'

/**
 * What the command palette can do out of the box: the places in the app, the
 * Settings pages, the theme, a few switches, and the chats there are. Other
 * features add their own with registerPaletteSource (lib/commands.ts).
 *
 * Each `run` reads the app's state when it runs, not when the palette listed
 * it, so a choice made a moment after the list was drawn still acts on what
 * is on screen.
 */

const app = (): ReturnType<typeof useApp.getState> => useApp.getState()

const activeKind = (): WorkspaceKind | undefined => {
  const s = app()
  return s.workspaces.find((w) => w.id === s.settings?.activeWorkspaceId)?.kind
}

function goToTab(kind: WorkspaceKind): void {
  const s = app()
  const target = s.workspaces.find((w) => w.kind === kind)
  if (!target) return
  if (target.id !== s.settings?.activeWorkspaceId) s.setWorkspace(target.id)
  if (s.view !== 'chat') s.setView('chat')
}

/** The places in the app, and what the menu and keys do. */
function placesSource(): PaletteAction[] {
  const s = app()
  const kind = activeKind()
  const has = (k: WorkspaceKind): boolean => s.workspaces.some((w) => w.kind === k)
  const out: PaletteAction[] = [
    { id: 'chat:new', title: 'New chat', group: 'Chat', keywords: 'conversation start', shortcut: 'new-chat', run: () => app().newChat() }
  ]
  const tabs: [WorkspaceKind, string, string, string][] = [
    ['chat', 'Go to Chat', 'tab-chat', 'conversation'],
    ['workers', 'Go to Workers', 'tab-workers', 'background agents automations'],
    ['code', 'Go to the ADE', 'tab-ade', 'terminals coding agents sessions']
  ]
  for (const [tab, title, shortcut, keywords] of tabs) {
    if (has(tab)) out.push({ id: `go:${tab}`, title, group: 'Go to', keywords, shortcut, current: s.view === 'chat' && kind === tab, run: () => goToTab(tab) })
  }
  out.push(
    { id: 'go:models', title: 'Models', group: 'Go to', keywords: 'download local models llama gguf', run: () => { app().setView('models'); app().setModelsRepo(null) } },
    { id: 'go:library', title: 'Library', group: 'Go to', keywords: 'files images generated', run: () => app().setView('library') },
    { id: 'go:plugins', title: 'Plugins', group: 'Go to', keywords: 'skills mcp connectors integrations', shortcut: 'plugins', run: () => app().setView('plugins') },
    { id: 'go:scheduled', title: 'Scheduled tasks', group: 'Go to', keywords: 'automations cron recurring', run: () => app().setView('scheduled') },
    { id: 'go:pull-requests', title: 'Pull requests', group: 'Go to', keywords: 'github review pr', run: () => app().setView('pull-requests') },
    { id: 'go:issues', title: 'Issues (Linear, Jira, GitHub)', group: 'Go to', keywords: 'tickets linear jira github', run: () => app().setView('issues') },
    { id: 'view:sidebar', title: 'Show or hide the sidebar', group: 'View', keywords: 'toggle', shortcut: 'toggle-sidebar', run: () => app().toggleSidebar() }
  )
  // The browser panel sits beside Chat and the ADE's terminals only.
  if (isAgentKind(kind) || kind === 'code') {
    out.push({ id: 'view:browser', title: 'Show or hide the browser panel', group: 'View', keywords: 'toggle web page', shortcut: 'toggle-browser', run: () => app().toggleBrowser() })
  }
  out.push(
    {
      id: 'app:updates',
      title: 'Check for updates',
      group: 'App',
      keywords: 'version upgrade install',
      run: () => {
        void window.api.updater.check()
        app().setSettingsPage('general')
      }
    },
    {
      id: 'app:tour',
      title: 'Take the tour',
      group: 'App',
      keywords: 'help welcome introduction',
      run: () => {
        if (app().settings?.onboarding.setup !== 'pending') useOnboarding.getState().startTour()
      }
    }
  )
  return out
}

/** Every Settings page (and the tabs of a page that has them). */
function settingsSource(): PaletteAction[] {
  const isWork = isAgentKind(activeKind())
  const workOnly = new Set(['browser', 'code-index'])
  const label = new Map(SETTINGS_PAGES.map((page) => [page.id, page.label]))
  return SETTINGS_PAGES.filter((page) => isWork || !workOnly.has(page.id)).map((page) => ({
    id: `settings:${page.id}`,
    title: `Settings: ${page.parent ? `${label.get(page.parent)} › ${page.label}` : page.label}`,
    group: 'Settings',
    keywords: KEYWORDS[page.id] ?? '',
    run: () => app().setSettingsPage(page.id)
  }))
}

/** The look of the app: light, dark or the system's, and the colour themes. */
function appearanceSource(): PaletteAction[] {
  const s = app().settings
  const mode = s?.appearance.mode
  const modes: ['system' | 'light' | 'dark', string][] = [
    ['dark', 'Use the dark appearance'],
    ['light', 'Use the light appearance'],
    ['system', 'Follow the system appearance']
  ]
  const out: PaletteAction[] = modes.map(([value, title]) => ({
    id: `appearance:${value}`,
    title,
    group: 'Appearance',
    keywords: 'theme mode dark light system',
    current: mode === value,
    run: () => void app().patchSettings({ appearance: { mode: value }, ...releaseAde(app().settings) })
  }))
  const preset = s?.appearance.light.preset
  for (const theme of THEMES) {
    out.push({
      id: `theme:${theme.name}`,
      title: `Theme: ${theme.name}`,
      group: 'Appearance',
      keywords: 'color colour theme',
      current: preset === theme.name,
      run: () => void app().patchSettings(themePatch(theme, app().settings))
    })
  }
  return out
}

/**
 * Switches that are safe to flip from a list: how Eaon looks and behaves,
 * not what it may do on its own (full access, approvals, computer use and
 * the servers stay on their own pages, behind their own explanations).
 */
interface SwitchSpec {
  id: string
  title: string
  keywords: string
  read: (s: NonNullable<ReturnType<typeof app>['settings']>) => boolean
  patch: (on: boolean) => Parameters<ReturnType<typeof app>['patchSettings']>[0]
}

const SWITCHES: SwitchSpec[] = [
  { id: 'suggestedPrompts', title: 'Suggested prompts', keywords: 'starter prompts home screen', read: (s) => s.general.suggestedPrompts, patch: (on) => ({ general: { suggestedPrompts: on } }) },
  { id: 'preventSleep', title: 'Prevent sleep while running', keywords: 'awake caffeinate', read: (s) => s.general.preventSleep, patch: (on) => ({ general: { preventSleep: on } }) },
  { id: 'autoCompact', title: 'Auto-compact long chats', keywords: 'context summarize', read: (s) => s.context.autoCompact, patch: (on) => ({ context: { autoCompact: on } }) },
  { id: 'pointerCursors', title: 'Use pointer cursors', keywords: 'hand cursor hover', read: (s) => s.appearance.pointerCursors, patch: (on) => ({ appearance: { pointerCursors: on } }) },
  { id: 'fontSmoothing', title: 'Font smoothing', keywords: 'anti-aliasing text', read: (s) => s.appearance.fontSmoothing, patch: (on) => ({ appearance: { fontSmoothing: on } }) },
  { id: 'taskComplete', title: 'Notify when a task finishes', keywords: 'notifications alerts finished done', read: (s) => s.notifications.taskComplete, patch: (on) => ({ notifications: { taskComplete: on } }) },
  { id: 'limitAlerts', title: 'Limit alerts', keywords: 'notifications usage plan quota', read: (s) => s.cliUsage.alerts, patch: (on) => ({ cliUsage: { alerts: on } }) }
]

function switchesSource(): PaletteAction[] {
  const s = app().settings
  if (!s) return []
  return SWITCHES.map((spec) => {
    const on = spec.read(s)
    return {
      id: `switch:${spec.id}`,
      title: spec.title,
      group: 'Switch',
      keywords: `${spec.keywords} toggle turn on off`,
      state: on ? 'On' : 'Off',
      run: () => {
        const now = app().settings
        if (now) void app().patchSettings(spec.patch(!spec.read(now)))
      }
    }
  })
}

/** Chats, by title, so a conversation is a few letters away. Listed only once something is typed. */
function chatsSource(query: string): PaletteAction[] {
  if (!query.trim()) return []
  const s = app()
  const chatKind = s.workspaces.filter((w) => w.kind === 'chat').map((w) => w.id)
  return s.chats
    .filter((chat) => !chat.archived && chatKind.includes(chat.workspaceId) && chat.title)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 400)
    .map((chat) => ({
      id: `chat:${chat.id}`,
      title: chat.title,
      group: 'Open chat',
      run: () => {
        const now = app()
        if (chat.workspaceId !== now.settings?.activeWorkspaceId) now.setWorkspace(chat.workspaceId)
        app().openChat(chat.id)
      }
    }))
}

let registered = false

/** Registers the built-in sources, once. */
export function registerBuiltinPaletteSources(): void {
  if (registered) return
  registered = true
  registerPaletteSource('places', placesSource)
  registerPaletteSource('switches', switchesSource)
  registerPaletteSource('appearance', appearanceSource)
  registerPaletteSource('chats', chatsSource)
  registerPaletteSource('settings', settingsSource)
}
