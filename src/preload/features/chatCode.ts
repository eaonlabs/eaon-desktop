import { ipcRenderer } from 'electron'
import type { ReviewFile } from '@shared/adeReview'
import type { ChatBranches, CheckpointDiff, ChatCommits, ChatProcess, FileGitState, ChatDiffResult, ChatGitResult, ChatPullRequest, ChatGitStatus, OpenTarget, ProjectScript, ScriptSuggestion, SearchOptions, SearchResult, TurnChanges, TurnRestore } from '@shared/chatCode'

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
  /** The branch's latest commits, the unpushed ones marked. */
  commits: (cwd: string): Promise<ChatCommits> => ipcRenderer.invoke('chat-code:commits', cwd),
  /** What one commit changed, as git's diff. */
  commitDiff: (cwd: string, sha: string): Promise<ChatDiffResult> => ipcRenderer.invoke('chat-code:commit-diff', cwd, sha),
  /** One hunk of a file's uncommitted changes: rejected (undone in the files) or kept (staged). */
  hunk: (cwd: string, file: string, index: number, header: string, fingerprint: string, action: 'reject' | 'keep'): Promise<{ ok: true; note?: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('chat-code:hunk', cwd, file, index, header, fingerprint, action),
  /** Background processes the agent started in the folder (dev servers, watchers). */
  processes: (cwd: string): Promise<ChatProcess[]> => ipcRenderer.invoke('chat-code:processes', cwd),
  stopProcess: (cwd: string, pid: number): Promise<boolean> => ipcRenderer.invoke('chat-code:stop-process', cwd, pid),
  onProcessesChanged: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on('chat-code:processes-changed', listener)
    return () => ipcRenderer.removeListener('chat-code:processes-changed', listener)
  },
  /** Each changed file's git state, by full path (the editor's tree). */
  fileStates: (cwd: string): Promise<Record<string, FileGitState>> => ipcRenderer.invoke('chat-code:file-states', cwd),
  /** A file as it is in the last commit (the editor's gutter); null when git has none of it. */
  textAtHead: (cwd: string, file: string): Promise<string | null> => ipcRenderer.invoke('chat-code:text-at-head', cwd, file),
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
  saveScripts: (cwd: string, scripts: ProjectScript[]): Promise<ProjectScript[]> => ipcRenderer.invoke('chat-code:save-scripts', cwd, scripts),
  /** What a reply changed in the folder, by the checkpoints taken around it. */
  turnChanges: (cwd: string, replyId: string): Promise<TurnChanges> => ipcRenderer.invoke('chat-code:turn-changes', cwd, replyId),
  /** What these replies changed on disk by their checkpoints, however they changed it; `live` is the one still running. */
  checkpointDiff: (cwd: string, replyIds: string[], options: { patch?: boolean; live?: string | null } = {}): Promise<CheckpointDiff> =>
    ipcRenderer.invoke('chat-code:checkpoint-diff', cwd, replyIds, options),
  /** Each finished reply's own changes, counted, by reply id; replies without checkpoints are left out. */
  replyDiffs: (cwd: string, replyIds: string[]): Promise<Record<string, ReviewFile[]>> => ipcRenderer.invoke('chat-code:reply-diffs', cwd, replyIds),
  /** Puts a reply's files back as they were before it (undo) or as it left them (redo). */
  restoreTurn: (cwd: string, replyId: string, direction: 'undo' | 'redo', force = false): Promise<TurnRestore> =>
    ipcRenderer.invoke('chat-code:restore-turn', cwd, replyId, direction, force),
  /** Edit from here, files too: what these replies changed goes back to before the first. */
  rewind: (cwd: string, replyIds: string[]): Promise<TurnRestore> => ipcRenderer.invoke('chat-code:rewind', cwd, replyIds),
  dropCheckpoints: (cwd: string, replyIds: string[]): Promise<void> => ipcRenderer.invoke('chat-code:drop-checkpoints', cwd, replyIds)
}
