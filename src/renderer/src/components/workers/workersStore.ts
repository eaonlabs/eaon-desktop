import { create } from 'zustand'
import type { ChatMessage, ChatToolPart, StreamEvent } from '@shared/types'
import type { Worker, WorkerDraft, WorkerSendOptions, WorkerThread } from '@shared/workers'

/**
 * The Workers tab's state. Workers live in the main process, which runs them
 * whether or not a window is open; this store mirrors the list, keeps the
 * threads the user has opened up to date from the stream, and forwards
 * commands. Its own store rather than more fields on `useApp`, so a worker's
 * tokens re-render only the Workers views.
 */
interface WorkersState {
  ready: boolean
  workers: Worker[]
  /** The worker open in the Workers tab; null shows the team. */
  selectedId: string | null
  /** Threads loaded so far, by worker id. */
  threads: Record<string, WorkerThread>
  /** The create/edit dialog: closed, creating (`null`), or editing a worker. */
  editing: { workerId: string | null } | null
  /** Ticks every 20 s so relative times and moods that expire stay current. */
  now: number

  init: () => Promise<void>
  select: (id: string | null) => void
  openEditor: (workerId?: string | null) => void
  closeEditor: () => void
  save: (draft: WorkerDraft) => Promise<Worker>
  remove: (id: string) => Promise<void>
  send: (id: string, text: string, files?: string[], options?: WorkerSendOptions) => Promise<void>
  clear: (id: string) => Promise<void>
  setPaused: (id: string, paused: boolean) => Promise<void>
  wake: (id: string) => Promise<void>
  stop: (id: string) => Promise<void>
  loadThread: (id: string) => Promise<void>
  markRead: (id: string) => void
}

let bound = false

export const useWorkers = create<WorkersState>((set, get) => ({
  ready: false,
  workers: [],
  selectedId: null,
  threads: {},
  editing: null,
  now: Date.now(),

  async init() {
    if (bound) return
    bound = true
    const api = window.api.workers
    api.onChanged((workers) => {
      set((s) => ({
        workers,
        // A worker removed elsewhere (or by a colleague's hand) closes its page.
        ...(s.selectedId && !workers.some((w) => w.id === s.selectedId) ? { selectedId: null } : {})
      }))
    })
    api.onMessage(({ workerId, message }) => {
      set((s) => {
        const thread = s.threads[workerId]
        if (!thread) return {}
        const index = lastIndexOf(thread.messages, message.id)
        const messages = thread.messages.slice()
        if (index === -1) messages.push(message)
        else messages[index] = message
        return { threads: { ...s.threads, [workerId]: { ...thread, messages } } }
      })
    })
    api.onEvent(({ workerId, event }) => {
      set((s) => {
        const thread = s.threads[workerId]
        if (!thread) return {}
        if (event.type === 'compacted') {
          return { threads: { ...s.threads, [workerId]: { ...thread, summary: { text: event.summary, throughMessageId: event.throughMessageId } } } }
        }
        const index = lastIndexOf(thread.messages, event.messageId)
        if (index === -1) return {}
        const next = applyEvent(thread.messages[index], event)
        if (next === thread.messages[index]) return {}
        const messages = thread.messages.slice()
        messages[index] = next
        return { threads: { ...s.threads, [workerId]: { ...thread, messages } } }
      })
    })
    api.onOpen((workerId) => {
      set({ selectedId: workerId })
      void import('../../state/store').then(({ useApp }) => {
        const app = useApp.getState()
        const tab = app.workspaces.find((w) => w.kind === 'workers')
        if (tab && app.settings?.activeWorkspaceId !== tab.id) app.setWorkspace(tab.id)
        if (app.view !== 'chat') app.setView('chat')
      })
    })
    setInterval(() => set({ now: Date.now() }), 20_000)
    const workers = await api.list()
    set({ workers, ready: true })
  },

  select(id) {
    set({ selectedId: id })
    if (id) void get().loadThread(id)
  },
  openEditor(workerId = null) {
    set({ editing: { workerId } })
  },
  closeEditor() {
    set({ editing: null })
  },

  async save(draft) {
    const worker = await window.api.workers.save(draft)
    // The change event carries it too; merging here means the caller can
    // select it straight away without waiting for the round trip.
    set((s) => ({
      workers: s.workers.some((w) => w.id === worker.id) ? s.workers.map((w) => (w.id === worker.id ? worker : w)) : [...s.workers, worker]
    }))
    return worker
  },
  async remove(id) {
    await window.api.workers.remove(id)
    set((s) => {
      const threads = { ...s.threads }
      delete threads[id]
      return { workers: s.workers.filter((w) => w.id !== id), threads, selectedId: s.selectedId === id ? null : s.selectedId }
    })
  },
  async send(id, text, files = [], options = {}) {
    await window.api.workers.send(id, text, files, options)
  },
  async clear(id) {
    await window.api.workers.clear(id)
    set((s) => (s.threads[id] ? { threads: { ...s.threads, [id]: { ...s.threads[id], messages: [], summary: null } } } : {}))
  },
  async setPaused(id, paused) {
    await window.api.workers.setPaused(id, paused)
  },
  async wake(id) {
    await window.api.workers.wake(id)
  },
  async stop(id) {
    await window.api.workers.stop(id)
  },
  async loadThread(id) {
    const thread = await window.api.workers.thread(id)
    set((s) => ({ threads: { ...s.threads, [id]: thread } }))
  },
  markRead(id) {
    const worker = get().workers.find((w) => w.id === id)
    if (!worker || worker.unread === 0) return
    set((s) => ({ workers: s.workers.map((w) => (w.id === id ? { ...w, unread: 0 } : w)) }))
    void window.api.workers.markRead(id)
  }
}))

function lastIndexOf(messages: ChatMessage[], id: string): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].id === id) return i
  return -1
}

/**
 * One stream event applied to its message, immutably — the same reduction the
 * chat store and the main process's transcript do, returning the message
 * unchanged when the event does not touch it.
 */
function applyEvent(message: ChatMessage, event: StreamEvent): ChatMessage {
  switch (event.type) {
    case 'delta':
    case 'reasoning': {
      const type = event.type === 'delta' ? 'text' : 'reasoning'
      const parts = message.parts.slice()
      const last = parts[parts.length - 1]
      if (last && last.type !== 'tool' && last.type === type) parts[parts.length - 1] = { ...last, text: last.text + event.text }
      else parts.push({ type, text: event.text })
      return { ...message, parts }
    }
    case 'error':
      return { ...message, error: event.error }
    case 'usage':
      return { ...message, usage: event.usage }
    case 'todos':
      return { ...message, todos: event.todos }
    case 'tool-call':
      return {
        ...message,
        parts: [...message.parts, { type: 'tool', id: event.toolId, name: event.name, input: event.input, output: null, status: 'running' }]
      }
    case 'tool-progress':
    case 'subagent':
    case 'tool-result': {
      const index = message.parts.findIndex((p) => p.type === 'tool' && p.id === event.toolId)
      if (index === -1) return message
      const part = message.parts[index] as ChatToolPart
      const parts = message.parts.slice()
      if (event.type === 'tool-progress') parts[index] = { ...part, progress: event.output }
      else if (event.type === 'subagent') {
        const agents = (part.agents ?? []).slice()
        agents[event.run.index] = event.run
        parts[index] = { ...part, agents }
      } else {
        parts[index] = { ...part, output: event.output, status: event.status, progress: undefined, ...(event.images ? { images: event.images } : {}) }
      }
      return { ...message, parts }
    }
    default:
      return message
  }
}
