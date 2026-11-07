import { ipcRenderer } from 'electron'
import type { ExportFormat } from '@shared/chatExport'
import type { Chat } from '@shared/types'

/** Renderer bridge for exporting a chat (main/features/chatExport). Exposed as `window.api.chatExport`. */
export const chatExportApi = {
  /** Asks where to save, then writes the chat there. */
  save: (chat: Chat, format: ExportFormat): Promise<{ ok: true; path: string } | { ok: false; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('chat-export:save', chat, format)
}
