import { create } from 'zustand'
import type { ChatGitStatus, OpenTarget, ProjectScript, ScriptSuggestion } from '@shared/chatCode'
import { agentWorkspace, useApp } from '../../state/store'
import { terminals } from '../code/terminal/registry'
import { groupOf, nextTitle, splitTabs, type PaneTab, type SplitDir } from './terminalLayout'

/**
 * Chat's coding controls: the folder the agent works in, where it stands in
 * git, the terminal drawer under the conversation and its tabs, the
 * project's scripts, and the app to open the folder in. The folder is the
 * chat workspace's, or Eaon's default work folder when it has none.
 */

export interface DrawerTab extends PaneTab {
  cwd: string
  /** What the tab was started to run: a script's command, or null for a plain shell. */
  command: string | null
  /** The script it runs, so running it again reuses the tab. */
  scriptId?: string
}

export { colOf, groupOf, type SplitDir } from './terminalLayout'

/** The drawer's panes, without the dock's. */
export const drawerTabs = (tabs: DrawerTab[]): DrawerTab[] => tabs.filter((t) => !t.dock)

interface ChatCodeState {
  folder: string | null
  status: ChatGitStatus | null
  /** Reads where the folder stands in git again. */
  refresh: () => Promise<void>
  /** Picks up the folder from the chat workspace; reads it again when it moved. */
  syncFolder: () => Promise<void>

  drawerOpen: boolean
  drawerHeight: number
  tabs: DrawerTab[]
  activeTab: string | null
  toggleDrawer: (open?: boolean) => void
  setDrawerHeight: (height: number) => void
  newTab: (spec?: { title?: string; command?: string | null; scriptId?: string }) => string | null
  /** A new shell beside `id`, in its group: a column to its right, or under it in its column. */
  splitTab: (id: string, dir: SplitDir) => string | null
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  /** The first shell of a dock terminal surface, its id the surface's own. */
  openDockTerminal: (surfaceId: string, title: string) => void
  /** A dock terminal surface closed: its shells stop. */
  closeDockTerminal: (surfaceId: string) => void

  scripts: ProjectScript[]
  suggestions: ScriptSuggestion[]
  loadScripts: () => Promise<void>
  saveScripts: (scripts: ProjectScript[]) => Promise<void>

  targets: OpenTarget[] | null
  preferred: string | null
  loadTargets: () => Promise<void>
  setPreferred: (id: string) => void

  searchOpen: boolean
  setSearchOpen: (open: boolean) => void

  /** The workspace card beside the conversation (WorkspaceCard): shown where there is room for it. */
  cardOpen: boolean
  /** Without the room, the card opens over the conversation until dismissed. */
  cardPeek: boolean
  toggleCard: (wide: boolean) => void
  setCardPeek: (peek: boolean) => void

  /** The project's files for the @ menu, relative; null until first asked for. */
  files: string[] | null
  /** Reads them when they haven't been, or were read a while ago (the agent adds files). */
  loadFiles: () => void
}

/** The @ menu's file list is read again after this long. */
const FILES_FRESH_MS = 20_000
let filesAt = 0
let filesLoading = false

const HEIGHT_KEY = 'eaon.chatCode.drawerHeight'
const OPEN_KEY = 'eaon.chatCode.drawerOpen'
const EDITOR_KEY = 'eaon.chatCode.editor'
const CARD_KEY = 'eaon.chatCode.card'

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private window: kept for this session only */
  }
}

const TABS_KEY = 'eaon.chatCode.tabs'

/**
 * The drawer's tabs for this run of the app, so reloading the window finds
 * its shells again (main keeps them running and replays their screens). Not
 * past a restart: the shells are gone then, and a script tab would run its
 * command again unasked.
 */
