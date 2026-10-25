import { create } from 'zustand'
import type { WorkspaceEntry } from '@shared/workspaceFiles'
import { joinPath } from './paths'
import { toDisk, toEditor, type LineEnding } from './lineEndings'
import type { ReviewScope } from '../chatCode/changes/build'
import { useChatCode } from '../chatCode/chatCodeStore'

/**
 * Chat's dock, the panel to the right of a conversation: the surfaces open in
 * it as tabs (browser pages, terminals, the folder's files, a file, the diff,
 * the pull request and the ones the chat links to, the page on a phone,
 * Eaon's own browser), and for the files the folder as a
 * tree and each open file's text as edited and as last saved. The tree loads
 * one folder at a time, as it is opened.
 */

export type SurfaceKind = 'browser' | 'agent' | 'terminal' | 'files' | 'file' | 'diff' | 'pr' | 'linked' | 'device'

/** A tab in the dock. */
export interface Surface {
  id: string
  kind: SurfaceKind
  /** A file's path. */
  path?: string
  /** A browser page's tab in the browser's own store. */
  tabId?: string
  /** A terminal's name. */
  title?: string
}

/** Kinds there is only ever one of: opening one again goes to it. */
const SINGLE = new Set<SurfaceKind>(['files', 'diff', 'pr', 'linked', 'device', 'agent'])
const SURFACES_KEY = 'eaon.dock.surfaces'

export interface IdeTab {
  path: string
  kind: 'text' | 'binary' | 'too-large' | 'error'
  /** What the editor shows, with `\n` line endings whatever the file has (lineEndings.ts). */
  text: string
  /** What is on disk, as far as the panel knows (with `\n` line endings too). */
  saved: string
  /** The line ending the file is saved with. */
  eol?: LineEnding
  /** The file's modified time when it was read or saved. */
  modified: number
  /** On disk it changed under unsaved edits: the tab offers to reload. */
  stale?: boolean
  error?: string
}

interface IdeState {
  open: boolean
  root: string | null
  /** Folders open in the tree. */
  expanded: Set<string>
  /** Each listed folder's entries. */
  entries: Map<string, WorkspaceEntry[]>
  tabs: IdeTab[]
  active: string | null
  /** Where the caret is in the active tab, for the status bar. */
  caret: { line: number; col: number }
  width: number
  /** The dock's tabs, in the order they were opened, and the one in front. */
  surfaces: Surface[]
  activeSurface: string | null
  /** The dock fills the window, the conversation behind it. */
  maximized: boolean
  /**
   * Opens a surface, or goes to the one already open: a file by its path,
   * the kinds there is one of by kind. A terminal is always a new one.
   * Returns its id.
   */
  openSurface: (kind: SurfaceKind, extra?: Pick<Surface, 'path' | 'tabId' | 'title'>) => string
  closeSurface: (id: string) => void
  setActiveSurface: (id: string) => void
  setMaximized: (maximized: boolean) => void
  /** Puts the dock's browser pages in step with the browser's own tabs: new ones added, closed ones gone. */
  syncBrowserTabs: (tabIds: string[]) => void
  /** Asked from elsewhere (a turn's Review button): the Diff shows this scope, scrolled to `file`. */
  review: { scope: ReviewScope; file?: string; nonce: number } | null
  reviewChanges: (scope: ReviewScope, file?: string) => void
  setOpen: (open: boolean) => void
  toggleDir: (path: string) => Promise<void>
  openFile: (path: string) => Promise<void>
  closeTab: (path: string) => void
  edit: (path: string, text: string) => void
  save: (path: string) => Promise<void>
  /** Reads what changed on disk: every listed folder, and each open file. */
  refresh: () => Promise<void>
  reload: (path: string) => Promise<void>
  setCaret: (caret: { line: number; col: number }) => void
  /** A line to bring into view and select in a file, once it is open; `nonce` asks again for the same line. */
  reveal: { path: string; line: number; nonce: number } | null
  revealLine: (path: string, line: number) => void
  setWidth: (width: number) => void
}

const WIDTH_KEY = 'eaon.codePanel.width'

