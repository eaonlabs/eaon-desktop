import { globalShortcut } from 'electron'

/** The key that opens a new chat from any app; the one in Settings → General → Quick chat. */
export const QUICK_CHAT_ACCELERATOR = 'CommandOrControl+Shift+Space'

let registered = false

/**
 * Turns the system-wide quick chat key on or off. `open` brings Eaon to the
 * front on a new chat. A key another app already holds can't be taken: the
 * switch then stays off, and the result says so.
 */
export function applyQuickChat(enabled: boolean, open: () => void): boolean {
  if (registered) {
    globalShortcut.unregister(QUICK_CHAT_ACCELERATOR)
    registered = false
  }
  if (!enabled) return true
  registered = globalShortcut.register(QUICK_CHAT_ACCELERATOR, open)
  return registered
}

export function disposeQuickChat(): void {
  if (registered) globalShortcut.unregister(QUICK_CHAT_ACCELERATOR)
  registered = false
}
