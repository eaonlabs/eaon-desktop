import { ipcRenderer } from 'electron'
import type { ChatBranches, ChatDiffResult, ChatGitResult, ChatPullRequest, ChatGitStatus, OpenTarget, ProjectScript, ScriptSuggestion, SearchOptions, SearchResult } from '@shared/chatCode'

/** Renderer bridge for Chat's coding controls. Exposed as `window.api.chatCode`. */
export const chatCodeApi = {
  /** Where the folder stands in git: branch, upstream, what is uncommitted. */
  status: (cwd: string): Promise<ChatGitStatus> => ipcRenderer.invoke('chat-code:status', cwd),
  branches: (cwd: string): Promise<ChatBranches> => ipcRenderer.invoke('chat-code:branches', cwd),
  /** Switches to a branch, or makes it from what is checked out when `create`. */
  switchBranch: (cwd: string, name: string, create = false): Promise<ChatGitResult> => ipcRenderer.invoke('chat-code:switch', cwd, name, create),
  pull: (cwd: string): Promise<ChatGitResult> => ipcRenderer.invoke('chat-code:pull', cwd),
  /** Everything not committed, as git's diff. */
  diff: (cwd: string): Promise<ChatDiffResult> => ipcRenderer.invoke('chat-code:diff', cwd),
  /** The branch's pull request, when GitHub can be asked. */
  pullRequest: (cwd: string): Promise<ChatPullRequest> => ipcRenderer.invoke('chat-code:pull-request', cwd),
  /** The editors, terminals and file manager on this computer. */
  openTargets: (): Promise<OpenTarget[]> => ipcRenderer.invoke('chat-code:open-targets'),
  /** Opens the folder, or a file in it at a line, in one of them. */
  openIn: (cwd: string, target: string, file?: string | null, line?: number | null): Promise<void> =>
    ipcRenderer.invoke('chat-code:open-in', cwd, target, file ?? null, line ?? null),
  search: (cwd: string, query: string, options?: SearchOptions): Promise<SearchResult> => ipcRenderer.invoke('chat-code:search', cwd, query, options),
  /** The project's files, relative to it. */
  files: (cwd: string): Promise<string[]> => ipcRenderer.invoke('chat-code:files', cwd),
  /** HTML from a reply, opened in the user's browser. */
  openHtml: (html: string): Promise<void> => ipcRenderer.invoke('chat-code:open-html', html),
  scripts: (cwd: string): Promise<{ scripts: ProjectScript[]; suggestions: ScriptSuggestion[] }> => ipcRenderer.invoke('chat-code:scripts', cwd),
  saveScripts: (cwd: string, scripts: ProjectScript[]): Promise<ProjectScript[]> => ipcRenderer.invoke('chat-code:save-scripts', cwd, scripts)
}