/** The dock's tabs as this window left them; browser pages come back from the browser's own store. */
function savedSurfaces(): { surfaces: Surface[]; active: string | null } {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SURFACES_KEY) ?? 'null') as { surfaces?: Surface[]; active?: string | null } | null
    const surfaces = (saved?.surfaces ?? []).filter((s) => s && typeof s.id === 'string' && s.kind !== 'browser')
    return { surfaces, active: surfaces.some((s) => s.id === saved?.active) ? (saved?.active ?? null) : (surfaces[0]?.id ?? null) }
  } catch {
    return { surfaces: [], active: null }
  }
}

const surfaceId = (): string => `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

const storedWidth = (): number => {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return n >= 360 ? n : 560
  } catch {
    return 560
  }
}

async function readTab(path: string): Promise<IdeTab> {
  try {
    const file = await window.api.workspaceFiles.read(path)
    if (file.kind === 'text') {
      const { text, eol } = toEditor(file.text)
      return { path, kind: 'text', text, saved: text, eol, modified: file.modified }
    }
    return { path, kind: file.kind, text: '', saved: '', modified: file.modified }
  } catch (error) {
    return { path, kind: 'error', text: '', saved: '', modified: 0, error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error) }
  }
}

export const isDirty = (tab: IdeTab): boolean => tab.kind === 'text' && tab.text !== tab.saved

export const useIde = create<IdeState>((set, get) => ({
  open: false,
  root: null,
  reveal: null,
  revealLine: (path, line) => set({ reveal: { path, line, nonce: Date.now() } }),
  expanded: new Set(),
  entries: new Map(),
  tabs: [],
  active: null,
  caret: { line: 1, col: 1 },
  width: storedWidth(),
  surfaces: savedSurfaces().surfaces,
  activeSurface: savedSurfaces().active,
  maximized: false,
  review: null,

  openSurface(kind, extra) {
    if (!get().open) get().setOpen(true)
    const { surfaces } = get()
    const existing =
      kind === 'file'
        ? surfaces.find((s) => s.kind === 'file' && s.path === extra?.path)
        : kind === 'browser'
          ? surfaces.find((s) => s.kind === 'browser' && s.tabId === extra?.tabId)
          : SINGLE.has(kind)
            ? surfaces.find((s) => s.kind === kind)
            : undefined
    if (existing) {
      set({ activeSurface: existing.id })
      return existing.id
    }
    const terminals = surfaces.filter((s) => s.kind === 'terminal').length
    const surface: Surface = {
      id: kind === 'terminal' ? `dock-term-${surfaceId()}` : surfaceId(),
      kind,
      ...extra,
      ...(kind === 'terminal' && !extra?.title ? { title: `Terminal ${terminals + 1}` } : {})
    }
    set({ surfaces: [...surfaces, surface], activeSurface: surface.id })
    if (kind === 'file' && surface.path) void get().openFile(surface.path)
    return surface.id
  },

  closeSurface(id) {
    const { surfaces, activeSurface } = get()
    const index = surfaces.findIndex((s) => s.id === id)
    if (index < 0) return
    const surface = surfaces[index]
    const rest = surfaces.filter((s) => s.id !== id)
    const next = activeSurface === id ? (rest[Math.min(index, rest.length - 1)]?.id ?? null) : activeSurface
    set({ surfaces: rest, activeSurface: next })
    if (surface.kind === 'file' && surface.path) get().closeTab(surface.path)
    if (surface.kind === 'terminal') useChatCode.getState().closeDockTerminal(surface.id)
  },

  setActiveSurface(id) {
    if (get().surfaces.some((s) => s.id === id)) set({ activeSurface: id })
  },

  setMaximized(maximized) {
    set({ maximized })
  },

  syncBrowserTabs(tabIds) {
    const { surfaces, activeSurface } = get()
    const keep = surfaces.filter((s) => s.kind !== 'browser' || (s.tabId && tabIds.includes(s.tabId)))
    const known = new Set(keep.filter((s) => s.kind === 'browser').map((s) => s.tabId))
    const added = tabIds.filter((id) => !known.has(id)).map((tabId): Surface => ({ id: surfaceId(), kind: 'browser', tabId }))
    if (added.length === 0 && keep.length === surfaces.length) return
    const next = [...keep, ...added]
    set({ surfaces: next, activeSurface: next.some((s) => s.id === activeSurface) ? activeSurface : (added[added.length - 1]?.id ?? next[next.length - 1]?.id ?? null) })
  },

  reviewChanges(scope, file) {
    get().openSurface('diff')
    set({ review: { scope, ...(file ? { file } : {}), nonce: Date.now() } })
  },

  setOpen(open) {
    set({ open })
    if (!open) return
    void (async () => {
      const root = await window.api.workspaceFiles.root()
      if (root !== get().root) set({ root, expanded: new Set([root]), entries: new Map() })
      await get().refresh()
    })()
  },

  async toggleDir(path) {
    const expanded = new Set(get().expanded)
    if (expanded.has(path)) {
      expanded.delete(path)
      set({ expanded })
      return
    }
    expanded.add(path)
    set({ expanded })
    try {
      const list = await window.api.workspaceFiles.list(path)
      set({ entries: new Map(get().entries).set(path, list) })
    } catch {
      set({ entries: new Map(get().entries).set(path, []) })
    }
  },

  async openFile(path) {
    if (get().tabs.some((tab) => tab.path === path)) {
      set({ active: path })
      return
    }
    const tab = await readTab(path)
    set({ tabs: [...get().tabs.filter((t) => t.path !== path), tab], active: path, caret: { line: 1, col: 1 } })
  },

  closeTab(path) {
    const { tabs, active } = get()
    const index = tabs.findIndex((tab) => tab.path === path)
    const next = tabs.filter((tab) => tab.path !== path)
    const neighbour = next[Math.min(index, next.length - 1)]
    set({ tabs: next, active: active === path ? (neighbour?.path ?? null) : active })
  },

  edit(path, text) {
    set({ tabs: get().tabs.map((tab) => (tab.path === path ? { ...tab, text } : tab)) })
  },

  async save(path) {
    const tab = get().tabs.find((t) => t.path === path)
    if (!tab || tab.kind !== 'text') return
    const text = tab.text
    try {
      const modified = await window.api.workspaceFiles.write(path, toDisk(text, tab.eol ?? '\n'))
      set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, saved: text, modified, stale: false, error: undefined } : t)) })
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)
      set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, error: message } : t)) })
    }
  },

  async refresh() {
    const { expanded } = get()
    const listed = await Promise.all(
      [...expanded].map(async (dir) => {
        try {
          return [dir, await window.api.workspaceFiles.list(dir)] as const
        } catch {
          return null
        }
      })
    )
    const entries = new Map<string, WorkspaceEntry[]>()
    for (const pair of listed) if (pair) entries.set(pair[0], pair[1])
    set({ entries })

    const fresh = await Promise.all(get().tabs.map((tab) => readTab(tab.path)))
    set({
      tabs: get().tabs.map((tab) => {
        const disk = fresh.find((f) => f.path === tab.path)
        if (!disk || disk.modified === tab.modified) return tab
        // Changed on disk. A clean tab takes the new text; one with edits keeps
        // them and says the file moved underneath.
        if (!isDirty(tab)) return disk
        return { ...tab, stale: true }
      })
    })
  },

  async reload(path) {
    const tab = await readTab(path)
    set({ tabs: get().tabs.map((t) => (t.path === path ? tab : t)) })
  },

  setCaret(caret) {
    set({ caret })
  },

  setWidth(width) {
    set({ width })
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(width)))
    } catch {
      /* Storage can be unavailable; the width still applies for this session. */
    }
  }
}))

/**
 * Opens a file from elsewhere in the app (an edit card, the files-changed
 * list, a path in a reply, a search result), where a path can be relative
 * to the agent's folder, and at a line when one is given.
 */
export async function openInCode(path: string, line?: number): Promise<void> {
  const ide = useIde.getState()
  if (!ide.open) ide.setOpen(true)
  const root = ide.root ?? (await window.api.workspaceFiles.root())
  const full = joinPath(root, path)
  useIde.getState().openSurface('file', { path: full })
  await useIde.getState().openFile(full)
  if (line && line > 0) useIde.getState().revealLine(full, line)
}

// The dock's tabs live as long as the window: a reload brings the same terminals and files back.
useIde.subscribe((state, prev) => {
  if (state.surfaces === prev.surfaces && state.activeSurface === prev.activeSurface) return
  try {
    sessionStorage.setItem(SURFACES_KEY, JSON.stringify({ surfaces: state.surfaces.filter((s) => s.kind !== 'browser'), active: state.activeSurface }))
  } catch {
    /* kept for this window only */
  }
})
