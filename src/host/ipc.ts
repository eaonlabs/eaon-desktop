/**
 * The worker host has no window. Features still register IPC handlers and
 * send to "the renderer"; here the handlers are called by the desktop over
 * the link, and what features send goes to every linked desktop. The same
 * idea as Eaon CLI's runtime/ipc.ts, with the sender carrying each
 * desktop's own id so a live view one desktop opened is closed with it.
 */

type Handler = (event: FakeEvent, ...args: unknown[]) => unknown

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

const handlers = new Map<string, Handler>()
type Sink = (channel: string, args: unknown[]) => void
const sinks = new Set<Sink>()

/** Everything features send "to the renderer", to every linked desktop. */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const sink of sinks) sink(channel, args)
}

export function onBroadcast(sink: Sink): () => void {
  sinks.add(sink)
  return () => sinks.delete(sink)
}

export interface HostIpc {
  handle(channel: string, handler: Handler): void
  handleOnce(channel: string, handler: Handler): void
  removeHandler(channel: string): void
  on(): HostIpc
  removeListener(): HostIpc
}

export const ipc: HostIpc = {
  handle(channel: string, handler: Handler): void {
    handlers.set(channel, handler)
  },
  handleOnce(channel: string, handler: Handler): void {
    handlers.set(channel, handler)
  },
  removeHandler(channel: string): void {
    handlers.delete(channel)
  },
  on(): HostIpc {
    return ipc
  },
  removeListener(): HostIpc {
    return ipc
  }
}

export function hasHandler(channel: string): boolean {
  return handlers.has(channel)
}

/**
 * A sender standing for one linked desktop: what it is sent goes only to it.
 * `destroy` is that desktop's link closing, as a window closing would be: it
 * reads as destroyed from then on, and what a feature hung on its
 * 'destroyed' event (a subscription, a live view) is let go.
 */
export function senderFor(id: number, send: (channel: string, args: unknown[]) => void): FakeEvent & { destroy: () => void } {
  let destroyed = false
  const onDestroyed = new Set<() => void>()
  const listen = (event: string, fn: () => void): void => {
    if (event !== 'destroyed') return
    if (destroyed) queueMicrotask(fn)
    else onDestroyed.add(fn)
  }
  return {
    sender: {
      id,
      send: (channel, ...args) => {
        if (!destroyed) send(channel, args)
      },
      isDestroyed: () => destroyed,
      once: listen,
      on: listen,
      removeListener: (event, fn) => {
        if (event === 'destroyed') onDestroyed.delete(fn)
      }
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      const fns = [...onDestroyed]
      onDestroyed.clear()
      for (const fn of fns) {
        try {
          fn()
        } catch (error) {
          console.error('[host] a destroyed listener failed:', error)
        }
      }
    }
  }
}

/** Calls a feature's handler, as `ipcRenderer.invoke` would from that desktop. */
export async function invoke(event: FakeEvent, channel: string, args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Nothing handles ${channel} on the worker computer.`)
  return handler(event, ...args)
}