function savedTabs(): { tabs: DrawerTab[]; active: string | null } {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TABS_KEY) ?? 'null') as { tabs?: DrawerTab[]; active?: string | null } | null
    const tabs = (saved?.tabs ?? []).filter((t) => typeof t?.id === 'string' && typeof t.cwd === 'string')
    const drawer = drawerTabs(tabs)
    return { tabs, active: drawer.some((t) => t.id === saved?.active) ? (saved?.active ?? null) : (drawer[0]?.id ?? null) }
  } catch {
    return { tabs: [], active: null }
  }
}

const newId = (): string => `chat-term-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
export const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

export const useChatCode = create<ChatCodeState>((set, get) => ({
  folder: null,
  status: null,

  refresh: async () => {
    const folder = get().folder
    if (!folder) return
    try {
      const status = await window.api.chatCode.status(folder)
      // The folder may have moved while git was asked.
      if (get().folder === folder) set({ status })
    } catch {
      if (get().folder === folder) set({ status: null })
    }
  },

  syncFolder: async () => {
    const cwd = agentWorkspace(useApp.getState().workspaces)?.cwd || (await window.api.workspaceFiles.root().catch(() => null))
    if (!cwd || cwd === get().folder) return
    filesAt = 0
    set({ folder: cwd, status: null, scripts: [], suggestions: [], files: null })
    await Promise.all([get().refresh(), get().loadScripts()])
  },

  cardOpen: read(CARD_KEY) !== '0',
  cardPeek: false,
  toggleCard: (wide) => {
    if (!wide) return set({ cardPeek: !get().cardPeek })
    const next = !get().cardOpen
    write(CARD_KEY, next ? '1' : '0')
    set({ cardOpen: next, cardPeek: false })
  },
  setCardPeek: (cardPeek) => set({ cardPeek }),

  drawerOpen: read(OPEN_KEY) === '1',
  drawerHeight: Math.min(900, Math.max(140, Number(read(HEIGHT_KEY)) || 280)),
  tabs: savedTabs().tabs,
  activeTab: savedTabs().active,

  toggleDrawer: (open) => {
    const next = open ?? !get().drawerOpen
    write(OPEN_KEY, next ? '1' : '0')
    set({ drawerOpen: next })
    // Opened with nothing in it: a shell to type in.
    if (next && drawerTabs(get().tabs).length === 0) get().newTab()
  },

  setDrawerHeight: (height) => {
    const h = Math.round(Math.min(900, Math.max(140, height)))
    write(HEIGHT_KEY, String(h))
    set({ drawerHeight: h })
  },

  newTab: (spec) => {
    const cwd = get().folder
    if (!cwd) return null
    const tab: DrawerTab = {
      id: newId(),
      title: spec?.title ?? nextTitle(drawerTabs(get().tabs)),
      cwd,
      command: spec?.command ?? null,
      ...(spec?.scriptId ? { scriptId: spec.scriptId } : {})
    }
    set({ tabs: [...get().tabs, tab], activeTab: tab.id, drawerOpen: true })
    write(OPEN_KEY, '1')
    return tab.id
  },

  splitTab: (id, dir) => {
    const from = get().tabs.find((t) => t.id === id)
    if (!from) return null
    const tab: DrawerTab = {
      id: newId(),
      title: nextTitle(from.dock ? get().tabs.filter((t) => t.dock === from.dock) : drawerTabs(get().tabs)),
      cwd: from.cwd,
      command: null,
      ...(from.dock ? { dock: from.dock } : {})
    }
    set({ tabs: splitTabs(get().tabs, id, dir, tab), ...(from.dock ? {} : { activeTab: tab.id }) })
    return tab.id
  },

  closeTab: (id) => {
    const tabs = get().tabs
    const closing = tabs.find((t) => t.id === id)
    if (!closing) return
    terminals.dispose(id)
    const rest = tabs.filter((t) => t.id !== id)
    if (closing.dock) return set({ tabs: rest })
    const drawer = drawerTabs(tabs)
    const left = drawerTabs(rest)
    const index = drawer.findIndex((t) => t.id === id)
    // Next in front: a pane left in its group, or else the group beside it.
    const sibling = left.find((t) => groupOf(t) === groupOf(closing))
    const active = get().activeTab === id ? (sibling?.id ?? left[Math.min(index, left.length - 1)]?.id ?? null) : get().activeTab
    set({ tabs: rest, activeTab: active, ...(left.length === 0 ? { drawerOpen: false } : {}) })
    if (left.length === 0) write(OPEN_KEY, '0')
  },

  setActiveTab: (id) => set({ activeTab: id }),

  openDockTerminal: (surfaceId, title) => {
    const cwd = get().folder
    if (!cwd || get().tabs.some((t) => t.dock === surfaceId)) return
    set({ tabs: [...get().tabs, { id: surfaceId, title, cwd, command: null, dock: surfaceId }] })
  },

  closeDockTerminal: (surfaceId) => {
    const closing = get().tabs.filter((t) => t.dock === surfaceId)
    if (closing.length === 0) return
    for (const tab of closing) terminals.dispose(tab.id)
    set({ tabs: get().tabs.filter((t) => t.dock !== surfaceId) })
  },

  scripts: [],
  suggestions: [],
  loadScripts: async () => {
    const folder = get().folder
    if (!folder) return
    const res = await window.api.chatCode.scripts(folder).catch(() => null)
    if (res && get().folder === folder) set({ scripts: res.scripts, suggestions: res.suggestions })
  },
  saveScripts: async (scripts) => {
    const folder = get().folder
    if (!folder) return
    set({ scripts })
    const saved = await window.api.chatCode.saveScripts(folder, scripts)
    if (get().folder === folder) set({ scripts: saved })
  },

  targets: null,
  preferred: read(EDITOR_KEY),
  loadTargets: async () => {
    if (get().targets) return
    const targets = await window.api.chatCode.openTargets().catch(() => [] as OpenTarget[])
    set({ targets })
  },
  setPreferred: (id) => {
    write(EDITOR_KEY, id)
    set({ preferred: id })
  },

  searchOpen: false,
  setSearchOpen: (open) => set({ searchOpen: open }),

  files: null,
  loadFiles: () => {
    const folder = get().folder
    if (!folder || filesLoading || Date.now() - filesAt < FILES_FRESH_MS) return
    filesLoading = true
    filesAt = Date.now()
    window.api.chatCode
      .files(folder)
      .then((files) => get().folder === folder && set({ files }))
      .catch(() => get().folder === folder && set({ files: [] }))
      .finally(() => (filesLoading = false))
  }
}))

/** The app the Open button opens in: the last one picked, else the first editor found, else the file manager. */
export function preferredTarget(targets: OpenTarget[] | null, preferred: string | null): OpenTarget | null {
  if (!targets || targets.length === 0) return null
  return targets.find((t) => t.id === preferred) ?? targets.find((t) => t.kind === 'editor') ?? targets[0]
}

let watching = false

/**
 * Keeps the folder and its git state current, once for the window: when the
 * chat workspace moves to another folder, after each reply (the agent may
 * have changed files or branches), and back from another app.
 */
export function watchChatCode(): void {
  if (watching) return
  watching = true
  void useChatCode.getState().syncFolder()
  useApp.subscribe((state, prev) => {
    const cwd = agentWorkspace(state.workspaces)?.cwd
    if (cwd !== agentWorkspace(prev.workspaces)?.cwd) void useChatCode.getState().syncFolder()
    if (prev.streamingMessageId !== null && state.streamingMessageId === null) void useChatCode.getState().refresh()
  })
  window.addEventListener('focus', () => void useChatCode.getState().refresh())
}

useChatCode.subscribe((state, prev) => {
  if (state.tabs === prev.tabs && state.activeTab === prev.activeTab) return
  try {
    sessionStorage.setItem(TABS_KEY, JSON.stringify({ tabs: state.tabs, active: state.activeTab }))
  } catch {
    /* a reload starts the drawer empty */
  }
})
