import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import type { VmManager } from './service'

/**
 * The worker host's VM channels: every manager call as `vms:<method>`, and the
 * live view's screen and a terminal's SSH relayed as raw byte streams (the
 * desktop's viewer speaks VNC and its `ssh` speaks SSH end to end; this only
 * carries the bytes, base64 over the encrypted link). The desktop calls the same methods on its own manager
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
  'sshKey',
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

/**
 * `restart`: the host app ending itself so its service starts it again, given
 * only where a service will. Installing QEMU can add this user to the `kvm`
 * group, which a running process never picks up.
 */
export function registerVmIpc(ipc: HandlerHost, manager: VmManager, options: { restart?: () => void } = {}): () => void {
  for (const method of VM_METHODS) {
    if (method === 'installTools') continue
    ipc.handle(`vms:${method}`, (_event, ...args) => (manager[method] as (...a: unknown[]) => unknown)(...args))
  }
  ipc.handle('vms:installTools', async () => {
    const result = await manager.installTools()
    if (!result.restartNeeded || !options.restart) return result
    // After the answer has gone back over the link.
    setTimeout(options.restart, 1500)
    return { ...result, restarting: true }
  })

  const sessions = new Map<string, Socket>()
  // A screen or a terminal's SSH: either way a stream of bytes, relayed as they come.
  const relay = (socket: Socket, sender: Sender): string => {
    const session = randomBytes(8).toString('hex')
    sessions.set(session, socket)
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
    return session
  }
  ipc.handle('vms:vncOpen', async (event, id) => {
    const { socket, password } = await manager.openScreen(String(id))
    return { session: relay(socket, event.sender), password }
  })
  ipc.handle('vms:sshOpen', async (event, id) => ({ session: relay(await manager.openSsh(String(id)), event.sender) }))
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
