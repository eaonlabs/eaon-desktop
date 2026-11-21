import { create } from 'zustand'
import { terminals } from './terminal/registry'
import { useTerminals } from './terminal/terminalStore'
import { useCode } from './codeStore'

/**
 * How the ADE's sidebar lists its sessions: its projects, each a heading
 * that folds, with their sessions under them (the way other agent apps list
 * them), or one list with each session tagged with its project. Its search, its order, the
 * sessions pinned to the top, and the ones whose agents finished while
 * another was on screen. The view, order and pins are remembered on this
 * computer, as the folded projects are.
 */

export type AdeListView = 'list' | 'projects'
export type AdeListSort = 'recent' | 'created'

export const ADE_SORTS: Record<AdeListSort, string> = { recent: 'Recent activity', created: 'Date created' }

interface AdeListState {
  view: AdeListView
  sort: AdeListSort
  /** What the search row holds; not remembered. */
  query: string
  /** Sessions pinned to the top of the list, by id. */
  pinned: Record<string, true>
  /** Sessions whose agents finished a stretch of work while another session was shown, by folder: "Done" until shown. */
  done: Record<string, true>
  /** Whether the Working and Archived sections are open (Archived starts folded). */
  workingOpen: boolean
  archivedOpen: boolean
  /** Whose agents are listed under their row (the tray opens and folds them), by folder; unset is the open session only. Not remembered. */
  agentsOpen: Record<string, boolean>
  setView: (view: AdeListView) => void
  setSort: (sort: AdeListSort) => void
  setQuery: (query: string) => void
  togglePin: (id: string) => void
  setWorkingOpen: (open: boolean) => void
  setArchivedOpen: (open: boolean) => void
  setAgentsOpen: (cwd: string, open: boolean) => void
}

const KEY = 'eaon.ade.list'
type Saved = Pick<AdeListState, 'view' | 'sort' | 'pinned' | 'workingOpen' | 'archivedOpen'>
const DEFAULTS: Saved = { view: 'projects', sort: 'recent', pinned: {}, workingOpen: true, archivedOpen: false }
/** Saved views from before "By project" was the default are its builds' default, not a choice: only this version's is read. */
const VIEW_VERSION = 2

function read(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved> & { v?: number }
    return {
      view: saved.v === VIEW_VERSION && saved.view === 'list' ? 'list' : 'projects',
      sort: saved.sort === 'created' ? 'created' : 'recent',
      pinned: saved.pinned && typeof saved.pinned === 'object' ? saved.pinned : {},
      workingOpen: saved.workingOpen !== false,
      archivedOpen: saved.archivedOpen === true
    }
  } catch {
    return DEFAULTS
  }
}

export const useAdeList = create<AdeListState>((set, get) => {
  const save = (patch: Partial<Saved>): void => {
    set(patch)
    const { view, sort, pinned, workingOpen, archivedOpen } = get()
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: VIEW_VERSION, view, sort, pinned, workingOpen, archivedOpen }))
    } catch {
      /* Remembered until the app closes. */
    }
  }
  return {
    ...read(),
    query: '',
    done: {},
    agentsOpen: {},
    setView: (view) => save({ view }),
    setSort: (sort) => save({ sort }),
    setQuery: (query) => set({ query }),
    togglePin: (id) => {
      const pinned = { ...get().pinned }
      if (pinned[id]) delete pinned[id]
      else pinned[id] = true
      save({ pinned })
    },
    setWorkingOpen: (workingOpen) => save({ workingOpen }),
    setArchivedOpen: (archivedOpen) => save({ archivedOpen }),
    setAgentsOpen: (cwd, open) => set((s) => ({ agentsOpen: { ...s.agentsOpen, [cwd]: open } }))
  }
})

let watching = false

/**
 * Marks a session Done when one of its agents finishes a stretch of work
 * (the registry's finish: it worked a while, then went quiet) while another
 * session is on screen, and clears the mark once it's shown. Started once,
 * by the sidebar.
 */
export function watchFinishes(): void {
  if (watching) return
  watching = true
  terminals.onFinish((paneId) => {
    const layout = useTerminals.getState().layout
    const cwd = Object.keys(layout).find((folder) => layout[folder]?.some((pane) => pane.id === paneId))
    if (!cwd || cwd === useCode.getState().cwd) return
    useAdeList.setState((s) => (s.done[cwd] ? s : { done: { ...s.done, [cwd]: true } }))
  })
  useCode.subscribe((state) => {
    const cwd = state.cwd
    if (cwd && useAdeList.getState().done[cwd]) {
      useAdeList.setState((s) => {
        const done = { ...s.done }
        delete done[cwd]
        return { done }
      })
    }
  })
}
