import { execFile, spawn } from 'node:child_process'
import { accessSync, closeSync, constants, copyFileSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { VmArch, VmFix, VmRecord } from '@shared/vms'
import type { BackendRun, VmBackendDriver, VmPaths } from './backend'
import { macFor } from './vz'

/**
 * VMs on Linux — a Raspberry Pi, a home server — with QEMU, sped up by KVM
 * when the computer has it (a Pi 4 or 5 does). Guests are the computer's own
 * CPU type; nothing is emulated across architectures, which would be far too
 * slow to use.
 *
 * QEMU runs detached with its screen on a Unix socket (VNC, reachable only
 * by this user) and its control on another (QMP); SSH is forwarded from a
 * port on 127.0.0.1. A VM's disk is a qcow2 overlay on the downloaded image,
 * so ten VMs from one image cost one image plus what each has changed — on a
 * Pi's SD card that matters.
 */

const run = promisify(execFile)

export interface QemuSetup {
  arch: VmArch
  binary: string | null
  img: string | null
  /** UEFI for ARM (x86 cloud images boot with QEMU's own BIOS). */
  firmware: { bios: string } | { code: string; vars: string } | null
  kvm: 'ok' | 'missing' | 'no-access'
}

const firstExisting = (paths: string[]): string | null => paths.find((p) => existsSync(p)) ?? null

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':').concat(['/usr/bin', '/usr/local/bin', '/usr/libexec'])) {
    const full = join(dir, name)
    try {
      accessSync(full, constants.X_OK)
      return full
    } catch {
      /* not here */
    }
  }
  return null
}

