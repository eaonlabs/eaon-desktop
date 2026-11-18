import { create } from 'zustand'
import type { Chat, Project } from '@shared/types'

/**
 * How Chat's sidebar lists its two sections, Projects and Chats: the order
 * each is in, which projects are open to their chats, and whether Chats is
 * folded away. Remembered on this computer, as the ADE's folded projects are.
 */

export type ProjectSort = 'recent' | 'created' | 'name'
export type ChatSort = 'recent' | 'created'
/** Projects, each a heading that folds over its chats (as T3 Code lists threads), or the chats in projects as one list, each tagged with its project; Chats under either. */
export type ChatView = 'list' | 'projects'

export const PROJECT_SORTS: Record<ProjectSort, string> = { recent: 'Recent activity', created: 'Date created', name: 'Name' }
export const CHAT_SORTS: Record<ChatSort, string> = { recent: 'Recent activity', created: 'Date created' }

/** Projects in `sort` order, newest first. A project's activity is its latest chat's, or when it was made while it has none. */
export function sortProjects(projects: Project[], chats: Pick<Chat, 'projectId' | 'updatedAt' | 'archived'>[], sort: ProjectSort): Project[] {
  if (sort === 'name') return [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  if (sort === 'created') return [...projects].sort((a, b) => b.createdAt - a.createdAt)
  const latest = new Map<string, number>()
  for (const chat of chats) {
    if (chat.projectId && !chat.archived) latest.set(chat.projectId, Math.max(latest.get(chat.projectId) ?? 0, chat.updatedAt))
  }
  const active = (project: Project): number => Math.max(latest.get(project.id) ?? 0, project.createdAt)
  return [...projects].sort((a, b) => active(b) - active(a))
}

/** Chats in `sort` order, pinned ones first either way. `items` arrive most recently active first, so that order is theirs already. */
export function sortChats<T extends { id: string; pinned: boolean }>(items: T[], sort: ChatSort, createdAt: Record<string, number>): T[] {
  if (sort === 'recent') return items
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (createdAt[b.id] ?? 0) - (createdAt[a.id] ?? 0))
}

interface ChatSidebarState {
  view: ChatView
  projectSort: ProjectSort
  chatSort: ChatSort
  /** What the search row holds; not remembered. */
  query: string
  /** The Working section under the list is open. */
  workingOpen: boolean
  /** Projects folded to their heading, by id; the rest show their chats. */
  folded: Record<string, true>
  chatsFolded: boolean
  setView: (view: ChatView) => void
  setQuery: (query: string) => void
  setWorkingOpen: (open: boolean) => void
  setProjectSort: (sort: ProjectSort) => void
  setChatSort: (sort: ChatSort) => void
  setProjectOpen: (id: string, open: boolean) => void
  collapseProjects: (ids: readonly string[]) => void
  setChatsFolded: (folded: boolean) => void
}

const KEY = 'eaon.chatSidebar'

/**
 * This sidebar has never been shown on this computer: a fresh install, or an
 * update from 2026.6, whose chats went into the project made from Chat's old
 * folder (store.ts projectForChatFolder). Read once, before anything is saved.
 */
export const SIDEBAR_IS_NEW = ((): boolean => {
  try {
    return localStorage.getItem(KEY) === null
  } catch {
    return false
  }
})()
type Saved = Pick<ChatSidebarState, 'view' | 'projectSort' | 'chatSort' | 'folded' | 'chatsFolded' | 'workingOpen'>
const DEFAULTS: Saved = { view: 'projects', projectSort: 'recent', chatSort: 'recent', folded: {}, chatsFolded: false, workingOpen: true }
/** Saved views from before "By project" was the default are its builds' default, not a choice: only this version's is read. */
const VIEW_VERSION = 2

function read(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved> & { v?: number }
    return {
      view: saved.v === VIEW_VERSION && saved.view === 'list' ? 'list' : 'projects',
      projectSort: saved.projectSort && saved.projectSort in PROJECT_SORTS ? saved.projectSort : DEFAULTS.projectSort,
      chatSort: saved.chatSort && saved.chatSort in CHAT_SORTS ? saved.chatSort : DEFAULTS.chatSort,
      folded: saved.folded && typeof saved.folded === 'object' ? saved.folded : {},
      chatsFolded: saved.chatsFolded === true,
      workingOpen: saved.workingOpen !== false
    }
  } catch {
    return DEFAULTS
  }
}

export const useChatSidebar = create<ChatSidebarState>((set, get) => {
  const save = (patch: Partial<Saved>): void => {
    set(patch)
    const { view, projectSort, chatSort, folded, chatsFolded, workingOpen } = get()
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: VIEW_VERSION, view, projectSort, chatSort, folded, chatsFolded, workingOpen }))
    } catch {
      /* Remembered until the app closes. */
    }
  }
  return {
    ...read(),
    query: '',
    setView: (view) => save({ view }),
    setQuery: (query) => set({ query }),
    setWorkingOpen: (workingOpen) => save({ workingOpen }),
    setProjectSort: (projectSort) => save({ projectSort }),
    setChatSort: (chatSort) => save({ chatSort }),
    setProjectOpen: (id, open) => {
      if (!get().folded[id] === open) return
      const next = { ...get().folded }
      if (open) delete next[id]
      else next[id] = true
      save({ folded: next })
    },
    collapseProjects: (ids) => save({ folded: { ...get().folded, ...Object.fromEntries(ids.map((id) => [id, true as const])) } }),
    setChatsFolded: (chatsFolded) => save({ chatsFolded })
  }
})
