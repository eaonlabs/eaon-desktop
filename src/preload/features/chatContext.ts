import { ipcRenderer } from 'electron'
import type { GitMention, GitRefs, MentionAttachment } from '@shared/chatContext'

/** Renderer bridge for what Chat's message box pulls in. Exposed as `window.api.chatContext`. */
export const chatContextApi = {
  /** The commits and branches the "@" menu offers, and the branch changes are compared with. */
  refs: (cwd: string): Promise<GitRefs> => ipcRenderer.invoke('chat-context:refs', cwd),
  /** A git mention's diff, saved as a file to attach. */
  git: (cwd: string, mention: GitMention): Promise<MentionAttachment> => ipcRenderer.invoke('chat-context:git', cwd, mention),
  /** Text read in the window (a terminal, an earlier chat), saved as a file to attach; its path. */
  save: (label: string, text: string): Promise<string> => ipcRenderer.invoke('chat-context:save', label, text)
}
