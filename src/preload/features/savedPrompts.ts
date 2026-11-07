import { ipcRenderer } from 'electron'
import type { PromptChange, SavedPrompt } from '@shared/savedPrompts'

/** Renderer bridge for the prompt library (main/features/savedPrompts). Exposed as `window.api.prompts`. */
export const savedPromptsApi = {
  list: (): Promise<SavedPrompt[]> => ipcRenderer.invoke('prompts:list'),
  /** Adds a prompt, or with `id` changes one. The name defaults to the first line of the text. */
  save: (input: { id?: string; name?: string; text: string }): Promise<PromptChange> => ipcRenderer.invoke('prompts:save', input),
  delete: (id: string): Promise<SavedPrompt[]> => ipcRenderer.invoke('prompts:delete', id),
  /** Another window changed the library; carries the whole list. */
  onChanged: (handler: (list: SavedPrompt[]) => void): (() => void) => {
    const listener = (_e: unknown, payload: SavedPrompt[]): void => handler(payload)
    ipcRenderer.on('prompts:changed', listener)
    return () => ipcRenderer.removeListener('prompts:changed', listener)
  }
}
