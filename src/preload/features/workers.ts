import { ipcRenderer } from 'electron'
import type { Worker, WorkerDraft, WorkerMessageEvent, WorkerStreamEvent, WorkerThread } from '@shared/workers'

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
  /** Mail from the user. Files are absolute paths, referenced as they are. */
  send: (id: string, text: string, files: string[] = []): Promise<void> => ipcRenderer.invoke('workers:send', id, text, files),
  /** Empties the thread and its summary; mail, heartbeat and settings stay. */
  clear: (id: string): Promise<void> => ipcRenderer.invoke('workers:clear', id),
  setPaused: (id: string, paused: boolean): Promise<Worker> => ipcRenderer.invoke('workers:set-paused', id, paused),
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
  onOpen: (handler: (workerId: string) => void): (() => void) => subscribe('workers:open', handler)
}
