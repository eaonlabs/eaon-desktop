import { ipcRenderer } from 'electron'
import type { DetectedApp } from '@shared/linkAccounts'

/** Renderer bridge for Link accounts. Exposed as `window.api.linkAccounts`. */
export const linkAccountsApi = {
  /** Which AI apps are installed (presence only; nothing inside them is read). */
  detect: (): Promise<DetectedApp[]> => ipcRenderer.invoke('link-accounts:detect')
}
