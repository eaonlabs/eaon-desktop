import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { app, dialog, type WebContents } from 'electron'
import type { IPty } from 'node-pty'
import type { VmDevice, VmDeviceInfo, VmDeviceState, VmSshKey, VmStatus, VmTerminalSession } from '@shared/vms'
import { registerToolSource } from '../agent/tools'
import { createVmManager, defaultSocketDir, type VmManager } from '../vms/service'
import { VM_METHODS, type VmMethod } from '../vms/ipc'
import { vmToolSource, type VmDirectory } from '../vms/tool'
import { workerHostController } from './workerHost'
import { launcherEnv, loadPty } from './terminals/ptyManager'
import type { Feature } from './types'

/**
 * Virtual machines, from the desktop: its own (run by a manager here) and
 * the worker computer's (run by the host's manager, reached over the link).
 * The Computers page calls `vms:call` with a device and a method; the live
 * view opens a screen session, whose VNC bytes go to the window as they come
 * (straight from the VM here, relayed over the link for the worker
 * computer's). A terminal in a Linux VM is this computer's own `ssh` in a
 * pty, reaching the VM through a tunnel on 127.0.0.1 (straight to the VM
 * here, relayed over the link for the worker computer's), so the same
 * command works in the user's own terminal app while Eaon is open. Agents
 * get the `vm` tool for both.
 */

let tunnels = new Map<string, Promise<Server>>()
let terminals = new Map<string, IPty>()

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

    /** Tunnels' connections to the worker computer's VMs, by the host's session. */
    const piped = new Map<string, Socket>()

    host()?.onIpc((channel, args) => {
      if (channel === 'host:connected') return void refreshHost()
      const pipe = channel === 'vms:vncData' || channel === 'vms:vncClosed' ? piped.get(String(args[0])) : undefined
      if (pipe) {
        if (channel === 'vms:vncData') pipe.write(Buffer.from(String(args[1]), 'base64'))
        else {
          piped.delete(String(args[0]))
          pipe.destroy()
        }
      } else if (channel === 'vms:changed') {
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
        // The computer's own name (luminarc), not the address it was linked by.
        states.push({ device: 'host', name: host()?.state().hello?.name || linked.name, connected: hostConnected(), info: hostCache.info, vms: hostCache.vms, error })
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

    /* --------------------------------------------------------- terminals */

    /**
     * A port on 127.0.0.1 that reaches the VM's SSH, one per VM, open until
     * Eaon quits. Each connection to it is its own stream to the VM.
     */
    const tunnel = (device: VmDevice, vmId: string): Promise<Server> => {
      const key = `${device}:${vmId}`
      const existing = tunnels.get(key)
      if (existing) return existing
      const server = createServer((client) => {
        client.pause()
        client.on('error', () => undefined)
        if (device === 'local') {
          local.openSsh(vmId).then(
            (vm) => {
              vm.on('error', () => undefined)
              client.pipe(vm).pipe(client)
              client.resume()
            },
            () => client.destroy()
          )
          return
        }
        hostCall<{ session: string }>('sshOpen', [vmId], 20_000).then(
          ({ session }) => {
            if (client.destroyed) return void hostCall('vncClose', [session]).catch(() => undefined)
            piped.set(session, client)
            client.on('data', (chunk: Buffer) => void hostCall('vncSend', [session, chunk.toString('base64')], 15_000).catch(() => client.destroy()))
            client.on('close', () => {
              if (piped.delete(session)) void hostCall('vncClose', [session]).catch(() => undefined)
            })
            client.resume()
          },
          () => client.destroy()
        )
      })
      const listening = new Promise<Server>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve(server))
      })
      tunnels.set(key, listening)
      listening.catch(() => tunnels.delete(key))
      return listening
    }

    /** The VM's key and the files `ssh` reads, kept in Eaon's own folder (readable only by this user). */
    const sshCommand = async (device: VmDevice, vmId: string): Promise<{ file: string; args: string[] }> => {
      const [{ user, privateKey }, server] = await Promise.all([call(device, 'sshKey', [vmId]) as Promise<VmSshKey>, tunnel(device, vmId)])
      const dir = join(app.getPath('userData'), 'vms-ssh', `${device}-${vmId}`)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const keyFile = join(dir, 'key')
      writeFileSync(keyFile, privateKey, { mode: 0o600 })
      const port = (server.address() as AddressInfo).port
      return {
        file: 'ssh',
        args: [
          '-i',
          keyFile,
          '-o',
          'IdentitiesOnly=yes',
          '-o',
          `UserKnownHostsFile=${join(dir, 'known_hosts')}`,
          // The tunnel's port changes from run to run; the VM's host key doesn't.
          '-o',
          `HostKeyAlias=eaon-vm-${vmId}`,
          '-o',
          'StrictHostKeyChecking=accept-new',
          '-o',
          'ServerAliveInterval=15',
          // Not "Permanently added … to the list of known hosts" as a terminal's first line.
          '-o',
          'LogLevel=ERROR',
          '-p',
          String(port),
          `${user}@127.0.0.1`
        ]
      }
    }

    const quote = (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)

    ctx.ipcMain.handle('vms:term-open', async (event, device: VmDevice, vmId: string, cols: number, rows: number): Promise<VmTerminalSession> => {
      const { file, args } = await sshCommand(device, vmId)
      const id = randomBytes(8).toString('hex')
      const sender = event.sender
      const pty = loadPty().spawn(file, args, {
        name: 'xterm-256color',
        cols: Math.max(20, Math.floor(cols) || 80),
        rows: Math.max(5, Math.floor(rows) || 24),
        cwd: homedir(),
        env: { ...launcherEnv(process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      })
      terminals.set(id, pty)
      // Nothing thrown in node-pty's callbacks may escape (see ptyManager.ts).
      pty.onData((data) => {
        try {
          if (!sender.isDestroyed()) sender.send('vms:term-data', id, data)
        } catch {
          /* never let this reach node-pty's thread-safe function */
        }
      })
      pty.onExit(({ exitCode }) => {
        try {
          terminals.delete(id)
          if (!sender.isDestroyed()) sender.send('vms:term-exit', id, exitCode)
        } catch {
          /* never let this reach node-pty's thread-safe function */
        }
      })
      sender.once('destroyed', () => {
        terminals.get(id)?.kill()
        terminals.delete(id)
      })
      return { session: id, command: [file, ...args].map(quote).join(' ') }
    })
    ctx.ipcMain.on('vms:term-write', (_event, id: string, data: string) => terminals.get(id)?.write(data))
    ctx.ipcMain.on('vms:term-resize', (_event, id: string, cols: number, rows: number) => {
      if (cols > 0 && rows > 0) terminals.get(id)?.resize(Math.floor(cols), Math.floor(rows))
    })
    ctx.ipcMain.handle('vms:term-close', (_event, id: string) => {
      terminals.get(id)?.kill()
      terminals.delete(id)
    })

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
    for (const pty of terminals.values()) pty.kill()
    terminals = new Map()
    for (const server of tunnels.values()) void server.then((s) => s.close()).catch(() => undefined)
    tunnels = new Map()
    await manager?.shutdown({ stopVms: true, resumeLater: false, graceMs: 0 })
  }
}
