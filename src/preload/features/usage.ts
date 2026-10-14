import { ipcRenderer } from 'electron'
import type { ToknAccount, ToknPage, UsageAccountState, UsageRange, UsageSummary } from '@shared/usage'

/** Renderer bridge for Settings → Usage and the Tokn account (Eaon's account). Exposed as `window.api.usage`. */
export const usageApi = {
  summary: (range: UsageRange): Promise<UsageSummary> => ipcRenderer.invoke('usage:summary', range),
  /** The account, sign-in and sync, without the numbers: for the account entry. */
  account: (): Promise<UsageAccountState> => ipcRenderer.invoke('usage:account'),
  /** Opens Tokn's approval page; resolves with the account once approved, or null. */
  signIn: (): Promise<ToknAccount | null> => ipcRenderer.invoke('usage:sign-in'),
  cancelSignIn: (): Promise<void> => ipcRenderer.invoke('usage:cancel-sign-in'),
  /** A redirect URL pasted from the browser, when it couldn't reach Eaon. */
  submitCode: (input: string): Promise<void> => ipcRenderer.invoke('usage:submit-code', input),
  signOut: (): Promise<void> => ipcRenderer.invoke('usage:sign-out'),
  sync: (): Promise<void> => ipcRenderer.invoke('usage:sync'),
  /** Opens the Tokn profile (the default), the Eaon profile, or the Eaon leaderboard in the browser. */
  openProfile: (page?: ToknPage): Promise<void> => ipcRenderer.invoke('usage:open-profile', page),
  /** Usage was recorded, or sign-in or sync moved: read the summary again. */
  onChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('usage:changed', listener)
    return () => {
      ipcRenderer.removeListener('usage:changed', listener)
    }
  }
}
