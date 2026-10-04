import { EventEmitter } from 'node:events'

/**
 * The desktop's features register IPC handlers for their renderer. In the
 * CLI there is no renderer: the TUI calls the same handlers in-process
 * (`invoke`) and listens to what features push (`events`). So the CLI
 * drives workers and trading through exactly the commands the desktop's
 * windows use, and gets exactly what they would be sent.
 */

type Handler = (event: FakeEvent, ...args: unknown[]) => unknown
type Listener = (event: FakeEvent, ...args: unknown[]) => void

/** Stands in for an IpcMainInvokeEvent: a sender that is never destroyed and forwards to `events`. */
export interface FakeEvent {
  sender: {
    id: number
    send: (channel: string, ...args: unknown[]) => void
    isDestroyed: () => boolean
    once: (event: string, fn: () => void) => void
    on: (event: string, fn: () => void) => void
    removeListener: (event: string, fn: () => void) => void
  }
}

/** Everything features send "to the renderer". */
export const events = new EventEmitter()
events.setMaxListeners(100)

const handlers = new Map<string, Handler>()
const listeners = new Map<string, Listener[]>()

const fakeEvent: FakeEvent = {
  sender: {
    id: 1,
    send: (channel, ...args) => events.emit(channel, ...args),
    isDestroyed: () => false,
    once: () => {},
    on: () => {},
    removeListener: () => {}
  }
}

export interface CliIpc {
  handle(channel: string, handler: Handler): void
  handleOnce(channel: string, handler: Handler): void
  removeHandler(channel: string): void
  on(channel: string, listener: Listener): CliIpc
  removeListener(channel: string, listener: Listener): CliIpc
}

export const ipc: CliIpc = {
  handle(channel: string, handler: Handler): void {
    handlers.set(channel, handler)
  },
  handleOnce(channel: string, handler: Handler): void {
    handlers.set(channel, handler)
  },
  removeHandler(channel: string): void {
    handlers.delete(channel)
  },
  on(channel: string, listener: Listener): CliIpc {
    listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
    return ipc
  },
  removeListener(channel: string, listener: Listener): CliIpc {
    listeners.set(channel, (listeners.get(channel) ?? []).filter((l) => l !== listener))
    return ipc
  }
}

/** Every registered channel, for a session that serves them to others. */
export function handlerNames(): string[] {
  return [...handlers.keys()]
}

export function hasHandler(channel: string): boolean {
  return handlers.has(channel)
}

/** Calls a feature's handler, as `ipcRenderer.invoke` would. */
export async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Nothing handles ${channel} in the CLI`)
  return (await handler(fakeEvent, ...args)) as T
}

/** Fire-and-forget messages (`ipcRenderer.send`). */
export function sendToMain(channel: string, ...args: unknown[]): void {
  for (const listener of listeners.get(channel) ?? []) listener(fakeEvent, ...args)
}