export function findQemu(arch: VmArch): QemuSetup {
  const binary = which(arch === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64')
  const bios = firstExisting(['/usr/share/qemu-efi-aarch64/QEMU_EFI.fd', '/usr/share/AAVMF/AAVMF_CODE.no-secboot.fd'])
  const code = firstExisting(['/usr/share/AAVMF/AAVMF_CODE.fd', '/usr/share/edk2/aarch64/QEMU_EFI-pflash.raw', '/usr/share/qemu/edk2-aarch64-code.fd'])
  const vars = firstExisting(['/usr/share/AAVMF/AAVMF_VARS.fd', '/usr/share/edk2/aarch64/vars-template-pflash.raw', '/usr/share/qemu/edk2-arm-vars.fd'])
  let kvm: QemuSetup['kvm'] = 'missing'
  if (existsSync('/dev/kvm')) {
    try {
      accessSync('/dev/kvm', constants.R_OK | constants.W_OK)
      kvm = 'ok'
    } catch {
      kvm = 'no-access'
    }
  }
  return {
    arch,
    binary,
    img: which('qemu-img'),
    firmware: arch === 'x64' ? null : bios ? { bios } : code && vars ? { code, vars } : null,
    kvm
  }
}

/** The package manager this Linux uses, from /etc/os-release. */
function packageManager(): 'apt' | 'dnf' | 'pacman' | null {
  try {
    const release = readFileSync('/etc/os-release', 'utf8')
    const ids = /^(?:ID|ID_LIKE)=(.*)$/gm
    const all = [...release.matchAll(ids)].map((m) => m[1].replace(/"/g, '')).join(' ')
    if (/debian|ubuntu|raspbian/.test(all)) return 'apt'
    if (/fedora|rhel|centos/.test(all)) return 'dnf'
    if (/arch/.test(all)) return 'pacman'
  } catch {
    /* not Linux, or no os-release */
  }
  return null
}

/** What would make this computer able to run VMs, as one command, or null when it already can. */
export function qemuFix(setup: QemuSetup, user: string): VmFix | null {
  const steps: string[] = []
  const missing = !setup.binary || !setup.img || (setup.arch === 'arm64' && !setup.firmware)
  if (missing) {
    const manager = packageManager()
    if (manager === 'apt') steps.push(`sudo apt-get install -y ${setup.arch === 'arm64' ? 'qemu-system-arm qemu-efi-aarch64' : 'qemu-system-x86'} qemu-utils`)
    else if (manager === 'dnf') steps.push(`sudo dnf install -y ${setup.arch === 'arm64' ? 'qemu-system-aarch64-core edk2-aarch64' : 'qemu-system-x86-core'} qemu-img`)
    else if (manager === 'pacman') steps.push(`sudo pacman -S --noconfirm ${setup.arch === 'arm64' ? 'qemu-system-aarch64 edk2-aarch64' : 'qemu-system-x86'} qemu-img`)
    else steps.push('install QEMU with this computer’s package manager')
  }
  if (setup.kvm === 'no-access') steps.push(`sudo usermod -aG kvm ${user}`)
  if (steps.length === 0) return null
  return { label: missing ? 'Install QEMU' : 'Allow KVM', command: steps.join(' && ') }
}

/** QEMU's command line for a VM. Exported for the tests, which check it without running QEMU. */
export function qemuArgs(vm: VmRecord, paths: VmPaths, setup: QemuSetup, options: { sshPort: number; seedUrl?: string }): string[] {
  const kvm = setup.kvm === 'ok'
  const args: string[] = ['-name', `eaon-${vm.id}`]
  if (setup.arch === 'arm64') {
    args.push('-machine', kvm ? 'virt,gic-version=host' : 'virt', '-cpu', kvm ? 'host' : 'max')
    if (setup.firmware && 'bios' in setup.firmware) args.push('-bios', setup.firmware.bios)
    else if (setup.firmware) {
      args.push('-drive', `if=pflash,format=raw,readonly=on,file=${setup.firmware.code}`, '-drive', `if=pflash,format=raw,file=${join(paths.dir, 'efi-vars.fd')}`)
    }
    args.push('-device', 'virtio-gpu-pci,xres=1280,yres=800')
  } else {
    args.push('-machine', 'q35', '-cpu', kvm ? 'host' : 'max', '-vga', 'none', '-device', 'virtio-vga,xres=1280,yres=800')
  }
  args.push(
    '-accel',
    kvm ? 'kvm' : 'tcg,thread=multi',
    '-smp',
    String(vm.cpus),
    '-m',
    String(vm.memoryMB),
    '-drive',
    `if=none,id=disk0,file=${paths.disk},format=qcow2,cache=writeback,discard=unmap`,
    '-device',
    'virtio-blk-pci,drive=disk0',
    '-netdev',
    `user,id=net0,hostfwd=tcp:127.0.0.1:${options.sshPort}-:22`,
    // No option ROM: the guest boots from its disk, and the ROM's package may not be installed.
    '-device',
    `virtio-net-pci,netdev=net0,mac=${macFor(vm.id)},romfile=`,
    '-device',
    'qemu-xhci',
    '-device',
    'usb-kbd',
    // A tablet, not a mouse: VNC says where the pointer is, not how far it moved.
    '-device',
    'usb-tablet',
    '-device',
    'virtio-rng-pci',
    '-device',
    'virtio-balloon-pci',
    '-vnc',
    `unix:${paths.vncSocket}`,
    '-qmp',
    `unix:${paths.qmpSocket},server=on,wait=off`,
    '-serial',
    `file:${paths.console}`,
    '-pidfile',
    join(paths.dir, 'qemu.pid')
  )
  // cloud-init's NoCloud over HTTP; the guest reaches this computer's 127.0.0.1 as 10.0.2.2.
  if (options.seedUrl) args.push('-smbios', `type=1,serial=ds=nocloud;s=${options.seedUrl}`)
  return args
}

/** A free TCP port on 127.0.0.1, for SSH's forward. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

/** One QMP command, on a fresh connection to the VM's control socket. */
export function qmp(socket: string, command: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socket)
    let buffer = ''
    let step = 0
    const timer = setTimeout(() => {
      client.destroy()
      reject(new Error('The VM didn’t answer its control socket.'))
    }, timeoutMs)
    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const message = JSON.parse(line) as { QMP?: unknown; return?: unknown; error?: { desc?: string } }
        if (message.error) {
          clearTimeout(timer)
          client.destroy()
          return reject(new Error(message.error.desc ?? 'The VM refused the command.'))
        }
        if (message.QMP && step === 0) {
          step = 1
          client.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\n')
        } else if (message.return !== undefined && step === 1) {
          step = 2
          client.write(JSON.stringify({ execute: command }) + '\n')
        } else if (message.return !== undefined && step === 2) {
          clearTimeout(timer)
          client.end()
          resolve()
        }
      }
    })
    client.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

interface QemuRun {
  pid: number
  sshPort: number
}

