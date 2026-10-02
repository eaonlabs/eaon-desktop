import { ipcRenderer } from 'electron'
import type { DiscordConnection, DiscordSnapshot } from '@shared/discordPresence'

/**
 * Renderer bridge for Discord Rich Presence. Exposed as `window.api.discord`.
 * Keep every channel this feature uses in this one file.
 */
export const discordApi = {
  /** What Eaon is doing, for the presence card; null ends the presence. */
  sync: (snapshot: DiscordSnapshot | null): void => ipcRenderer.send('discord:sync', snapshot),
  status: (): Promise<DiscordConnection> => ipcRenderer.invoke('discord:status'),
  onStatus: (handler: (status: DiscordConnection) => void): (() => void) => {
    const listener = (_e: unknown, status: DiscordConnection): void => handler(status)
    ipcRenderer.on('discord:status', listener)
    return () => ipcRenderer.removeListener('discord:status', listener)
  }
}
