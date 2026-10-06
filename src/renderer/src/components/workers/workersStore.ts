import { create } from 'zustand'
import type { ChatMessage, ChatToolPart, StreamEvent } from '@shared/types'
import type { RoomPost, TeamDraftInput, Worker, WorkerDraft, WorkerRoom, WorkerSendOptions, WorkerThread } from '@shared/workers'

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
  /** Group chats, and the posts of the ones opened so far. */
  rooms: WorkerRoom[]
  roomPosts: Record<string, RoomPost[]>
  /** The group chat open in the Workers tab; a worker page and a room are never open at once. */
  selectedRoomId: string | null
  /** The group chat dialog: closed, creating (`null`), or editing a room. */
  roomEditor: { roomId: string | null } | null
  teamDialog: boolean
  /** The worker whose browser is open beside its page; null when none. */
  browserFor: string | null
  /** Workers whose browser panel the user closed: it won't pop open for them again this session. */
  browserDismissed: Set<string>

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
  selectRoom: (id: string | null) => void
  openRoomEditor: (roomId?: string | null) => void
  closeRoomEditor: () => void
  saveRoom: (draft: { id?: string; name: string; members: string[] }) => Promise<WorkerRoom>
  removeRoom: (id: string) => Promise<void>
  postToRoom: (id: string, text: string, files?: string[]) => Promise<void>
  openTeamDialog: (open: boolean) => void
  /** Opens a worker's browser beside its page, or closes it (`null`; `dismiss` keeps it from popping open again). */
  setBrowser: (workerId: string | null, dismiss?: string) => void
  createTeam: (draft: TeamDraftInput) => Promise<WorkerRoom>
}

let bound = false

export const useWorkers = create<WorkersState>((set, get) => ({
  ready: false,
  workers: [],
  selectedId: null,
  threads: {},
  editing: null,
  now: Date.now(),
  rooms: [],
  roomPosts: {},
  selectedRoomId: null,
  roomEditor: null,
  teamDialog: false,
  browserFor: null,
  browserDismissed: new Set(),

  async init() {
    if (bound) return
    bound = true
    const api = window.api.workers
    // A change pushed while the first list is still on its way is newer than that list.
    let pushedWorkers = false
    let pushedRooms = false
    api.onChanged((workers) => {
      pushedWorkers = true
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
    api.onRoomsChanged((rooms) => {
      pushedRooms = true
      set((s) => ({ rooms, ...(s.selectedRoomId && !rooms.some((r) => r.id === s.selectedRoomId) ? { selectedRoomId: null } : {}) }))
    })
    api.onRoomPost(({ roomId, post }) => {
      set((s) => {
        const posts = s.roomPosts[roomId]
        if (!posts || posts.some((p) => p.id === post.id)) return {}
        return { roomPosts: { ...s.roomPosts, [roomId]: [...posts, post] } }
      })
    })
    api.onOpenRoom((roomId) => {
      get().selectRoom(roomId)
      void import('../../state/store').then(({ useApp }) => {
        const app = useApp.getState()
        const tab = app.workspaces.find((w) => w.kind === 'workers')
        if (tab && app.settings?.activeWorkspaceId !== tab.id) app.setWorkspace(tab.id)
        if (app.view !== 'chat') app.setView('chat')
      })
    })
    // The browser panel opens by itself when the worker on screen starts using
    // its browser, as Chat's does — unless the user closed it for that worker.
    window.api.agentBrowser.onStep((step) => {
      const match = /^worker:(.+)$/.exec(step.target)
      if (!match || step.done) return
      const state = get()
      if (state.selectedId === match[1] && state.browserFor !== match[1] && !state.browserDismissed.has(match[1])) set({ browserFor: match[1] })
    })
    setInterval(() => set({ now: Date.now() }), 20_000)
    const [workers, rooms] = await Promise.all([api.list(), api.rooms()])
    set({ ...(pushedWorkers ? {} : { workers }), ...(pushedRooms ? {} : { rooms }), ready: true })
  },

  select(id) {
    set({ selectedId: id, ...(id ? { selectedRoomId: null } : {}) })
    if (id) void get().loadThread(id)
  },
  selectRoom(id) {
    set({ selectedRoomId: id, ...(id ? { selectedId: null } : {}) })
    if (!id) return
    void window.api.workers.roomPosts(id).then((posts) => set((s) => ({ roomPosts: { ...s.roomPosts, [id]: posts } })))
    void window.api.workers.markRoomRead(id)
  },
  openRoomEditor(roomId = null) {
    set({ roomEditor: { roomId } })
  },
  closeRoomEditor() {
    set({ roomEditor: null })
  },
  async saveRoom(draft) {
    const room = await window.api.workers.saveRoom(draft)
    set((s) => ({ rooms: s.rooms.some((r) => r.id === room.id) ? s.rooms.map((r) => (r.id === room.id ? room : r)) : [...s.rooms, room] }))
    return room
  },
  async removeRoom(id) {
    await window.api.workers.removeRoom(id)
    set((s) => ({ rooms: s.rooms.filter((r) => r.id !== id), selectedRoomId: s.selectedRoomId === id ? null : s.selectedRoomId }))
  },
  async postToRoom(id, text, files = []) {
    await window.api.workers.postToRoom(id, text, files)
  },
  openTeamDialog(open) {
    set({ teamDialog: open })
  },
  setBrowser(workerId, dismiss) {
    set((s) => ({
      browserFor: workerId,
      ...(dismiss ? { browserDismissed: new Set([...s.browserDismissed, dismiss]) } : {}),
      // Opening it on purpose lets it pop open again later.
      ...(workerId && s.browserDismissed.has(workerId) ? { browserDismissed: new Set([...s.browserDismissed].filter((id) => id !== workerId)) } : {})
    }))
  },
  async createTeam(draft) {
    const { room, workers } = await window.api.workers.createTeam(draft)
    set((s) => ({
      workers: [...s.workers, ...workers.filter((w) => !s.workers.some((x) => x.id === w.id))],
      rooms: s.rooms.some((r) => r.id === room.id) ? s.rooms : [...s.rooms, room]
    }))
    return room
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
