import { ipcRenderer } from 'electron'
import type { MemoryChange, Personalize } from '@shared/personalize'

/** Renderer bridge for custom instructions and memory (main/features/personalize). Exposed as `window.api.personalize`. */
export const personalizeApi = {
  get: (): Promise<Personalize> => ipcRenderer.invoke('personalize:get'),
  setInstructions: (text: string): Promise<Personalize> => ipcRenderer.invoke('personalize:set-instructions', text),
  setMemoryEnabled: (enabled: boolean): Promise<Personalize> => ipcRenderer.invoke('personalize:memory-enabled', enabled),
  addMemory: (text: string): Promise<MemoryChange> => ipcRenderer.invoke('personalize:memory-add', text),
  editMemory: (id: string, text: string): Promise<MemoryChange> => ipcRenderer.invoke('personalize:memory-edit', id, text),
  deleteMemory: (id: string): Promise<Personalize> => ipcRenderer.invoke('personalize:memory-delete', id),
  clearMemory: (): Promise<Personalize> => ipcRenderer.invoke('personalize:memory-clear'),
  /** Another window, or the model saving a memory, changed these. */
  onChanged: (handler: (value: Personalize) => void): (() => void) => {
    const listener = (_e: unknown, payload: Personalize): void => handler(payload)
    ipcRenderer.on('personalize:changed', listener)
    return () => ipcRenderer.removeListener('personalize:changed', listener)
  }
}
