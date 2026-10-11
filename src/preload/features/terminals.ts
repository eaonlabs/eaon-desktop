import { ipcRenderer } from 'electron'
import type {
  TerminalAgent,
  TerminalAgentEvent,
  TerminalAgentId,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalLayout,
  TerminalSpawnRequest,
  TerminalSpawnResult
} from '@shared/terminals'

/** Renderer bridge for the ADE's terminal view. Exposed as `window.api.terminals`. */

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const terminalsApi = {
  /** Which agent CLIs are installed on this machine. */
  agents: (): Promise<TerminalAgent[]> => ipcRenderer.invoke('terminal:agents'),
  /** Starts (or reattaches to) the shell behind a pane. */
  spawn: (req: TerminalSpawnRequest): Promise<TerminalSpawnResult> => ipcRenderer.invoke('terminal:spawn', req),
  write: (paneId: string, data: string): void => ipcRenderer.send('terminal:write', paneId, data),
  resize: (paneId: string, cols: number, rows: number): void => ipcRenderer.send('terminal:resize', paneId, cols, rows),
  kill: (paneId: string): void => ipcRenderer.send('terminal:kill', paneId),
  layout: (): Promise<TerminalLayout> => ipcRenderer.invoke('terminal:layout'),
  saveLayout: (layout: TerminalLayout): Promise<void> => ipcRenderer.invoke('terminal:save-layout', layout),
  onData: (handler: (event: TerminalDataEvent) => void): (() => void) => subscribe('terminal:data', handler),
  onExit: (handler: (event: TerminalExitEvent) => void): (() => void) => subscribe('terminal:exit', handler),
  /** What each live pane is running right now, as last read off the process table. */
  running: (): Promise<Record<string, TerminalAgentId>> => ipcRenderer.invoke('terminal:running'),
  /** The conversation each pane is in, where its agent has one the watch has seen. */
  conversations: (paneIds: string[]): Promise<Record<string, string | null>> => ipcRenderer.invoke('terminal:conversations', paneIds),
  /** A pane's agent changed — the user quit one CLI and started another in it. */
  onAgent: (handler: (event: TerminalAgentEvent) => void): (() => void) => subscribe('terminal:agent', handler),
  /** The layout changed from outside the window (a pane started from Eaon Remote). */
  onLayoutChanged: (handler: (layout: TerminalLayout) => void): (() => void) => subscribe('terminal:layout-changed', handler)
}
