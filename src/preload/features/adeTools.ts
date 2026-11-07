import { ipcRenderer } from 'electron'
import type { AdeSession } from '@shared/adeSessions'
import type { CopyPlan, CopyReport, WorktreeCopySettings } from '@shared/worktreeCopy'

/** Renderer bridge for what the ADE does around a session (features/adeTools.ts). Exposed as `window.api.adeTools`. */
export const adeToolsApi = {
  /** Which files a new worktree gets from the project's ignored ones. */
  copySettings: (): Promise<WorktreeCopySettings> => ipcRenderer.invoke('ade-tools:copy-settings'),
  saveCopySettings: (settings: WorktreeCopySettings): Promise<WorktreeCopySettings> => ipcRenderer.invoke('ade-tools:save-copy-settings', settings),
  /** What a new session in the project would get; null when there is nothing to look at (not a repository, or on another machine). Nothing is copied. */
  previewCopy: (project: string): Promise<CopyPlan | null> => ipcRenderer.invoke('ade-tools:preview-copy', project),
  /** Copies them into a session's new worktree. */
  copyIgnored: (sessionId: string): Promise<CopyReport> => ipcRenderer.invoke('ade-tools:copy-ignored', sessionId),
  /** Moves a session to the Archived group; the session as it is now, or null when it is gone. */
  archive: (id: string): Promise<AdeSession | null> => ipcRenderer.invoke('ade-tools:archive', id),
  restore: (id: string): Promise<AdeSession | null> => ipcRenderer.invoke('ade-tools:restore', id)
}
