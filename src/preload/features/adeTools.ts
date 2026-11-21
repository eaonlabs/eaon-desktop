import { ipcRenderer } from 'electron'
import type { AdeSession } from '@shared/adeSessions'
import type { ProjectScripts, ScriptRun } from '@shared/adeScripts'
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
  restore: (id: string): Promise<AdeSession | null> => ipcRenderer.invoke('ade-tools:restore', id),
  /** Which of the paths a terminal printed are files in the session's folder: each one's absolute path, or null. */
  existingFiles: (folder: string, refs: string[]): Promise<(string | null)[]> => ipcRenderer.invoke('ade-tools:existing-files', folder, refs),
  /** A project's scripts (setup, run, teardown); empty when it has none. */
  scripts: (project: string): Promise<ProjectScripts> => ipcRenderer.invoke('ade-tools:scripts', project),
  saveScripts: (project: string, scripts: ProjectScripts): Promise<ProjectScripts> => ipcRenderer.invoke('ade-tools:save-scripts', project, scripts),
  /** Runs the project's teardown in the session's folder and waits; null when it has none to run. */
  runTeardown: (sessionId: string): Promise<ScriptRun | null> => ipcRenderer.invoke('ade-tools:run-teardown', sessionId)
}
