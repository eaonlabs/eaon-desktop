import { ipcRenderer } from 'electron'
import type { GitMention, GitRefs, MentionAttachment } from '@shared/chatContext'
import type { ProjectRules } from '@shared/projectRules'
import type { PromptCommand } from '@shared/promptCommands'

/** Renderer bridge for what Chat's message box pulls in. Exposed as `window.api.chatContext`. */
export const chatContextApi = {
  /** The commits and branches the "@" menu offers, and the branch changes are compared with. */
  refs: (cwd: string): Promise<GitRefs> => ipcRenderer.invoke('chat-context:refs', cwd),
  /** A git mention's diff, saved as a file to attach. */
  git: (cwd: string, mention: GitMention): Promise<MentionAttachment> => ipcRenderer.invoke('chat-context:git', cwd, mention),
  /** The rules files (AGENTS.md and the like) the agent is given in a project folder. */
  rules: (cwd: string): Promise<Pick<ProjectRules, 'files' | 'skipped'>> => ipcRenderer.invoke('chat-context:rules', cwd),
  /** The "/" commands made from prompt files: the project's (null for none) and the user's own. */
  commands: (cwd: string | null): Promise<PromptCommand[]> => ipcRenderer.invoke('chat-context:commands', cwd),
  /** Opens the user's commands folder, made if needed; its path. */
  openCommandsFolder: (): Promise<string> => ipcRenderer.invoke('chat-context:commands-folder'),
  /** Text read in the window (a terminal, an earlier chat), saved as a file to attach; its path. */
  save: (label: string, text: string): Promise<string> => ipcRenderer.invoke('chat-context:save', label, text)
}
