import { ipcRenderer } from 'electron'
import type { ChannelKind, ChannelLevel, ChannelLink, ChannelLinkPatch, ChannelStatus, WhatsAppGroup } from '@shared/channels'

/**
 * Renderer bridge for chat apps (Discord, Telegram, WhatsApp). Exposed as
 * `window.api.channels`. Main owns the connections; tokens go in and never
 * come back out. Keep every channel this feature uses in this file.
 */

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const channelsApi = {
  list: (): Promise<{ links: ChannelLink[]; statuses: ChannelStatus[] }> => ipcRenderer.invoke('channels:list'),
  /** A new connection for a worker. WhatsApp starts showing its QR code straight away. */
  create: (kind: ChannelKind, workerId: string | null): Promise<ChannelLink> => ipcRenderer.invoke('channels:create', kind, workerId),
  /** Checks a Discord or Telegram bot token with the app, saves it and connects. Rejects with a sentence for the user. */
  setToken: (id: string, token: string): Promise<ChannelLink> => ipcRenderer.invoke('channels:set-token', id, token),
  update: (id: string, patch: ChannelLinkPatch): Promise<ChannelLink> => ipcRenderer.invoke('channels:update', id, patch),
  /** Disconnects and forgets it; a WhatsApp link is also unlinked from the phone. */
  remove: (id: string): Promise<void> => ipcRenderer.invoke('channels:remove', id),
  allow: (id: string, code: string): Promise<ChannelLink> => ipcRenderer.invoke('channels:allow', id, code),
  dismiss: (id: string, code: string): Promise<ChannelLink> => ipcRenderer.invoke('channels:dismiss', id, code),
  setPersonLevel: (id: string, personId: string, level: ChannelLevel): Promise<ChannelLink> =>
    ipcRenderer.invoke('channels:set-person-level', id, personId, level),
  removePerson: (id: string, personId: string): Promise<ChannelLink> => ipcRenderer.invoke('channels:remove-person', id, personId),
  addChat: (id: string, chatId: string, name: string): Promise<ChannelLink> => ipcRenderer.invoke('channels:add-chat', id, chatId, name),
  removeChat: (id: string, chatId: string): Promise<ChannelLink> => ipcRenderer.invoke('channels:remove-chat', id, chatId),
  /** Forgets the paired owner and makes a new pairing code. */
  resetOwner: (id: string): Promise<ChannelLink> => ipcRenderer.invoke('channels:reset-owner', id),
  whatsappGroups: (id: string): Promise<WhatsAppGroup[]> => ipcRenderer.invoke('channels:whatsapp-groups', id),
  onChanged: (handler: (links: ChannelLink[]) => void): (() => void) => subscribe('channels:changed', handler),
  onStatus: (handler: (statuses: ChannelStatus[]) => void): (() => void) => subscribe('channels:status', handler)
}
