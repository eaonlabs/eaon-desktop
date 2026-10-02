import type { BrowserWindow, IpcMain } from 'electron'
import type { StreamEvent } from '@shared/types'

/**
 * What every feature module gets at startup. Features register their own IPC
 * handlers and tool sources from here, so `index.ts` stays a list of
 * registrations rather than growing with every feature.
 */
export interface FeatureContext {
  ipcMain: IpcMain
  /** The main window, or null while it is closed (macOS keeps the app alive). */
  getWindow: () => BrowserWindow | null
  /** Sends to the main window's renderer if it exists. */
  send: (channel: string, ...args: unknown[]) => void
  /**
   * Forwards agent stream events to the renderer, batched like interactive
   * chats. Headless runs (scheduled tasks) use it so a chat the user has open
   * updates live.
   */
  emitStream: (event: StreamEvent) => void
}

export interface Feature {
  id: string
  /** Called once from app.whenReady, after the window is created. */
  register: (ctx: FeatureContext) => void | Promise<void>
  /** Called from before-quit. Must not block. */
  dispose?: () => void
  /**
   * Called from before-quit, which holds the quit (capped) until it settles —
   * for child processes that must be reaped before the process exits.
   */
  shutdown?: () => Promise<void>
}
