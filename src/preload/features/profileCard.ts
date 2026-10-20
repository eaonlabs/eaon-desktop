import { ipcRenderer } from 'electron'

/** Settings → Profile's share card. Exposed as `window.api.profileCard`. */
export const profileCardApi = {
  /** Puts the card's PNG on the clipboard. */
  copy: (png: Uint8Array): Promise<void> => ipcRenderer.invoke('profile-card:copy', png),
  /** Asks where to save the card's PNG; the path it went to, or null when cancelled. */
  save: (png: Uint8Array, name: string): Promise<string | null> => ipcRenderer.invoke('profile-card:save', png, name)
}
