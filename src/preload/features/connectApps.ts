import { ipcRenderer } from 'electron'
import type { ConnectAppId, ConnectAppStatus, ConnectChoice, ConnectResult, RestartResult } from '@shared/connectApps'

/**
 * Renderer bridge for Settings → Connect apps (pointing other apps at Eaon's
 * gateway). Exposed as `window.api.connectApps`.
 */
export const connectAppsApi = {
  list: (): Promise<ConnectAppStatus[]> => ipcRenderer.invoke('connect-apps:list'),
  /** Writes Eaon's settings into the app's config (or saves the choice, for launch apps). Starts the gateway. */
  connect: (id: ConnectAppId, choice?: Partial<ConnectChoice>): Promise<ConnectResult> => ipcRenderer.invoke('connect-apps:connect', id, choice),
  /** Takes Eaon's settings back out, restoring what was there. */
  disconnect: (id: ConnectAppId): Promise<ConnectResult> => ipcRenderer.invoke('connect-apps:disconnect', id),
  /** Opens the app in a terminal with Eaon's settings. */
  launch: (id: ConnectAppId, choice?: Partial<ConnectChoice>): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('connect-apps:launch', id, choice),
  /** The text for Copy settings. */
  manual: (id: ConnectAppId, choice?: Partial<ConnectChoice>): Promise<{ ok: true; text: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('connect-apps:manual', id, choice),
  /** Whether the desktop app is open (ChatGPT on a Mac). */
  running: (id: ConnectAppId): Promise<boolean> => ipcRenderer.invoke('connect-apps:running', id),
  /** Quits the desktop app if it's open and opens it again, so it loads Eaon's settings (ChatGPT on a Mac). */
  restart: (id: ConnectAppId): Promise<RestartResult> => ipcRenderer.invoke('connect-apps:restart', id)
}
