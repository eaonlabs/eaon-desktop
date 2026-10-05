import { ipcRenderer } from 'electron'
import type { StoreHealth } from '@shared/storeHealth'

/**
 * Renderer bridge for notices about Eaon's saved data: a file repaired or
 * restored at startup, a save that is failing. Exposed as `window.api.storage`.
 */
export const storageApi = {
  health: (): Promise<StoreHealth> => ipcRenderer.invoke('store:health'),
  dismiss: (id: string): Promise<void> => ipcRenderer.invoke('store:dismiss', id),
  /** Shows the damaged copy a notice kept (or the file itself) in Finder / Explorer. */
  reveal: (id: string): Promise<void> => ipcRenderer.invoke('store:reveal', id),
  onHealth: (handler: (health: StoreHealth) => void): (() => void) => {
    const listener = (_e: unknown, health: StoreHealth): void => handler(health)
    ipcRenderer.on('store:health', listener)
    return () => ipcRenderer.removeListener('store:health', listener)
  }
}
