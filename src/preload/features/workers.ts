import { ipcRenderer } from 'electron'
import type {
  WorkerDelegation,
  WorkerExecution,
  WorkerExecutionEvent,
  RoomPost,
  RoomPostEvent,
  TeamDraftInput,
  Worker,
  WorkerDraft,
  WorkerMessageEvent,
  WorkerRoom,
  WorkerSendOptions,
  WorkerStreamEvent,
  WorkerThread,
  PurchaseRoutineDraft,
  WorkerRoutine
} from '@shared/workers'
import type { WorkerAppLink } from '@shared/workerApps'
import type { HouseholdList } from '@shared/workerLists'
import type { ConnectorId, ConnectorStatus, ConnectorStatuses } from '@shared/workerConnectors'
import type { VaultLogin, VaultLoginDraft, VaultState } from '@shared/workerVault'

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
  /** A thread's transcript: the main one, or another of the worker's threads. */
  thread: (id: string, threadId?: string): Promise<WorkerThread> => ipcRenderer.invoke('workers:thread', id, threadId),
  /** Creates (no `id`) or updates. Rejects with a user-facing message when invalid. */
  save: (draft: WorkerDraft): Promise<Worker> => ipcRenderer.invoke('workers:save', draft),
  /** Stops any running turn and forgets the worker; its folder stays on disk. */
  remove: (id: string): Promise<void> => ipcRenderer.invoke('workers:remove', id),
  /**
   * Mail from the user. Files are absolute paths, referenced as they are.
   * Colleagues the text @mentions by name get their own copy.
   */
  send: (id: string, text: string, files: string[] = [], options: WorkerSendOptions = {}): Promise<{ threadId: string }> =>
    ipcRenderer.invoke('workers:send', id, text, files, options),
  /** Empties a thread (the main one by default) and its summary; mail, wake-ups and settings stay. */
  clear: (id: string, threadId?: string): Promise<void> => ipcRenderer.invoke('workers:clear', id, threadId),
  /** The worker's run receipts, newest last. */
  executions: (id: string): Promise<WorkerExecution[]> => ipcRenderer.invoke('workers:executions', id),
  /** Runs a finished run's work again in the same thread. */
  retry: (id: string, executionId: string): Promise<void> => ipcRenderer.invoke('workers:retry', id, executionId),
  /** Open and recent delegations between workers. */
  delegations: (): Promise<WorkerDelegation[]> => ipcRenderer.invoke('workers:delegations'),
  /** Marks a side thread finished (or reopens it with `closed: false`). */
  closeThread: (id: string, threadId: string, closed = true): Promise<void> => ipcRenderer.invoke('workers:thread-close', id, threadId, closed),
  removeThread: (id: string, threadId: string): Promise<void> => ipcRenderer.invoke('workers:thread-remove', id, threadId),
  onExecution: (handler: (event: WorkerExecutionEvent) => void): (() => void) => subscribe('workers:execution', handler),
  onDelegations: (handler: (delegations: WorkerDelegation[]) => void): (() => void) => subscribe('workers:delegations', handler),
  setPaused: (id: string, paused: boolean): Promise<Worker> => ipcRenderer.invoke('workers:set-paused', id, paused),
  /** Edits what the worker remembers: its goal and its notes. Each is optional; an empty string clears it. */
  setMemory: (id: string, memory: { goal?: string; notes?: string }): Promise<string> => ipcRenderer.invoke('workers:set-memory', id, memory),
  /** Stops one of the worker's routines, by name. */
  removeRoutine: (id: string, name: string): Promise<string> => ipcRenderer.invoke('workers:remove-routine', id, name),
  removeRoutineById: (id: string, routineId: string): Promise<void> => ipcRenderer.invoke('workers:remove-routine-id', id, routineId),
  /** Pauses or resumes one routine (a paused one doesn't run; resumed, it carries on from its next slot). */
  setRoutinePaused: (id: string, routineId: string, paused: boolean): Promise<WorkerRoutine> => ipcRenderer.invoke('workers:set-routine-paused', id, routineId, paused),
  /** Cancels a wake-up the worker set for itself, in its main thread or a side thread. */
  stopWakeup: (id: string, threadId?: string): Promise<void> => ipcRenderer.invoke('workers:stop-wakeup', id, threadId),
  /** A routine's next run, now: a purchase schedule's "Buy now". */
  runRoutine: (id: string, routineId: string): Promise<void> => ipcRenderer.invoke('workers:run-routine', id, routineId),
  /** Saves a purchase schedule as one of the worker's routines (new, or replacing `draft.id`). */
  savePurchase: (id: string, draft: PurchaseRoutineDraft): Promise<WorkerRoutine> => ipcRenderer.invoke('workers:save-purchase', id, draft),
  /** Pause, resume or clear the goal set from the composer's Goal. */
  setGoal: (id: string, status: 'active' | 'paused' | null): Promise<void> => ipcRenderer.invoke('workers:set-goal', id, status),
  /** Runs a check-in turn as soon as the worker is free. */
  wake: (id: string): Promise<void> => ipcRenderer.invoke('workers:wake', id),
  /** Aborts one thread's running turn (the main one by default); the worker's other threads carry on. */
  stop: (id: string, threadId?: string): Promise<void> => ipcRenderer.invoke('workers:stop', id, threadId),
  markRead: (id: string, threadId?: string): Promise<void> => ipcRenderer.invoke('workers:mark-read', id, threadId),
  /** The worker whose page is on screen, or null once it isn't: that worker's own banners are held back only while it is. */
  viewing: (id: string | null): Promise<void> => ipcRenderer.invoke('workers:viewing', id),
  /** Brings a worker's own browser to the front (to watch, or to sign it in); false if it has not opened one yet. */
  showBrowser: (id: string): Promise<boolean> => ipcRenderer.invoke('workers:show-browser', id),
  hasBrowser: (id: string): Promise<boolean> => ipcRenderer.invoke('workers:has-browser', id),
  /** Answers a worker's question: a reply, or approving (or declining) the one action it asked about. */
  answer: (id: string, askId: string, answer: { text?: string; approved?: boolean }): Promise<void> =>
    ipcRenderer.invoke('workers:answer', id, askId, answer),
  /** Ends a background job the worker started; the worker is told. */
  stopJob: (id: string, jobId: string): Promise<string> => ipcRenderer.invoke('workers:stop-job', id, jobId),
  /** A job's state and the last 200 lines of its output. */
  jobLog: (id: string, jobId: string): Promise<string> => ipcRenderer.invoke('workers:job-log', id, jobId),
  removeWatch: (id: string, watchId: string): Promise<string> => ipcRenderer.invoke('workers:remove-watch', id, watchId),
  removePlaybook: (id: string, playbookId: string): Promise<string> => ipcRenderer.invoke('workers:remove-playbook', id, playbookId),
  /** Teach: hands the user the worker's browser and records what they do there. */
  teachStart: (id: string): Promise<boolean> => ipcRenderer.invoke('workers:teach-start', id),
  /** The steps recorded so far. */
  teachSteps: (id: string): Promise<string[]> => ipcRenderer.invoke('workers:teach-steps', id),
  /** Ends Teach: with a task, the steps go to the worker to save as a playbook; null cancels. Resolves to how many steps were sent. */
  teachStop: (id: string, task: string | null): Promise<number> => ipcRenderer.invoke('workers:teach-stop', id, task),
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
  onOpenRoom: (handler: (roomId: string) => void): (() => void) => subscribe('workers:open-room', handler),

  /* Linked apps (labs builds only; see shared/workerApps.ts). */
  linkApp: (id: string, appId: string, options: { url?: string } = {}): Promise<WorkerAppLink> => ipcRenderer.invoke('workers:link-app', id, appId, options),
  unlinkApp: (id: string, appId: string): Promise<void> => ipcRenderer.invoke('workers:unlink-app', id, appId),
  /** Types the user's login into the worker's browser on the app's sign-in page. The password goes no further than that page. */
  appSignIn: (id: string, appId: string, login: { username: string; password: string; remember?: boolean }, threadId?: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('workers:app-sign-in', id, appId, login, threadId),
  /** Opens the app's sign-in page in the worker's browser, for the user to sign in there themselves. */
  appBrowser: (id: string, appId: string): Promise<boolean> => ipcRenderer.invoke('workers:app-browser', id, appId),
  /** The user finished signing in by hand: the worker is told. */
  appSignedIn: (id: string, appId: string, threadId?: string): Promise<void> => ipcRenderer.invoke('workers:app-signed-in', id, appId, threadId),
  hueStatus: (): Promise<{ paired: { ip: string } | null }> => ipcRenderer.invoke('workers:hue-status'),
  /** Pairs with the Hue bridge (its button pressed in the last 30 s); the first one found unless `ip` names one. */
  huePair: (ip?: string): Promise<{ ip: string; lights: number }> => ipcRenderer.invoke('workers:hue-pair', ip),
  hueForget: (): Promise<void> => ipcRenderer.invoke('workers:hue-forget'),
  /** A device card's switch, straight to the light or plug (a Hue name, or a Home Assistant entity). */
  deviceSwitch: (control: { hue: string } | { entity: string }, on: boolean): Promise<boolean> => ipcRenderer.invoke('workers:device-switch', control, on),
  lists: (): Promise<HouseholdList[]> => ipcRenderer.invoke('workers:lists'),
  listToggle: (listId: string, itemId: string, done: boolean): Promise<void> => ipcRenderer.invoke('workers:list-toggle', listId, itemId, done),
  listAdd: (listId: string, text: string): Promise<HouseholdList> => ipcRenderer.invoke('workers:list-add', listId, text),
  onListsChanged: (handler: (lists: HouseholdList[]) => void): (() => void) => subscribe('workers:lists-changed', handler),
  /** Services connected for the apps (Home Assistant, Tessie, SimpleFIN, Instacart, Google Maps): whether each works. Never a key. */
  connections: (): Promise<ConnectorStatuses> => ipcRenderer.invoke('workers:connections'),
  /** Checks the key or token works, then keeps it. Rejects with what went wrong. */
  connect: (id: ConnectorId, fields: Record<string, string>): Promise<ConnectorStatus> => ipcRenderer.invoke('workers:connect', id, fields),
  disconnect: (id: ConnectorId): Promise<void> => ipcRenderer.invoke('workers:disconnect', id),
  onConnectionsChanged: (handler: (statuses: ConnectorStatuses) => void): (() => void) => subscribe('workers:connections-changed', handler),
  /* The workers' password vault: what is saved, never a password or a key. */
  vault: (): Promise<VaultState> => ipcRenderer.invoke('workers:vault'),
  /** Saves a login (the password goes to main once, and stays there). */
  vaultSave: (draft: VaultLoginDraft): Promise<VaultLogin> => ipcRenderer.invoke('workers:vault-save', draft),
  vaultRemove: (loginId: string): Promise<void> => ipcRenderer.invoke('workers:vault-remove', loginId),
  vaultAccess: (loginId: string, access: { workers?: 'all' | string[]; ask?: boolean }): Promise<void> => ipcRenderer.invoke('workers:vault-access', loginId, access),
  vaultRemovePasskey: (passkeyId: string): Promise<void> => ipcRenderer.invoke('workers:vault-remove-passkey', passkeyId),
  /** Picks an export from Apple's Passwords app and imports it; null when cancelled. */
  vaultImportApple: (workers: 'all' | string[]): Promise<{ added: number; updated: number; skipped: number; file: string } | null> => ipcRenderer.invoke('workers:vault-import-apple', workers),
  /** Moves the imported export file (unencrypted) to the Trash. */
  vaultTrashImport: (): Promise<boolean> => ipcRenderer.invoke('workers:vault-trash-import'),
  /** Opens Passwords and waits for its export, which is imported and trashed the moment it's saved (onVaultImportFound). */
  vaultImportWatch: (workers: 'all' | string[]): Promise<{ folders: string[] }> => ipcRenderer.invoke('workers:vault-import-watch', workers),
  vaultImportStop: (): Promise<void> => ipcRenderer.invoke('workers:vault-import-stop'),
  onVaultImportFound: (listener: (result: { added: number; updated: number; skipped: number; file: string; trashed: boolean } | { error: string }) => void): (() => void) => {
    const handler = (_e: unknown, result: Parameters<typeof listener>[0]): void => listener(result)
    ipcRenderer.on('workers:vault-import-found', handler)
    return () => void ipcRenderer.removeListener('workers:vault-import-found', handler)
  },
  onVaultChanged: (handler: (state: VaultState) => void): (() => void) => subscribe('workers:vault-changed', handler)
}
