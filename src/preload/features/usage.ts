import { ipcRenderer } from 'electron'
import type { ToknAccount, UsageRange, UsageSummary } from '@shared/usage'

/** Renderer bridge for Settings → Usage and its Tokn sign-in. Exposed as `window.api.usage`. */
export const usageApi = {
  summary: (range: UsageRange): Promise<UsageSummary> => ipcRenderer.invoke('usage:summary', range),
  /** Opens Tokn's approval page; resolves with the account once approved, or null. */
  signIn: (): Promise<ToknAccount | null> => ipcRenderer.invoke('usage:sign-in'),
  cancelSignIn: (): Promise<void> => ipcRenderer.invoke('usage:cancel-sign-in'),
  /** A redirect URL pasted from the browser, when it couldn't reach Eaon. */
  submitCode: (input: string): Promise<void> => ipcRenderer.invoke('usage:submit-code', input),
  signOut: (): Promise<void> => ipcRenderer.invoke('usage:sign-out'),
  sync: (): Promise<void> => ipcRenderer.invoke('usage:sync'),
  openProfile: (): Promise<void> => ipcRenderer.invoke('usage:open-profile'),
  /** Usage was recorded, or sign-in or sync moved: read the summary again. */
  onChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('usage:changed', listener)
    return () => {
      ipcRenderer.removeListener('usage:changed', listener)
    }
  }
}
