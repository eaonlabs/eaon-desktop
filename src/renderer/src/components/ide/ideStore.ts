import { create } from 'zustand'
import type { WorkspaceEntry } from '@shared/workspaceFiles'
import { joinPath } from './paths'
import { toDisk, toEditor, type LineEnding } from './lineEndings'

/**
 * Chat's code panel: the agent's folder as a tree, the files open in it as
 * tabs, and each tab's text as edited and as last saved. The tree loads one
 * folder at a time, as it is opened.
 */

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
  /** Which pane the card shows: the folder and editor, or the chat's changes. */
  pane: 'files' | 'changes'
  setPane: (pane: 'files' | 'changes') => void
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
  setWidth: (width: number) => void
}

const WIDTH_KEY = 'eaon.codePanel.width'

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
  expanded: new Set(),
  entries: new Map(),
  tabs: [],
  active: null,
  caret: { line: 1, col: 1 },
  width: storedWidth(),
  pane: 'files',

  setPane(pane) {
    set({ pane })
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
 * list), where a path can be relative to the agent's folder.
 */
export async function openInCode(path: string): Promise<void> {
  const ide = useIde.getState()
  if (!ide.open) ide.setOpen(true)
  ide.setPane('files')
  const root = ide.root ?? (await window.api.workspaceFiles.root())
  await useIde.getState().openFile(joinPath(root, path))
}
