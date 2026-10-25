import { create } from 'zustand'
import type { Chat, Project } from '@shared/types'

/**
 * How Chat's sidebar lists its two sections, Projects and Chats: the order
 * each is in, which projects are open to their chats, and whether Chats is
 * folded away. Remembered on this computer, as the ADE's folded projects are.
 */

export type ProjectSort = 'recent' | 'created' | 'name'
export type ChatSort = 'recent' | 'created'

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
  projectSort: ProjectSort
  chatSort: ChatSort
  /** Projects showing their chats, by id. */
  open: Record<string, boolean>
  chatsFolded: boolean
  setProjectSort: (sort: ProjectSort) => void
  setChatSort: (sort: ChatSort) => void
  setProjectOpen: (id: string, open: boolean) => void
  collapseProjects: () => void
  setChatsFolded: (folded: boolean) => void
}

const KEY = 'eaon.chatSidebar'
type Saved = Pick<ChatSidebarState, 'projectSort' | 'chatSort' | 'open' | 'chatsFolded'>
const DEFAULTS: Saved = { projectSort: 'recent', chatSort: 'recent', open: {}, chatsFolded: false }

function read(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>
    return {
      projectSort: saved.projectSort && saved.projectSort in PROJECT_SORTS ? saved.projectSort : DEFAULTS.projectSort,
      chatSort: saved.chatSort && saved.chatSort in CHAT_SORTS ? saved.chatSort : DEFAULTS.chatSort,
      open: saved.open && typeof saved.open === 'object' ? saved.open : {},
      chatsFolded: saved.chatsFolded === true
    }
  } catch {
    return DEFAULTS
  }
}

export const useChatSidebar = create<ChatSidebarState>((set, get) => {
  const save = (patch: Partial<Saved>): void => {
    set(patch)
    const { projectSort, chatSort, open, chatsFolded } = get()
    try {
      localStorage.setItem(KEY, JSON.stringify({ projectSort, chatSort, open, chatsFolded }))
    } catch {
      /* Remembered until the app closes. */
    }
  }
  return {
    ...read(),
    setProjectSort: (projectSort) => save({ projectSort }),
    setChatSort: (chatSort) => save({ chatSort }),
    setProjectOpen: (id, open) => {
      if (Boolean(get().open[id]) === open) return
      const next = { ...get().open }
      if (open) next[id] = true
      else delete next[id]
      save({ open: next })
    },
    collapseProjects: () => save({ open: {} }),
    setChatsFolded: (chatsFolded) => save({ chatsFolded })
  }
})
