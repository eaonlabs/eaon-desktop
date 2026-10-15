import { create } from 'zustand'
import type { DesignNote } from '@shared/browser'
import { useApp, useWorkspaceKind } from '../../state/store'
import { useCode } from '../code/codeStore'
import { hostOf } from './urls'

export { hostOf, isLocalUrl, toUrl } from './urls'

/**
 * The in-app browser's tabs and Design Mode notes.
 *
 * Tabs belong to a scope: each ADE project folder has its own (the dev
 * server for one project isn't the one for the next), and Chat has one set.
 * The open tabs, the panel's width and the pages visited are remembered across
 * launches; pages themselves live in the panel's `<webview>`s.
 */

export interface BrowserTab {
  id: string
  /** What the tab shows now, as the page last reported it. Empty for the start page. */
  url: string
  title: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Why the page didn't load, shown in place of it. */
  error: string | null
  /** Bumped to make the page load `url` again: the address bar, a link from a terminal. */
  load: number
}

interface Scope {
  tabs: BrowserTab[]
  activeId: string
}

export interface Visit {
  url: string
  title: string
  at: number
}

interface BrowserState {
  scopes: Record<string, Scope>
  width: number
  /** The browser has the whole window beside the sidebar. */
  expanded: boolean
  /** Picking elements on the active page. */
  designMode: boolean
  notes: Record<string, DesignNote[]>
  /** Notes open for editing: they stay in the tray when the others are sent. */
  editing: Record<string, true>
  history: Visit[]

  /** Gives a scope its first, empty tab when it has none. */
  ensure: (key: string) => void
  /** Opens `url` in a new tab, or in this one when it is still on the start page. */
  open: (key: string, url: string, options?: { background?: boolean }) => void
  newTab: (key: string) => void
  closeTab: (key: string, id: string) => void
  activate: (key: string, id: string) => void
  navigate: (key: string, id: string, url: string) => void
  patchTab: (key: string, id: string, patch: Partial<BrowserTab>) => void
  setWidth: (width: number) => void
  setExpanded: (expanded: boolean) => void
  setDesignMode: (on: boolean) => void
  addNote: (key: string, note: DesignNote) => void
  setNote: (key: string, id: string, text: string) => void
  setEditing: (id: string, editing: boolean) => void
  removeNote: (key: string, id: string) => void
  clearNotes: (key: string) => void
  /** The notes ready to send (not being edited), taken out of the tray. */
  takeNotes: (key: string) => DesignNote[]
  visit: (url: string, title: string) => void
  clearHistory: () => void
}

const STORAGE = 'eaon.browser.v1'
export const MIN_WIDTH = 340

const uid = (): string => Math.random().toString(36).slice(2, 10)

const blankTab = (url = ''): BrowserTab => ({
  id: uid(),
  url,
  title: url ? hostOf(url) : 'New tab',
  favicon: null,
  loading: Boolean(url),
  canGoBack: false,
  canGoForward: false,
  error: null,
  load: 0
})

const blankScope = (): Scope => {
  const tab = blankTab()
  return { tabs: [tab], activeId: tab.id }
}

interface Saved {
  scopes?: Record<string, { tabs: { url: string; title: string }[]; active: number }>
  width?: number
  history?: Visit[]
}

function load(): Pick<BrowserState, 'scopes' | 'width' | 'history'> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Saved
    const scopes: Record<string, Scope> = {}
    for (const [key, value] of Object.entries(saved.scopes ?? {})) {
      const tabs = value.tabs.slice(0, 20).map((t) => ({ ...blankTab(t.url), title: t.title || hostOf(t.url), loading: false }))
      if (tabs.length) scopes[key] = { tabs, activeId: tabs[Math.min(value.active, tabs.length - 1)]?.id ?? tabs[0].id }
    }
    return { scopes, width: saved.width ?? 520, history: (saved.history ?? []).slice(0, 200) }
  } catch {
    return { scopes: {}, width: 520, history: [] }
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persist(state: BrowserState): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const scopes: Saved['scopes'] = {}
    for (const [key, scope] of Object.entries(state.scopes)) {
      const tabs = scope.tabs.filter((t) => t.url)
      if (tabs.length === 0) continue
      scopes[key] = { tabs: tabs.map((t) => ({ url: t.url, title: t.title })), active: Math.max(0, tabs.findIndex((t) => t.id === scope.activeId)) }
    }
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ scopes, width: state.width, history: state.history }))
    } catch {
      /* private mode or full: the browser still works, it just forgets */
    }
  }, 400)
}

