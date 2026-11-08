import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import type { VmManager } from './service'

/**
 * The worker host's VM channels: every manager call as `vms:<method>`, and the
 * live view's screen relayed as a raw byte stream (the desktop's viewer
 * speaks VNC end to end; this only carries the bytes, base64 over the
 * encrypted link). The desktop calls the same methods on its own manager
 * directly (features/vms.ts).
 */

export const VM_METHODS = [
  'info',
  'list',
  'create',
  'cancel',
  'start',
  'stop',
  'remove',
  'update',
  'snapshot',
  'restore',
  'deleteSnapshot',
  'login',
  'exec',
  'screenshot',
  'input',
  'installTools',
  'setAgentActive'
] as const
export type VmMethod = (typeof VM_METHODS)[number]

interface Sender {
  send: (channel: string, ...args: unknown[]) => void
  isDestroyed: () => boolean
  once: (event: string, fn: () => void) => void
}

interface HandlerHost {
  handle: (channel: string, handler: (event: { sender: Sender }, ...args: unknown[]) => unknown) => void
}

export function registerVmIpc(ipc: HandlerHost, manager: VmManager): () => void {
  for (const method of VM_METHODS) {
    ipc.handle(`vms:${method}`, (_event, ...args) => (manager[method] as (...a: unknown[]) => unknown)(...args))
  }

  const sessions = new Map<string, Socket>()
  ipc.handle('vms:vncOpen', async (event, id) => {
    const { socket, password } = await manager.openScreen(String(id))
    const session = randomBytes(8).toString('hex')
    sessions.set(session, socket)
    const sender = event.sender
    socket.on('data', (chunk: Buffer) => {
      if (!sender.isDestroyed()) sender.send('vms:vncData', session, chunk.toString('base64'))
    })
    socket.on('close', () => {
      sessions.delete(session)
      if (!sender.isDestroyed()) sender.send('vms:vncClosed', session)
    })
    socket.on('error', () => undefined)
    // The desktop went away: its views go with it.
    sender.once('destroyed', () => socket.destroy())
    return { session, password }
  })
  ipc.handle('vms:vncSend', (_event, session, data) => {
    sessions.get(String(session))?.write(Buffer.from(String(data), 'base64'))
    return true
  })
  ipc.handle('vms:vncClose', (_event, session) => {
    sessions.get(String(session))?.destroy()
    return true
  })

  return () => {
    for (const socket of sessions.values()) socket.destroy()
    sessions.clear()
  }
}
