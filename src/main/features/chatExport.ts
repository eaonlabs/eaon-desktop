import { app, BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Chat } from '@shared/types'
import { chatExportText, EXPORT_FORMATS, exportFileName, isExportFormat, type ExportFormat } from '@shared/chatExport'
import type { Feature } from './types'

/**
 * Export a chat to a file (shared/chatExport.ts). The renderer sends the chat
 * it is showing (a temporary chat exists nowhere else) and main asks where to
 * save it: the dialog and the write both happen here, so a page never picks
 * a path. Nothing is written until the person has chosen one.
 *
 * Channel: `chat-export:save`, answering `{ ok: true, path }`, `{ ok: false,
 * cancelled: true }` or `{ ok: false, error }`.
 */

export type ExportResult = { ok: true; path: string } | { ok: false; cancelled?: boolean; error?: string }

export interface ExportDeps {
  /** Asks where to save; null when the person cancels. */
  pick: (defaultName: string, format: ExportFormat) => Promise<string | null>
  write: (path: string, text: string) => Promise<void>
  now?: () => number
}

/** The chat as the renderer sent it, or null when it isn't one. */
function asChat(value: unknown): Chat | null {
  if (!value || typeof value !== 'object') return null
  const chat = value as Partial<Chat>
  return typeof chat.id === 'string' && Array.isArray(chat.messages) ? (chat as Chat) : null
}

export async function exportChat(raw: unknown, format: unknown, deps: ExportDeps): Promise<ExportResult> {
  const chat = asChat(raw)
  if (!chat || !isExportFormat(format)) return { ok: false, error: 'That isn’t a chat Eaon can export.' }
  try {
    const path = await deps.pick(exportFileName(chat.title, format), format)
    if (!path) return { ok: false, cancelled: true }
    await deps.write(path, chatExportText(chat, format, deps.now?.()))
    return { ok: true, path }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export const chatExportFeature: Feature = {
  id: 'chat-export',
  register: ({ ipcMain, getWindow }) => {
    ipcMain.handle('chat-export:save', (event, chat: unknown, format: unknown) =>
      exportChat(chat, format, {
        pick: async (defaultName, chosen) => {
          const parent = BrowserWindow.fromWebContents(event.sender) ?? getWindow()
          const options = {
            title: 'Export chat',
            defaultPath: join(app.getPath('downloads'), defaultName),
            filters: [{ name: EXPORT_FORMATS[chosen].label, extensions: [EXPORT_FORMATS[chosen].extension] }]
          }
          const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
          return result.canceled || !result.filePath ? null : result.filePath
        },
        write: (path, text) => writeFile(path, text, 'utf8')
      })
    )
  }
}
