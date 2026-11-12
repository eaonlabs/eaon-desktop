import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import type { VmRecord } from '@shared/vms'
import { qcow2ToRaw } from './qcow2'
import { VSOCK_SSH_PORT } from './seed'
import type { BackendRun, VmBackendDriver, VmPaths } from './backend'

/**
 * VMs on a Mac: Apple's Virtualization framework, through the `eaon-vm`
 * helper. The helper runs detached, so a VM outlives an Eaon restart; it
 * says how the VM is in run.json, and listens for SIGTERM (shut down) and
 * SIGINT (stop now). Disks are raw files, sparse on APFS, and a snapshot is
 * an APFS clone of them: instant, and free until the VM writes.
 */

const run = promisify(execFile)

interface RunState {
  pid: number
  state: 'starting' | 'running' | 'stopping' | 'stopped'
  vncPort: number
  reason?: string
  error?: string
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A MAC address in QEMU's and Apple's local range, the same for a VM every time it starts. */
export const macFor = (id: string): string => {
  const hex = id.replace(/[^0-9a-f]/gi, '').toLowerCase().padEnd(6, '0').slice(0, 6)
  return `52:54:00:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}`
}

export function createVzBackend(options: { helper: string }): VmBackendDriver {
  const helper = options.helper
  /** VNC passwords, by VM, for the run in progress (a new one each start). */
  const passwords = new Map<string, string>()

  const readRun = (paths: VmPaths): RunState | null => {
    try {
      return JSON.parse(readFileSync(paths.runFile, 'utf8')) as RunState
    } catch {
      return null
    }
  }

  const configFor = (vm: VmRecord, paths: VmPaths, password: string, seed: boolean): Record<string, unknown> => {
    const common = {
      kind: vm.os === 'macos' ? 'macos' : 'linux',
      cpus: vm.cpus,
      memoryMB: vm.memoryMB,
      disk: paths.disk,
      macAddress: macFor(vm.id),
      width: vm.os === 'macos' ? 1440 : 1280,
      height: vm.os === 'macos' ? 900 : 800,
      vncPassword: password,
      console: paths.console
    }
    return vm.os === 'macos'
      ? { ...common, machineId: join(paths.dir, 'machine-id'), hardwareModel: join(paths.dir, 'hardware-model'), auxStorage: join(paths.dir, 'aux.img') }
      : {
          ...common,
          // Only until it's set up: afterwards the guest would show the ISO as a disk on its desktop.
          ...(seed ? { seed: paths.seed } : {}),
          efiStore: join(paths.dir, 'efi.vars'),
          setupLog: join(paths.dir, 'setup.log'),
          machineId: join(paths.dir, 'machine-id'),
          bridges: [{ socket: paths.sshSocket, port: VSOCK_SSH_PORT }]
        }
  }

  const driver: VmBackendDriver = {
    kind: 'vz',
    diskFormat: 'raw',

    async prepareDisk(vm, paths, image, onProgress, signal) {
      // Linux from a qcow2 cloud image: written out raw, grown to the VM's size.
      await qcow2ToRaw(image, paths.disk, {
        minSize: vm.diskGB * 1024 ** 3,
        signal,
        onProgress: (p) => onProgress('Making the disk', p.done / p.total)
      })
    },

    async start(vm, paths, extra) {
      if (!existsSync(helper)) throw new Error('This copy of Eaon is missing its VM helper (eaon-vm).')
      const current = readRun(paths)
      if (current && current.state !== 'stopped' && alive(current.pid)) return
      // macOS's VNC password is read as eight characters at most.
      const password = randomBytes(6).toString('base64url').slice(0, 8)
      passwords.set(vm.id, password)
      const configFile = join(paths.dir, 'config.json')
      writeFileSync(configFile, JSON.stringify(configFor(vm, paths, password, extra.seed !== false)), { mode: 0o600 })
      await rm(paths.runFile, { force: true })
      const log = openSync(join(paths.dir, 'helper.log'), 'a')
      const child = spawn(helper, ['run', configFile], { detached: true, stdio: ['ignore', log, log] })
      closeSync(log)
      child.unref()
      // Wait for the helper to say the VM is up (or why it isn't).
      const until = Date.now() + 30_000
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 250))
        const state = readRun(paths)
        if (state?.state === 'running') return
        if (state?.state === 'stopped') throw new Error(state.error ?? 'The VM stopped as it started.')
      }
      throw new Error('The VM didn’t start in time.')
    },

    async stop(vm, paths, force) {
      const state = readRun(paths)
      if (!state || state.state === 'stopped' || !alive(state.pid)) return
      process.kill(state.pid, force ? 'SIGINT' : 'SIGTERM')
    },

    status(vm, paths): BackendRun {
      const state = readRun(paths)
      if (!state || !alive(state.pid) || state.state === 'stopped') {
        return { running: false, stopping: false, error: state?.state === 'stopped' && state.reason === 'error' ? (state.error ?? null) : null, vnc: null }
      }
      // A helper left from before an Eaon restart has a password this process never knew: the screen comes back on its next start.
      const password = passwords.get(vm.id) ?? readConfigPassword(paths)
      return {
        running: state.state !== 'starting',
        stopping: state.state === 'stopping',
        error: null,
        vnc: state.vncPort > 0 && password ? { kind: 'tcp', port: state.vncPort, password } : null
      }
    },

    ssh(vm, paths) {
      return vm.os === 'linux' ? { socket: paths.sshSocket } : null
    },

    async snapshot(vm, paths, id) {
      await run('cp', ['-c', paths.disk, join(paths.snapshots, `${id}.img`)])
      if (existsSync(join(paths.dir, 'efi.vars'))) await copyFile(join(paths.dir, 'efi.vars'), join(paths.snapshots, `${id}.efi`))
      if (existsSync(join(paths.dir, 'aux.img'))) await run('cp', ['-c', join(paths.dir, 'aux.img'), join(paths.snapshots, `${id}.aux`)])
    },

    async restore(vm, paths, id) {
      await run('cp', ['-c', join(paths.snapshots, `${id}.img`), paths.disk])
      if (existsSync(join(paths.snapshots, `${id}.efi`))) await copyFile(join(paths.snapshots, `${id}.efi`), join(paths.dir, 'efi.vars'))
      if (existsSync(join(paths.snapshots, `${id}.aux`))) await run('cp', ['-c', join(paths.snapshots, `${id}.aux`), join(paths.dir, 'aux.img')])
    },

    async deleteSnapshot(vm, paths, id) {
      for (const ext of ['img', 'efi', 'aux']) await rm(join(paths.snapshots, `${id}.${ext}`), { force: true })
    }
  }

  function readConfigPassword(paths: VmPaths): string | null {
    try {
      const config = JSON.parse(readFileSync(join(paths.dir, 'config.json'), 'utf8')) as { vncPassword?: string }
      return config.vncPassword ?? null
    } catch {
      return null
    }
  }

  return driver
}

