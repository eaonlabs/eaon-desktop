import { ipcRenderer } from 'electron'
import type {
  AdeConversation,
  AdeImportCandidate,
  AdeSession,
  NewSessionRequest,
  NewSessionResult,
  RemoveSessionOptions
} from '@shared/adeSessions'

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
  /** Every folder with Claude Code or Codex conversations on this computer (nothing is imported yet). */
  importScan: (): Promise<AdeImportCandidate[]> => ipcRenderer.invoke('ade:import-scan'),
  /** Sessions for the chosen folders; returns the ones made. */
  import: (folders: { cwd: string; at: number }[]): Promise<AdeSession[]> => ipcRenderer.invoke('ade:import', folders),
  /** Where new sessions' worktrees go, and the home folder (to show paths under it as ~). */
  worktreesRoot: (): Promise<{ path: string; home: string }> => ipcRenderer.invoke('ade:worktrees-root')
}
