import { ipcRenderer } from 'electron'
import type { PetSnapshot } from '@shared/pets'

/**
 * Renderer bridge for the pets feature. Exposed as `window.api.pets`.
 * Keep every channel this feature uses in this one file.
 *
 * Two callers: the main window (opens/closes the desktop pet and streams it
 * snapshots) and the desktop pet window itself (moves, clicks through, pokes).
 */
export const petsApi = {
  /* ---- main window ---- */

  /** Open or close the floating desktop pet. */
  setDesktop: (on: boolean): Promise<void> => ipcRenderer.invoke('pets:desktop', on),
  /** Latest species, mood and theme, forwarded to the desktop pet. */
  sync: (snapshot: PetSnapshot): void => ipcRenderer.send('pets:sync', snapshot),
  /** The desktop pet was petted — counts as activity for the idle clock. */
  onPoke: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on('pets:poke', listener)
    return () => ipcRenderer.removeListener('pets:poke', listener)
  },

  /* ---- desktop pet window ---- */

  current: (): Promise<PetSnapshot | null> => ipcRenderer.invoke('pets:current'),
  onSnapshot: (handler: (snapshot: PetSnapshot) => void): (() => void) => {
    const listener = (_e: unknown, snapshot: PetSnapshot): void => handler(snapshot)
    ipcRenderer.on('pets:snapshot', listener)
    return () => ipcRenderer.removeListener('pets:snapshot', listener)
  },
  /** Take clicks while the pointer is over the pet; let them through otherwise. */
  setInteractive: (on: boolean): void => ipcRenderer.send('pets:interactive', on),
  /** Drag the window by the pointer's travel since the press. */
  drag: (dx: number, dy: number, phase: 'start' | 'move' | 'end'): void =>
    ipcRenderer.send('pets:drag', dx, dy, phase),
  /** Free space either side of the window on its display, for strolls. */
  room: (): Promise<{ left: number; right: number }> => ipcRenderer.invoke('pets:room'),
  /** Nudge the window sideways (a stroll step). */
  walk: (dx: number): void => ipcRenderer.send('pets:walk', dx),
  /** Remember where the window ended up. */
  settle: (): void => ipcRenderer.send('pets:settle'),
  poke: (): void => ipcRenderer.send('pets:poke')
}
