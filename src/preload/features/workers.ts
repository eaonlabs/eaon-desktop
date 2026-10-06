import { ipcRenderer } from 'electron'
import type {
  RoomPost,
  RoomPostEvent,
  TeamDraftInput,
  Worker,
  WorkerDraft,
  WorkerMessageEvent,
  WorkerRoom,
  WorkerSendOptions,
  WorkerStreamEvent,
  WorkerThread
} from '@shared/workers'

/**
 * Renderer bridge for Eaon Workers. Exposed as `window.api.workers`. Main owns
 * workers; the renderer reads them, sends commands, and follows along through
 * the three push channels. Keep every channel this feature uses in this file.
 */

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const workersApi = {
  list: (): Promise<Worker[]> => ipcRenderer.invoke('workers:list'),
  thread: (id: string): Promise<WorkerThread> => ipcRenderer.invoke('workers:thread', id),
  /** Creates (no `id`) or updates. Rejects with a user-facing message when invalid. */
  save: (draft: WorkerDraft): Promise<Worker> => ipcRenderer.invoke('workers:save', draft),
  /** Stops any running turn and forgets the worker; its folder stays on disk. */
  remove: (id: string): Promise<void> => ipcRenderer.invoke('workers:remove', id),
  /**
   * Mail from the user. Files are absolute paths, referenced as they are.
   * Colleagues the text @mentions by name get their own copy.
   */
  send: (id: string, text: string, files: string[] = [], options: WorkerSendOptions = {}): Promise<void> =>
    ipcRenderer.invoke('workers:send', id, text, files, options),
  /** Empties the thread and its summary; mail, heartbeat and settings stay. */
  clear: (id: string): Promise<void> => ipcRenderer.invoke('workers:clear', id),
  setPaused: (id: string, paused: boolean): Promise<Worker> => ipcRenderer.invoke('workers:set-paused', id, paused),
  /** Pause, resume or clear the goal set from the composer's Goal. */
  setGoal: (id: string, status: 'active' | 'paused' | null): Promise<void> => ipcRenderer.invoke('workers:set-goal', id, status),
  /** Runs a check-in turn as soon as the worker is free. */
  wake: (id: string): Promise<void> => ipcRenderer.invoke('workers:wake', id),
  /** Aborts the running turn only. */
  stop: (id: string): Promise<void> => ipcRenderer.invoke('workers:stop', id),
  markRead: (id: string): Promise<void> => ipcRenderer.invoke('workers:mark-read', id),
  /** Brings a worker's own browser to the front (to watch, or to sign it in); false if it has not opened one yet. */
  showBrowser: (id: string): Promise<boolean> => ipcRenderer.invoke('workers:show-browser', id),
  hasBrowser: (id: string): Promise<boolean> => ipcRenderer.invoke('workers:has-browser', id),
  /** Answers a worker's question: a reply, or approving (or declining) the one action it asked about. */
  answer: (id: string, askId: string, answer: { text?: string; approved?: boolean }): Promise<void> =>
    ipcRenderer.invoke('workers:answer', id, askId, answer),
  /** The whole list, whenever anything but a token changes. */
  onChanged: (handler: (workers: Worker[]) => void): (() => void) => subscribe('workers:changed', handler),
  /** Stream events from running turns, batched per frame. */
  onEvent: (handler: (event: WorkerStreamEvent) => void): (() => void) => subscribe('workers:event', handler),
  /** A thread message added or replaced whole (turn start, turn end). */
  onMessage: (handler: (event: WorkerMessageEvent) => void): (() => void) => subscribe('workers:message', handler),
  /** A worker notification was clicked: show that worker. */
  onOpen: (handler: (workerId: string) => void): (() => void) => subscribe('workers:open', handler),

  /* Group chats: the user and several workers in one conversation. */
  rooms: (): Promise<WorkerRoom[]> => ipcRenderer.invoke('workers:rooms'),
  roomPosts: (roomId: string): Promise<RoomPost[]> => ipcRenderer.invoke('workers:room-posts', roomId),
  saveRoom: (draft: { id?: string; name: string; members: string[] }): Promise<WorkerRoom> => ipcRenderer.invoke('workers:room-save', draft),
  removeRoom: (roomId: string): Promise<void> => ipcRenderer.invoke('workers:room-remove', roomId),
  /** Posts as the user; members (or only those @mentioned) hear it. */
  postToRoom: (roomId: string, text: string, files: string[] = []): Promise<RoomPost> => ipcRenderer.invoke('workers:room-post', roomId, text, files),
  markRoomRead: (roomId: string): Promise<void> => ipcRenderer.invoke('workers:room-read', roomId),
  /** Creates the specialists and their group chat, and posts the kickoff. */
  createTeam: (draft: TeamDraftInput): Promise<{ room: WorkerRoom; workers: Worker[] }> => ipcRenderer.invoke('workers:create-team', draft),
  onRoomsChanged: (handler: (rooms: WorkerRoom[]) => void): (() => void) => subscribe('workers:rooms-changed', handler),
  onRoomPost: (handler: (event: RoomPostEvent) => void): (() => void) => subscribe('workers:room-post', handler),
  /** The chat agent started a team: show its group chat. */
  onOpenRoom: (handler: (roomId: string) => void): (() => void) => subscribe('workers:open-room', handler)
}
