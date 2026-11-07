import type { Chat } from '@shared/types'
import type { ExportFormat } from '@shared/chatExport'
import { notify } from '../Notice'
import { errorText } from '../../lib/errors'

/** The chat menu's Export: main asks where to save and writes the file; this says how it went. */
export async function exportChatToFile(chat: Chat, format: ExportFormat): Promise<void> {
  try {
    const result = await window.api.chatExport.save(chat, format)
    if (result.ok) notify(`Saved to ${result.path}`)
    else if (!result.cancelled) notify(`Couldn't export the chat. ${result.error ?? ''}`.trim(), 'error')
  } catch (error) {
    notify(`Couldn't export the chat. ${errorText(error)}`, 'error')
  }
}
