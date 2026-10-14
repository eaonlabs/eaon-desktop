import { create } from 'zustand'
import type { ReviewComment } from '@shared/adeReview'

/**
 * The review panel's state: whether it is open, and the comments not yet sent
 * to an agent, per session folder. The comments are kept in localStorage, so a
 * reload or a restart doesn't throw away a review half written; they leave
 * only when they are sent or cleared.
 */

interface ReviewStore {
  open: boolean
  toggle: () => void
  close: () => void
  /** Comments not yet sent, per session folder. */
  comments: Record<string, ReviewComment[]>
  addComment: (cwd: string, comment: ReviewComment) => void
  updateComment: (cwd: string, id: string, patch: Partial<Omit<ReviewComment, 'id' | 'path' | 'side'>>) => void
  removeComment: (cwd: string, id: string) => void
  /** Takes these comments away (all of the folder's when no ids are given). */
  clearComments: (cwd: string, ids?: string[]) => void
}

const KEY = 'eaon.ade.reviewComments'

/** A saved comment as this version reads it: one from an older version (no `endLine`) still is one. */
function isComment(value: unknown): value is ReviewComment {
  const c = value as Partial<ReviewComment> | null
  return Boolean(
    c &&
      typeof c.id === 'string' &&
      typeof c.path === 'string' &&
      typeof c.line === 'number' &&
      (c.endLine === undefined || typeof c.endLine === 'number') &&
      (c.side === 'new' || c.side === 'old') &&
      typeof c.quote === 'string' &&
      typeof c.body === 'string'
  )
}

function readComments(): Record<string, ReviewComment[]> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    if (!value || typeof value !== 'object') return {}
    const out: Record<string, ReviewComment[]> = {}
    for (const [cwd, list] of Object.entries(value as Record<string, unknown>)) {
      const valid = Array.isArray(list) ? list.filter(isComment) : []
      if (valid.length) out[cwd] = valid
    }
    return out
  } catch {
    return {}
  }
}

function saveComments(all: Record<string, ReviewComment[]>): void {
  try {
    const kept = Object.fromEntries(Object.entries(all).filter(([, list]) => list.length > 0))
    localStorage.setItem(KEY, JSON.stringify(kept))
  } catch {
    /* comments are remembered where storage allows; the panel works without */
  }
}

export const useReview = create<ReviewStore>((set, get) => {
  const change = (cwd: string, edit: (list: ReviewComment[]) => ReviewComment[]): void => {
    const comments = { ...get().comments, [cwd]: edit(get().comments[cwd] ?? []) }
    set({ comments })
    saveComments(comments)
  }
  return {
    open: false,
    toggle: () => set((s) => ({ open: !s.open })),
    close: () => set({ open: false }),
    comments: readComments(),
    addComment: (cwd, comment) => change(cwd, (list) => [...list, comment]),
    updateComment: (cwd, id, patch) => change(cwd, (list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c))),
    removeComment: (cwd, id) => change(cwd, (list) => list.filter((c) => c.id !== id)),
    clearComments: (cwd, ids) => change(cwd, (list) => (ids ? list.filter((c) => !ids.includes(c.id)) : []))
  }
})

// Another window's comments, as it saves them: the same folder's review open in two windows stays one review.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) useReview.setState({ comments: readComments() })
  })
}
