import { ipcRenderer } from 'electron'
import type { ChatCommits } from '@shared/chatCode'
import type { LineBlameResult } from '@shared/fileHistory'

/** Renderer bridge for the editor's git history. Exposed as `window.api.gitHistory`. */
export const gitHistoryApi = {
  /** The commits that touched a file, newest first, following renames. */
  file: (cwd: string, file: string): Promise<ChatCommits> => ipcRenderer.invoke('git-history:file', cwd, file),
  /** Who last changed one line (1-based) of the file as it is on disk. */
  blame: (cwd: string, file: string, line: number): Promise<LineBlameResult> => ipcRenderer.invoke('git-history:blame', cwd, file, line)
}
