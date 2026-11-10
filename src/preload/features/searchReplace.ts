import { ipcRenderer } from 'electron'
import type { SearchOptions } from '@shared/chatCode'
import type { ReplaceResult, ReplaceTarget, UndoReplaceResult } from '@shared/searchReplace'

/** Renderer bridge for replacing across the project. Exposed as `window.api.searchReplace`. */
export const searchReplaceApi = {
  /** Writes the replacement into the chosen matches (lines of files the search listed) in the folder. */
  replace: (cwd: string, query: string, options: SearchOptions, replacement: string, targets: ReplaceTarget[]): Promise<ReplaceResult> =>
    ipcRenderer.invoke('search-replace:replace', cwd, query, options, replacement, targets),
  /** Puts back the folder's last replacement, in the files still as it left them. */
  undo: (cwd: string): Promise<UndoReplaceResult> => ipcRenderer.invoke('search-replace:undo', cwd)
}