/* -------------------------------------------------------------- macOS */

export interface MacRestoreImage {
  url: string
  build: string
  version: string
}

/** The newest macOS this Mac can run in a VM, as Apple lists it. */
export async function latestMacImage(helper: string): Promise<MacRestoreImage> {
  const { stdout } = await run(helper, ['macos-latest'], { timeout: 60_000 })
  const line = stdout.trim().split('\n').pop() ?? '{}'
  const parsed = JSON.parse(line) as Partial<MacRestoreImage> & { error?: string }
  if (parsed.error || !parsed.url) throw new Error(parsed.error ?? 'Apple didn’t say which macOS to download.')
  return parsed as MacRestoreImage
}

/** Installs macOS from `ipsw` onto the VM's (already made, empty) disk, reporting how far along it is. */
export function installMacOS(helper: string, vm: VmRecord, paths: VmPaths, ipsw: string, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  const config = {
    kind: 'macos',
    cpus: vm.cpus,
    memoryMB: vm.memoryMB,
    disk: paths.disk,
    macAddress: macFor(vm.id),
    width: 1440,
    height: 900,
    vncPassword: 'unused',
    machineId: join(paths.dir, 'machine-id'),
    hardwareModel: join(paths.dir, 'hardware-model'),
    auxStorage: join(paths.dir, 'aux.img')
  }
  const configFile = join(paths.dir, 'install.json')
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 })
  return new Promise((resolve, reject) => {
    const child = spawn(helper, ['macos-install', configFile, ipsw], { stdio: ['ignore', 'pipe', 'pipe'] })
    let failure: string | null = null
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const event = JSON.parse(line) as { event?: string; progress?: number; error?: string }
          if (event.event === 'installing' && typeof event.progress === 'number') onProgress(event.progress)
          if (event.event === 'error') failure = event.error ?? 'macOS didn’t install.'
        } catch {
          /* not one of ours */
        }
      }
    })
    const abort = (): void => {
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (code === 0) resolve()
      else reject(new Error(signal?.aborted ? 'Stopped.' : (failure ?? `macOS didn’t install (the helper ended with ${code}).`)))
    })
  })
}