export const useBrowser = create<BrowserState>((set, get) => {
  const updateScope = (key: string, change: (scope: Scope) => Scope): void => {
    set((s) => ({ scopes: { ...s.scopes, [key]: change(s.scopes[key] ?? blankScope()) } }))
    persist(get())
  }
  const updateNotes = (key: string, change: (notes: DesignNote[]) => DesignNote[]): void =>
    set((s) => ({ notes: { ...s.notes, [key]: change(s.notes[key] ?? []) } }))

  return {
    ...load(),
    expanded: false,
    designMode: false,
    notes: {},
    editing: {},

    ensure(key) {
      if (!get().scopes[key]) set((s) => ({ scopes: { ...s.scopes, [key]: blankScope() } }))
    },

    open(key, url, options) {
      updateScope(key, (scope) => {
        const active = scope.tabs.find((t) => t.id === scope.activeId)
        if (active && !active.url && !options?.background) {
          return { ...scope, tabs: scope.tabs.map((t) => (t.id === active.id ? { ...t, url, title: hostOf(url), loading: true, error: null, load: t.load + 1 } : t)) }
        }
        // A link from a terminal to a page already open just shows that tab.
        const same = scope.tabs.find((t) => sameUrl(t.url, url))
        if (same && !options?.background) return { ...scope, activeId: same.id }
        const tab = blankTab(url)
        const index = scope.tabs.findIndex((t) => t.id === scope.activeId)
        const tabs = [...scope.tabs.slice(0, index + 1), tab, ...scope.tabs.slice(index + 1)]
        return { tabs, activeId: options?.background ? scope.activeId : tab.id }
      })
    },

    newTab(key) {
      updateScope(key, (scope) => {
        const tab = blankTab()
        return { tabs: [...scope.tabs, tab], activeId: tab.id }
      })
    },

    closeTab(key, id) {
      updateScope(key, (scope) => {
        const index = scope.tabs.findIndex((t) => t.id === id)
        const tabs = scope.tabs.filter((t) => t.id !== id)
        if (tabs.length === 0) return blankScope()
        const activeId = scope.activeId === id ? tabs[Math.min(index, tabs.length - 1)].id : scope.activeId
        return { tabs, activeId }
      })
    },

    activate(key, id) {
      updateScope(key, (scope) => ({ ...scope, activeId: id }))
    },

    navigate(key, id, url) {
      updateScope(key, (scope) => ({
        ...scope,
        tabs: scope.tabs.map((t) => (t.id === id ? { ...t, url, title: t.url ? t.title : hostOf(url), loading: true, error: null, load: t.load + 1 } : t))
      }))
    },

    patchTab(key, id, patch) {
      updateScope(key, (scope) => ({ ...scope, tabs: scope.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
    },

    setWidth(width) {
      set({ width: Math.round(Math.max(MIN_WIDTH, width)) })
      persist(get())
    },

    setExpanded(expanded) {
      set({ expanded })
    },

    setDesignMode(on) {
      set({ designMode: on })
    },

    addNote(key, note) {
      updateNotes(key, (notes) => [...notes, note])
      set((s) => ({ editing: { ...s.editing, [note.id]: true } }))
    },

    setNote(key, id, text) {
      updateNotes(key, (notes) => notes.map((n) => (n.id === id ? { ...n, note: text } : n)))
    },

    setEditing(id, editing) {
      set((s) => {
        const next = { ...s.editing }
        if (editing) next[id] = true
        else delete next[id]
        return { editing: next }
      })
    },

    removeNote(key, id) {
      updateNotes(key, (notes) => notes.filter((n) => n.id !== id))
      get().setEditing(id, false)
    },

    clearNotes(key) {
      updateNotes(key, () => [])
      set({ editing: {} })
    },

    takeNotes(key) {
      const editing = get().editing
      const all = get().notes[key] ?? []
      const ready = all.filter((n) => !editing[n.id])
      updateNotes(key, (notes) => notes.filter((n) => editing[n.id]))
      return ready
    },

    visit(url, title) {
      if (!/^https?:/i.test(url)) return
      set((s) => ({ history: [{ url, title, at: Date.now() }, ...s.history.filter((v) => v.url !== url)].slice(0, 200) }))
      persist(get())
    },

    clearHistory() {
      set({ history: [] })
      persist(get())
    }
  }
})

/** Which set of tabs is on screen: the ADE's project folder, or Chat's. */
export function useBrowserScope(): string {
  const kind = useWorkspaceKind()
  const cwd = useCode((s) => s.cwd)
  return kind === 'code' && cwd ? `code:${cwd}` : 'chat'
}

/** Opens a page in the in-app browser, showing the panel. From a terminal link in the ADE, among others. */
export function openInBrowser(url: string, scope?: string): void {
  const app = useApp.getState()
  const kind = app.workspaces.find((w) => w.id === app.settings?.activeWorkspaceId)?.kind
  const cwd = useCode.getState().cwd
  const key = scope ?? (kind === 'code' && cwd ? `code:${cwd}` : 'chat')
  useBrowser.getState().open(key, url)
  if (!app.browserOpen) app.toggleBrowser(true)
}

function sameUrl(a: string, b: string): boolean {
  return Boolean(a) && a.replace(/\/$/, '') === b.replace(/\/$/, '')
}
