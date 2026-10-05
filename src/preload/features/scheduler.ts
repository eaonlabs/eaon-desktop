import { ipcRenderer } from 'electron'
import type { ScheduledTask, TaskDraft, TaskRun } from '@shared/scheduler'
import type { Chat } from '@shared/types'

/**
 * Renderer bridge for the scheduler feature. Exposed as `window.api.scheduler`.
 * Keep every channel this feature uses in this one file.
 */

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const schedulerApi = {
  list: (): Promise<ScheduledTask[]> => ipcRenderer.invoke('scheduler:list'),
  /** Creates, or updates when `draft.id` is set. Rejects with a user-facing message when invalid. */
  save: (draft: TaskDraft): Promise<ScheduledTask> => ipcRenderer.invoke('scheduler:save', draft),
  remove: (id: string): Promise<void> => ipcRenderer.invoke('scheduler:remove', id),
  setEnabled: (id: string, enabled: boolean): Promise<ScheduledTask> => ipcRenderer.invoke('scheduler:set-enabled', id, enabled),
  runNow: (id: string): Promise<TaskRun> => ipcRenderer.invoke('scheduler:run-now', id),
  /** Runs the task again for a run that failed, was stopped, missed or skipped. */
  retry: (id: string, runId: string): Promise<TaskRun> => ipcRenderer.invoke('scheduler:retry', id, runId),
  cancel: (id: string): Promise<void> => ipcRenderer.invoke('scheduler:cancel', id),
  /** One-time import of tasks the old page kept in localStorage. Resolves to how many were imported. */
  importLegacy: (drafts: TaskDraft[]): Promise<number> => ipcRenderer.invoke('scheduler:import', drafts),
  /** Raises the window and opens a chat — what a notification click does. */
  openChat: (chatId: string): Promise<void> => ipcRenderer.invoke('scheduler:open-chat', chatId),
  /**
   * Tells main this renderer's listeners are bound, so run chats can be sent
   * here instead of written to chats.json. Retried because feature handlers
   * register after the window is created, and a fast renderer can get here
   * first — an unanswered "ready" would leave main writing chats.json under a
   * live renderer.
   */
  ready: async (): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await ipcRenderer.invoke('scheduler:ready')
      } catch (error) {
        if (attempt >= 40) throw error
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  },
  onTasks: (handler: (tasks: ScheduledTask[]) => void): (() => void) => subscribe('scheduler:tasks', handler),
  /** A run's chat, whole: insert it, or merge it into the copy already loaded. */
  onChat: (handler: (chat: Chat) => void): (() => void) => subscribe('scheduler:chat', handler),
  onOpenChat: (handler: (chatId: string) => void): (() => void) => subscribe('scheduler:open-chat', handler)
}
