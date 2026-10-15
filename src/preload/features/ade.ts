import { ipcRenderer } from 'electron'
import type {
  AdeChanges,
  AdeConversation,
  AdeImportCandidate,
  AdeSession,
  NewSessionRequest,
  NewSessionResult,
  RemoveSessionOptions
} from '@shared/adeSessions'
import type { ManualHostInput, NewRemoteSessionRequest, NewRemoteSessionResult, SshHost } from '@shared/adeRemote'
import type { ReviewAction, ReviewCheck, ReviewFileText, ReviewLog, ReviewResult } from '@shared/adeReview'

/** Renderer bridge for the ADE's sessions. Exposed as `window.api.ade`. */
export const adeApi = {
  /** Every session, with each folder's branch looked at again. */
  sessions: (): Promise<AdeSession[]> => ipcRenderer.invoke('ade:sessions'),
  /** A new session on a branch of its own, in a new worktree of the project. */
  create: (req: NewSessionRequest): Promise<NewSessionResult> => ipcRenderer.invoke('ade:create', req),
  remove: (id: string, options: RemoveSessionOptions): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('ade:remove', id, options),
  rename: (id: string, title: string): Promise<AdeSession | null> => ipcRenderer.invoke('ade:rename', id, title),
  /** Makes a session the one the ADE shows (and reopens at launch); returns the recent projects. */
  open: (id: string): Promise<string[]> => ipcRenderer.invoke('ade:open', id),
  /** A folder's own session, made when it has none, opened. */
  openFolder: (folder: string): Promise<{ session: AdeSession; recents: string[] }> => ipcRenderer.invoke('ade:open-folder', folder),
  /** The Claude Code and Codex conversations that ran in a folder, newest first. */
  conversations: (cwd: string): Promise<AdeConversation[]> => ipcRenderer.invoke('ade:conversations', cwd),
  /** What is uncommitted in a session's folder: lines added and removed, files touched; null outside git. */
  changes: (cwd: string): Promise<AdeChanges | null> => ipcRenderer.invoke('ade:changes', cwd),
  /** Every folder with Claude Code or Codex conversations on this computer (nothing is imported yet). */
  importScan: (): Promise<AdeImportCandidate[]> => ipcRenderer.invoke('ade:import-scan'),
  /** Sessions for the chosen folders; returns the ones made. */
  import: (folders: { cwd: string; at: number }[]): Promise<AdeSession[]> => ipcRenderer.invoke('ade:import', folders),
  /** SSH hosts a session can be on: ~/.ssh/config's, then the ones added in Eaon. */
  hosts: (): Promise<SshHost[]> => ipcRenderer.invoke('ade:hosts'),
  addHost: (input: ManualHostInput): Promise<SshHost> => ipcRenderer.invoke('ade:add-host', input),
  removeHost: (id: string): Promise<void> => ipcRenderer.invoke('ade:remove-host', id),
  /** A session in a folder on an SSH host. */
  createRemote: (req: NewRemoteSessionRequest): Promise<NewRemoteSessionResult> => ipcRenderer.invoke('ade:create-remote', req),
  /** What a session changed since its branch left the default branch, its pull request, and where it stands. */
  review: (cwd: string): Promise<ReviewResult> => ipcRenderer.invoke('ade:review', cwd),
  commit: (cwd: string, message: string): Promise<ReviewAction> => ipcRenderer.invoke('ade:commit', cwd, message),
  push: (cwd: string): Promise<ReviewAction> => ipcRenderer.invoke('ade:push', cwd),
  /** Pushes, then opens a pull request into `base` (the default branch when not given). */
  createPr: (cwd: string, req: { title: string; body: string; draft: boolean; base?: string }): Promise<ReviewAction> => ipcRenderer.invoke('ade:create-pr', cwd, req),
  /** Branches a pull request can go into, the default one first. */
  baseBranches: (cwd: string): Promise<{ default: string | null; branches: string[] }> => ipcRenderer.invoke('ade:base-branches', cwd),
  /** A pull request title and description from the commits `base` doesn't have. */
  prFromCommits: (cwd: string, base: string): Promise<{ title: string; body: string } | { error: string }> => ipcRenderer.invoke('ade:pr-from-commits', cwd, base),
  /** The end of a failed check's log (GitHub Actions only). */
  checkLog: (cwd: string, check: Pick<ReviewCheck, 'url' | 'name' | 'workflow'>): Promise<ReviewLog> => ipcRenderer.invoke('ade:check-log', cwd, check),
  /** Merges the default branch into this one, fetching it first. */
  updateFromBase: (cwd: string): Promise<ReviewAction> => ipcRenderer.invoke('ade:update-from-base', cwd),
  /** A conflicted file's text, markers and all. */
  conflictFile: (cwd: string, path: string): Promise<ReviewFileText> => ipcRenderer.invoke('ade:conflict-file', cwd, path),
  writeConflictFile: (cwd: string, path: string, text: string): Promise<ReviewAction> => ipcRenderer.invoke('ade:write-conflict-file', cwd, path, text),
  /** Stages a conflicted file once no markers are left in it. */
  markResolved: (cwd: string, path: string): Promise<ReviewAction> => ipcRenderer.invoke('ade:mark-resolved', cwd, path),
  /** Commits the merge (or continues the rebase) once nothing is in conflict. */
  finishMerge: (cwd: string): Promise<ReviewAction> => ipcRenderer.invoke('ade:finish-merge', cwd),
  abortMerge: (cwd: string): Promise<ReviewAction> => ipcRenderer.invoke('ade:abort-merge', cwd),
  merge: (cwd: string, method: 'squash' | 'merge' | 'rebase'): Promise<ReviewAction> => ipcRenderer.invoke('ade:merge', cwd, method),
  /** Where new sessions' worktrees go, and the home folder (to show paths under it as ~). */
  worktreesRoot: (): Promise<{ path: string; home: string }> => ipcRenderer.invoke('ade:worktrees-root')
}
