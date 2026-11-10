import { ipcRenderer } from 'electron'
import type { CommitMessageResult, GitAssistModel, LocalReviewResult, PrTextResult } from '@shared/gitAssist'

/** Renderer bridge for the model's help with git. Exposed as `window.api.gitAssist`. */
export const gitAssistApi = {
  /** A commit message for what Commit would take, from a bounded diff of it. */
  commitMessage: (cwd: string, model: GitAssistModel): Promise<CommitMessageResult> => ipcRenderer.invoke('git-assist:commit-message', cwd, model),
  /** A pull request's title and description from the branch's commits and diff against `base`. */
  pullRequest: (cwd: string, base: string, model: GitAssistModel): Promise<PrTextResult> => ipcRenderer.invoke('git-assist:pull-request', cwd, base, model),
  /** A review of the uncommitted changes: what the model found, by file and line. */
  review: (cwd: string, model: GitAssistModel): Promise<LocalReviewResult> => ipcRenderer.invoke('git-assist:review', cwd, model)
}
