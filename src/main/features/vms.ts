import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { app, dialog, type WebContents } from 'electron'
import type { VmDevice, VmDeviceInfo, VmDeviceState, VmStatus } from '@shared/vms'
import { registerToolSource } from '../agent/tools'
import { createVmManager, defaultSocketDir, type VmManager } from '../vms/service'
import { VM_METHODS, type VmMethod } from '../vms/ipc'
import { vmToolSource, type VmDirectory } from '../vms/tool'
import { workerHostController } from './workerHost'
import type { Feature } from './types'

/**
 * Virtual machines, from the desktop: its own (run by a manager here) and
 * the worker computer's (run by the host's manager, reached over the link).
 * The Computers page calls `vms:call` with a device and a method; the live
 * view opens a screen session, whose VNC bytes go to the window as they come
 * (straight from the VM here, relayed over the link for the worker
 * computer's). Agents get the `vm` tool for both.
 */

let manager: VmManager | null = null

const localName = (): string => hostname().replace(/\.local\.?$/i, '').replace(/-/g, ' ')

export const vmsFeature: Feature = {
  id: 'vms',
  register(ctx) {
    const helper = process.platform === 'darwin' ? (app.isPackaged ? join(process.resourcesPath, 'vm', 'darwin', 'eaon-vm') : join(app.getAppPath(), 'resources', 'vm', 'darwin', 'eaon-vm')) : null
    const local = createVmManager({
      root: join(app.getPath('userData'), 'vms'),
      socketDir: defaultSocketDir(),
      helper,
      device: 'local',
      name: localName,
      onChange: (vms) => ctx.send('vms:changed', 'local', vms)
    })
    manager = local

    /* ------------------------------------------------ the worker computer */

    const hostCache: { vms: VmStatus[]; info: VmDeviceInfo | null } = { vms: [], info: null }
    const host = (): ReturnType<typeof workerHostController> => workerHostController()
    const hostConnected = (): boolean => Boolean(host()?.state().host && host()?.link.connected)
    const hostCall = <T>(method: string, args: unknown[], timeoutMs = 60_000): Promise<T> => {
      const controller = host()
      if (!controller?.state().host) return Promise.reject(new Error('No worker computer is linked.'))
      return controller.link.call<T>('ipc', { channel: `vms:${method}`, args }, timeoutMs)
    }
    const refreshHost = async (): Promise<void> => {
      if (!hostConnected()) return
      try {
        hostCache.vms = await hostCall<VmStatus[]>('list', [], 15_000)
        ctx.send('vms:changed', 'host', hostCache.vms)
      } catch {
        // An older host app, before VMs: it's updated on connect, and then answers.
      }
    }

    /** Live views: the window that opened each, and where its bytes come from. */
    const views = new Map<string, { sender: WebContents; socket?: Socket; remote?: string }>()
    const byRemote = new Map<string, string>()
    const closeView = (id: string, tell: boolean): void => {
      const view = views.get(id)
      if (!view) return
      views.delete(id)
      view.socket?.destroy()
      if (view.remote) {
        byRemote.delete(view.remote)
        void hostCall('vncClose', [view.remote]).catch(() => undefined)
      }
      if (tell && !view.sender.isDestroyed()) view.sender.send('vms:vnc-closed', id)
    }

    host()?.onIpc((channel, args) => {
      if (channel === 'host:connected') return void refreshHost()
      if (channel === 'vms:changed') {
        hostCache.vms = args[0] as VmStatus[]
        ctx.send('vms:changed', 'host', hostCache.vms)
      } else if (channel === 'vms:vncData') {
        const id = byRemote.get(String(args[0]))
        const view = id ? views.get(id) : null
        if (view && !view.sender.isDestroyed()) view.sender.send('vms:vnc-data', id, Buffer.from(String(args[1]), 'base64'))
      } else if (channel === 'vms:vncClosed') {
        const id = byRemote.get(String(args[0]))
        if (id) {
          views.get(id)!.remote = undefined
          byRemote.delete(String(args[0]))
          closeView(id, true)
        }
      }
    })
    void refreshHost()

    /* --------------------------------------------------- calls, by device */

    const call = async (device: VmDevice, method: VmMethod, args: unknown[]): Promise<unknown> => {
      if (!VM_METHODS.includes(method)) throw new Error(`${method} isn’t something VMs do.`)
      if (device === 'local') return (local[method] as (...a: unknown[]) => unknown)(...args)
      const timeout = method === 'installTools' ? 16 * 60_000 : method === 'exec' ? Number(args[2] ?? 120_000) + 15_000 : 90_000
      return hostCall(method, args, timeout)
    }

    const devices = async (): Promise<VmDeviceState[]> => {
      const states: VmDeviceState[] = [{ device: 'local', name: localName(), connected: true, info: await local.info(), vms: local.list(), error: null }]
      const linked = host()?.state().host
      if (linked) {
        let error: string | null = null
        if (hostConnected()) {
          try {
            hostCache.info = await hostCall<VmDeviceInfo>('info', [], 20_000)
            hostCache.vms = await hostCall<VmStatus[]>('list', [], 20_000)
          } catch (e) {
            error = /isn’t served/.test(String(e)) ? 'The worker computer’s Eaon is being updated for VMs. Try again in a minute.' : e instanceof Error ? e.message : String(e)
          }
        } else {
          error = 'The worker computer can’t be reached right now.'
        }
        states.push({ device: 'host', name: linked.name, connected: hostConnected(), info: hostCache.info, vms: hostCache.vms, error })
      }
      return states
    }

    ctx.ipcMain.handle('vms:devices', () => devices())
    ctx.ipcMain.handle('vms:call', (_event, device: VmDevice, method: VmMethod, ...args: unknown[]) => call(device, method, args))
    ctx.ipcMain.handle('vms:pick-ipsw', async () => {
      const window = ctx.getWindow()
      const options = { title: 'Choose a macOS restore image', filters: [{ name: 'macOS restore image', extensions: ['ipsw'] }], properties: ['openFile' as const] }
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    })

    ctx.ipcMain.handle('vms:vnc-open', async (event, device: VmDevice, vmId: string) => {
      const id = randomBytes(8).toString('hex')
      const sender = event.sender
      if (device === 'local') {
        const { socket, password } = await local.openScreen(vmId)
        views.set(id, { sender, socket })
        socket.on('data', (chunk: Buffer) => {
          if (!sender.isDestroyed()) sender.send('vms:vnc-data', id, chunk)
        })
        socket.on('close', () => closeView(id, true))
        socket.on('error', () => undefined)
        sender.once('destroyed', () => closeView(id, false))
        return { session: id, password }
      }
      const opened = await hostCall<{ session: string; password: string | null }>('vncOpen', [vmId], 20_000)
      views.set(id, { sender, remote: opened.session })
      byRemote.set(opened.session, id)
      sender.once('destroyed', () => closeView(id, false))
      return { session: id, password: opened.password }
    })
    ctx.ipcMain.on('vms:vnc-send', (_event, id: string, data: Uint8Array) => {
      const view = views.get(id)
      if (!view) return
      if (view.socket) view.socket.write(Buffer.from(data))
      else if (view.remote) void hostCall('vncSend', [view.remote, Buffer.from(data).toString('base64')], 15_000).catch(() => undefined)
    })
    ctx.ipcMain.handle('vms:vnc-close', (_event, id: string) => closeView(id, false))

    /* ------------------------------------------------------------ agents */

    const directory: VmDirectory = {
      cached: () => [...local.list(), ...(hostConnected() ? hostCache.vms : [])],
      start: (device, id) => call(device, 'start', [id]) as Promise<VmStatus>,
      stop: (device, id) => call(device, 'stop', [id]) as Promise<VmStatus>,
      exec: (device, id, command, timeoutMs) => call(device, 'exec', [id, command, timeoutMs]) as ReturnType<VmDirectory['exec']>,
      screenshot: (device, id) => call(device, 'screenshot', [id]) as ReturnType<VmDirectory['screenshot']>,
      input: (device, id, actions) => call(device, 'input', [id, actions]) as Promise<void>,
      setActive: (device, id, active) => void call(device, 'setAgentActive', [id, active]).catch(() => undefined)
    }
    registerToolSource(vmToolSource(directory))
  },

  // VMs here are asked to shut down; the helper finishes that after Eaon has gone.
  shutdown: async () => {
    await manager?.shutdown({ stopVms: true, resumeLater: false, graceMs: 0 })
  }
}