export function createQemuBackend(setup: QemuSetup): VmBackendDriver {
  const stopping = new Set<string>()
  const runFile = (paths: VmPaths): string => join(paths.dir, 'qemu.json')
  const readRun = (paths: VmPaths): QemuRun | null => {
    try {
      return JSON.parse(readFileSync(runFile(paths), 'utf8')) as QemuRun
    } catch {
      return null
    }
  }
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  const pidOf = (paths: VmPaths): number | null => {
    try {
      const pid = Number(readFileSync(join(paths.dir, 'qemu.pid'), 'utf8').trim())
      return pid > 0 && alive(pid) ? pid : null
    } catch {
      return null
    }
  }

  return {
    kind: 'qemu',
    diskFormat: 'qcow2',

    async prepareDisk(vm, paths, image, onProgress) {
      if (!setup.img) throw new Error('qemu-img isn’t installed on this computer.')
      onProgress('Making the disk', null)
      await run(setup.img, ['create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', image, paths.disk, `${vm.diskGB}G`])
      if (setup.firmware && 'vars' in setup.firmware) copyFileSync(setup.firmware.vars, join(paths.dir, 'efi-vars.fd'))
    },

    async start(vm, paths, extra) {
      if (!setup.binary) throw new Error('QEMU isn’t installed on this computer.')
      if (pidOf(paths)) return
      const sshPort = await freePort()
      for (const socket of [paths.vncSocket, paths.qmpSocket]) await rm(socket, { force: true })
      await rm(join(paths.dir, 'qemu.pid'), { force: true })
      const args = qemuArgs(vm, paths, setup, { sshPort, seedUrl: extra.seedUrl })
      const log = openSync(join(paths.dir, 'qemu.log'), 'a')
      const child = spawn(setup.binary, args, { detached: true, stdio: ['ignore', log, log] })
      closeSync(log)
      let exited: number | null = null
      child.once('exit', (code) => (exited = code ?? -1))
      child.unref()
      writeFileSync(runFile(paths), JSON.stringify({ pid: child.pid ?? 0, sshPort } satisfies QemuRun))
      const until = Date.now() + 20_000
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 200))
        if (exited !== null) {
          const tail = readFileSync(join(paths.dir, 'qemu.log'), 'utf8').trim().split('\n').slice(-3).join(' ')
          throw new Error(`QEMU stopped as it started: ${tail || `exit ${exited}`}`)
        }
        if (existsSync(paths.qmpSocket) && pidOf(paths)) return
      }
      throw new Error('QEMU didn’t start in time.')
    },

    async stop(vm, paths, force) {
      const pid = pidOf(paths)
      if (!pid) return
      if (force) {
        await qmp(paths.qmpSocket, 'quit').catch(() => process.kill(pid, 'SIGKILL'))
        return
      }
      stopping.add(vm.id)
      await qmp(paths.qmpSocket, 'system_powerdown').catch(() => undefined)
      // A guest that ignores the power button is stopped anyway.
      setTimeout(() => {
        if (pidOf(paths) === pid) void qmp(paths.qmpSocket, 'quit').catch(() => process.kill(pid, 'SIGKILL'))
      }, 60_000).unref?.()
    },

    status(vm, paths): BackendRun {
      const pid = pidOf(paths)
      if (!pid) {
        stopping.delete(vm.id)
        return { running: false, stopping: false, error: null, vnc: null }
      }
      return { running: true, stopping: stopping.has(vm.id), error: null, vnc: existsSync(paths.vncSocket) ? { kind: 'unix', path: paths.vncSocket, password: null } : null }
    },

    ssh(vm, paths) {
      const state = readRun(paths)
      return state && pidOf(paths) ? { port: state.sshPort } : null
    },

    async snapshot(vm, paths, id) {
      await run(setup.img ?? 'qemu-img', ['snapshot', '-c', id, paths.disk])
      if (existsSync(join(paths.dir, 'efi-vars.fd'))) copyFileSync(join(paths.dir, 'efi-vars.fd'), join(paths.snapshots, `${id}.efi`))
    },

    async restore(vm, paths, id) {
      await run(setup.img ?? 'qemu-img', ['snapshot', '-a', id, paths.disk])
      if (existsSync(join(paths.snapshots, `${id}.efi`))) copyFileSync(join(paths.snapshots, `${id}.efi`), join(paths.dir, 'efi-vars.fd'))
    },

    async deleteSnapshot(vm, paths, id) {
      await run(setup.img ?? 'qemu-img', ['snapshot', '-d', id, paths.disk]).catch(() => undefined)
      await rm(join(paths.snapshots, `${id}.efi`), { force: true })
    }
  }
}
