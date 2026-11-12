import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { connect as netConnect, type Socket } from 'node:net'
import { cpus, tmpdir, totalmem, userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { createServer as createHttpServer } from 'node:http'
import {
  freeVmName,
  linuxImage,
  vmLimits,
  type CreateVmRequest,
  type VmArch,
  type VmChange,
  type VmDevice,
  type VmDeviceInfo,
  type VmExecResult,
  type VmInput,
  type VmLogin,
  type VmPhase,
  type VmRecord,
  type VmScreenshot,
  type VmStatus,
  type VmToolsResult
} from '@shared/vms'
import type { VmBackendDriver, VmPaths, VncTarget } from './backend'
import { fetchVerified, download } from './download'
import { charKeysym, forAppleVnc, needsShift, parseCombo, SHIFT } from './keys'
import { encodePng } from './png'
import { createQemuBackend, findQemu, qemuFix, type QemuSetup } from './qemu'
import { RfbClient } from './rfb'
import { metaData, userData, writeSeedIso, type SeedOptions } from './seed'
import { newSshKey, sshAnswers, sshExec, type SshTarget } from './ssh'
import { createVzBackend, installMacOS, latestMacImage } from './vz'

/**
 * The VM manager one computer runs: the desktop for its own VMs, the worker
 * host for the worker computer's. It keeps each VM in its own folder
 * (vm.json, the disk, its SSH key), makes new ones (download, check, disk,
 * first-boot setup), starts and stops them through the backend this computer
 * has (vz.ts on a Mac, qemu.ts on Linux), watches them come up, and gives
 * agents commands, screenshots, and the mouse and keyboard.
 *
 * The UI and agents get `VmStatus`es through `onChange`; the VM's password
 * only ever leaves through `login`.
 */

const runFile = promisify(execFile)

interface Stored extends VmRecord {
  password: string
  /** Set once the guest first reported ready: after that, a boot is just a boot. */
  setUp: boolean
  /** For QEMU's seed over HTTP, so other programs on this computer can't guess the path. */
  seedToken: string
  hostname: string
  /** Started again when the manager starts (it was running when the host app stopped). */
  resume?: boolean
}

interface Live {
  phase: VmPhase
  progress: VmStatus['progress']
  error: string | null
  ready: boolean
  agentActive: boolean
  abort: AbortController | null
  /** A start is under way: the backend isn't running yet, and that's expected. */
  launching: boolean
}

export interface VmManagerOptions {
  /** Where VMs' folders and the shared image downloads go. */
  root: string
  /** A short folder for sockets (a Unix socket's path is capped at about 104 bytes). */
  socketDir: string
  /** The `eaon-vm` helper (Mac only). */
  helper: string | null
  device: VmDevice
  name: () => string
  onChange: (vms: VmStatus[]) => void
  /** Start VMs marked to keep running when the manager starts (the worker host). */
  autostart?: boolean
  /** For tests: a backend instead of this computer's own. */
  driver?: VmBackendDriver
}

export interface VmManager {
  info: () => Promise<VmDeviceInfo>
  list: () => VmStatus[]
  create: (request: CreateVmRequest) => Promise<VmStatus>
  cancel: (id: string) => Promise<void>
  start: (id: string) => Promise<VmStatus>
  stop: (id: string, force?: boolean) => Promise<VmStatus>
  remove: (id: string) => Promise<void>
  update: (id: string, change: VmChange) => Promise<VmStatus>
  snapshot: (id: string, name?: string) => Promise<VmStatus>
  restore: (id: string, snapshotId: string) => Promise<VmStatus>
  deleteSnapshot: (id: string, snapshotId: string) => Promise<VmStatus>
  login: (id: string) => VmLogin
  exec: (id: string, command: string, timeoutMs?: number) => Promise<VmExecResult>
  screenshot: (id: string) => Promise<VmScreenshot>
  input: (id: string, actions: VmInput[]) => Promise<void>
  /** Where the screen is now, for the live view; null while there's none. */
  vnc: (id: string) => VncTarget | null
  /** Opens a raw connection to the VM's screen for the live view (the viewer does the VNC). */
  openScreen: (id: string) => Promise<{ socket: Socket; password: string | null }>
  setAgentActive: (id: string, active: boolean) => void
  installTools: () => Promise<VmToolsResult>
  /** Shuts down running VMs (asking first, then forcing) and stops watching. */
  shutdown: (options: { stopVms: boolean; resumeLater: boolean; graceMs?: number }) => Promise<void>
}

/** A short, private folder for VMs' sockets (a Unix socket's path is capped near 104 bytes). */
export function defaultSocketDir(): string {
  if (process.platform !== 'darwin' && process.env.XDG_RUNTIME_DIR) return join(process.env.XDG_RUNTIME_DIR, 'eaon-vms')
  return join(tmpdir(), process.platform === 'darwin' ? 'eaon-vms' : `eaon-vms-${userInfo().uid}`)
}

/** The guest's answer to "how is the setup going", from the readiness check below. */
export const SETUP_PROBE =
  "if test -e /run/eaon/ready; then echo ready; else s=$(cloud-init status 2>/dev/null | head -1); echo \"$s\"; " +
  "if [ \"$s\" = 'status: error' ]; then sudo -n grep -hE '^(E:|dpkg: error|.*Error)' /var/log/cloud-init-output.log 2>/dev/null | tail -2 | sed 's/^/why: /'; " +
  "else sudo -n tail -n 80 /var/log/cloud-init-output.log 2>/dev/null | grep -E '^(Setting up|Unpacking|Get:[0-9]+) ' | tail -1; fi; fi"

/** What the first boot is doing, for the list: from cloud-init's status and the package being installed. */
export function setupStep(output: string, desktop: boolean): { ready: boolean; step: string; failed: boolean } {
  if (/^ready$/m.test(output)) return { ready: true, step: '', failed: false }
  const what = desktop ? 'the desktop' : 'Linux'
  if (/status: error/.test(output)) {
    const why = [...output.matchAll(/^why: (.+)$/gm)].map((m) => m[1].trim()).join(' ')
    return { ready: false, step: `Setting up ${what} didn’t finish${why ? `: ${why}` : '.'}`, failed: true }
  }
  if (/status: done/.test(output)) return { ready: false, step: 'Restarting into the finished setup', failed: false }
  const installing = /^(?:Setting up|Unpacking) ([a-z0-9][a-z0-9+.-]*)/m.exec(output)
  if (installing) return { ready: false, step: `Setting up ${what}: installing ${installing[1]}`, failed: false }
  if (/^Get:\d+ /m.test(output)) return { ready: false, step: `Setting up ${what}: downloading packages`, failed: false }
  return { ready: false, step: desktop ? 'Setting up the desktop (a few minutes the first time)' : 'Setting up Linux', failed: false }
}

const archOf = (): VmArch | 'other' => (process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : 'other')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'vm'

export function createVmManager(options: VmManagerOptions): VmManager {
  const { root, socketDir } = options
  const imagesDir = join(root, 'images')
  mkdirSync(imagesDir, { recursive: true })
  mkdirSync(socketDir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(socketDir, 0o700)
  } catch {
    /* someone else's folder: the sockets are still only this user's */
  }

  const arch = archOf()
  let qemuSetup: QemuSetup | null = process.platform === 'linux' && arch !== 'other' ? findQemu(arch) : null
  const makeDriver = (): VmBackendDriver | null => {
    if (options.driver) return options.driver
    if (process.platform === 'darwin' && options.helper && existsSync(options.helper)) return createVzBackend({ helper: options.helper })
    if (qemuSetup) return createQemuBackend(qemuSetup)
    return null
  }
  let driver = makeDriver()

  const vms = new Map<string, Stored>()
  const live = new Map<string, Live>()
  /** Downloads in progress, by file, so two VMs from one image share one download. */
  const downloads = new Map<string, Promise<void>>()
  /** Agents' own screen connections, one per VM. */
  const screens = new Map<string, { client: RfbClient; key: string }>()
  /** One operation at a time per VM: start, stop, snapshot... */
  const queues = new Map<string, Promise<unknown>>()

  const paths = (id: string): VmPaths => {
    const dir = join(root, id)
    return {
      dir,
      disk: join(dir, driver?.diskFormat === 'qcow2' ? 'disk.qcow2' : 'disk.img'),
      seed: join(dir, 'seed.iso'),
      console: join(dir, 'console.log'),
      runFile: join(dir, 'run.json'),
      snapshots: join(dir, 'snapshots'),
      sshSocket: join(socketDir, `${id}.ssh`),
      vncSocket: join(socketDir, `${id}.vnc`),
      qmpSocket: join(socketDir, `${id}.qmp`)
    }
  }

  const save = (vm: Stored): void => {
    const file = join(root, vm.id, 'vm.json')
    writeFileSync(`${file}.tmp`, JSON.stringify(vm, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }

  const liveOf = (id: string): Live => {
    let state = live.get(id)
    if (!state) {
      state = { phase: 'stopped', progress: null, error: null, ready: false, agentActive: false, abort: null, launching: false }
      live.set(id, state)
    }
    return state
  }

  const statusOf = (vm: Stored): VmStatus => {
    const state = liveOf(vm.id)
    const run = driver && !state.abort ? driver.status(vm, paths(vm.id)) : null
    const { password: _password, setUp: _setUp, seedToken: _token, hostname: _hostname, resume: _resume, ...record } = vm
    return {
      ...record,
      device: options.device,
      phase: state.phase,
      progress: state.progress,
      error: state.error,
      ready: state.ready,
      screen: Boolean(run?.vnc),
      agentActive: state.agentActive
    }
  }

  let lastSent = ''
  const changed = (): void => {
    const list = [...vms.values()].sort((a, b) => a.createdAt - b.createdAt).map(statusOf)
    const json = JSON.stringify(list)
    if (json === lastSent) return
    lastSent = json
    options.onChange(list)
  }

  const setPhase = (id: string, phase: VmPhase, extra: Partial<Live> = {}): void => {
    Object.assign(liveOf(id), { phase, ...extra })
    changed()
  }

  const serial = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const next = (queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(work)
    queues.set(id, next)
    return next
  }

  const need = (id: string): Stored => {
    const vm = vms.get(id)
    if (!vm) throw new Error('That VM isn’t here any more.')
    return vm
  }

  const needDriver = (): VmBackendDriver => {
    if (!driver) throw new Error('This computer can’t run VMs.')
    return driver
  }

  /* --------------------------------------------------- the seed, for QEMU */

  let seedServer: { server: ReturnType<typeof createHttpServer>; port: number } | null = null
  const seedOptions = (vm: Stored): SeedOptions => {
    const image = linuxImage(vm.image)
    return {
      id: vm.id,
      hostname: vm.hostname,
      user: vm.user,
      password: vm.password,
      publicKey: readFileSync(join(root, vm.id, 'ssh-key.pub'), 'utf8').trim(),
      distro: image?.distro ?? 'debian',
      arch: vm.arch,
      desktop: vm.desktop,
      vsock: vm.backend === 'vz'
    }
  }
  const seedUrl = async (vm: Stored): Promise<string> => {
    if (!seedServer) {
      const server = createHttpServer((request, response) => {
        const [, id, token, file] = (request.url ?? '').split('/')
        const target = vms.get(id ?? '')
        if (!target || token !== target.seedToken) {
          response.writeHead(404).end()
          return
        }
        const body = file === 'meta-data' ? metaData(seedOptions(target)) : file === 'user-data' ? userData(seedOptions(target)) : ''
        response.writeHead(200, { 'content-type': 'text/plain' }).end(body)
      })
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
      })
      seedServer = { server, port }
    }
    return `http://10.0.2.2:${seedServer.port}/${vm.id}/${vm.seedToken}/`
  }

  /* ------------------------------------------------------------ loading */

  for (const entry of existsSync(root) ? readdirSync(root) : []) {
    const file = join(root, entry, 'vm.json')
    if (entry === 'images' || !existsSync(file)) continue
    try {
      const vm = JSON.parse(readFileSync(file, 'utf8')) as Stored
      vms.set(vm.id, vm)
      if (existsSync(join(root, entry, '.preparing'))) {
        setPhase(vm.id, 'error', { error: 'Making this VM was interrupted. Delete it and make it again.' })
      } else {
        const run = driver?.status(vm, paths(vm.id))
        setPhase(vm.id, run?.running ? 'starting' : 'stopped')
      }
    } catch (error) {
      console.warn(`[vms] ${entry}: ${errorText(error)}`)
    }
  }

  /* ----------------------------------------------------------- watching */

  const watchOnce = async (): Promise<void> => {
    if (!driver) return
    for (const vm of vms.values()) {
      const state = liveOf(vm.id)
      if (state.abort || state.phase === 'error' || state.phase === 'preparing' || state.phase === 'installing') continue
      if (state.launching) continue
      const run = driver.status(vm, paths(vm.id))
      if (!run.running) {
        if (state.phase !== 'stopped') {
          setPhase(vm.id, run.error ? 'error' : 'stopped', { ready: false, progress: null, error: run.error })
          dropScreen(vm.id)
        }
        continue
      }
      if (run.stopping) {
        if (state.phase !== 'stopping') setPhase(vm.id, 'stopping', { ready: false })
        continue
      }
      if (vm.os !== 'linux') {
        if (state.phase !== 'running') setPhase(vm.id, 'running', { progress: null, error: null })
        continue
      }
      // Linux: ready once SSH answers and the guest says its setup is done.
      if (state.ready && state.phase === 'running') continue
      const target = sshTarget(vm)
      if (!target) continue
      const result = await sshExec(target, SETUP_PROBE, { timeoutMs: 10_000, connectTimeout: 3 }).catch(() => null)
      const answered = result !== null && result.exitCode === 0
      const setup = setupStep(answered ? result.stdout : '', vm.desktop)
      if (setup.ready) {
        if (!vm.setUp) {
          vm.setUp = true
          save(vm)
        }
        setPhase(vm.id, 'running', { ready: true, progress: null, error: null })
      } else if (!vm.setUp) {
        // A failed setup still leaves a VM to look into: say so, and keep it running.
        setPhase(vm.id, 'setting-up', { progress: { step: setup.step, fraction: null }, error: setup.failed ? setup.step : null })
      } else if (state.phase !== 'starting') {
        setPhase(vm.id, 'starting')
      }
    }
    changed()
  }

  let watching = false
  const watcher = setInterval(() => {
    if (watching) return
    watching = true
    void watchOnce()
      .catch((error) => console.warn('[vms] watch:', errorText(error)))
      .finally(() => (watching = false))
  }, 2000)
  watcher.unref?.()

  /* ----------------------------------------------------------- info */

  let helperCheck: { supported?: boolean; arch?: string; macos?: string } | null = null
  const checkHelper = async (): Promise<typeof helperCheck> => {
    if (helperCheck || !options.helper || !existsSync(options.helper)) return helperCheck
    try {
      const { stdout } = await runFile(options.helper, ['check'], { timeout: 15_000 })
      helperCheck = JSON.parse(stdout.trim().split('\n').pop() ?? '{}')
    } catch {
      helperCheck = { supported: false }
    }
    return helperCheck
  }

  const diskFreeMB = (): number | null => {
    try {
      const fs = statfsSync(root)
      return Math.floor((fs.bavail * fs.bsize) / 1024 / 1024)
    } catch {
      return null
    }
  }

  const NO_WINDOWS = 'Windows VMs aren’t here yet. They’re coming in a later version of Eaon.'
  const NO_MACOS = 'macOS VMs only run on a Mac with Apple silicon: Apple allows them on its own hardware, and its VMs need its chips.'

  const info = async (): Promise<VmDeviceInfo> => {
    const base = {
      platform: process.platform,
      arch,
      cpus: cpus().length,
      memoryMB: Math.floor(totalmem() / 1024 / 1024),
      diskFreeMB: diskFreeMB(),
      name: options.name()
    }
    if (arch === 'other') {
      const reason = 'VMs need a 64-bit system on this computer.'
      return { ...base, backend: null, accel: 'none', os: { linux: { available: false, reason }, macos: { available: false, reason }, windows: { available: false, reason } } }
    }
    if (process.platform === 'darwin') {
      const check = await checkHelper()
      const supported = Boolean(check?.supported)
      const [major] = String(check?.macos ?? '0').split('.').map(Number)
      const linux = !options.helper || !existsSync(options.helper)
        ? { available: false, reason: 'This copy of Eaon is missing its VM helper.' }
        : !supported
          ? { available: false, reason: 'This Mac can’t run VMs (virtualization isn’t available).' }
          : major < 13
            ? { available: false, reason: 'Linux VMs need macOS 13 or later.' }
            : { available: true }
      const macos = arch !== 'arm64' ? { available: false, reason: NO_MACOS } : supported ? { available: true } : { available: false, reason: 'This Mac can’t run VMs.' }
      return { ...base, backend: driver ? 'vz' : null, accel: supported ? 'vz' : 'none', os: { linux, macos, windows: { available: false, reason: NO_WINDOWS } } }
    }
    if (process.platform === 'linux' && qemuSetup) {
      qemuSetup = findQemu(arch)
      const fix = qemuFix(qemuSetup, userInfo().username)
      const installed = Boolean(qemuSetup.binary && qemuSetup.img && (arch === 'x64' || qemuSetup.firmware))
      const linux = !installed
        ? { available: false, reason: 'QEMU, which runs VMs on Linux, isn’t installed here.', fix: fix ?? undefined }
        : qemuSetup.kvm === 'ok'
          ? { available: true }
          : qemuSetup.kvm === 'no-access'
            ? { available: true, reason: 'Eaon can’t use KVM here yet, so VMs would be slow.', fix: fix ?? undefined }
            : { available: true, reason: 'This computer has no KVM, so VMs run slowly.' }
      return {
        ...base,
        backend: 'qemu',
        accel: qemuSetup.kvm === 'ok' ? 'kvm' : 'none',
        os: { linux, macos: { available: false, reason: NO_MACOS }, windows: { available: false, reason: NO_WINDOWS } }
      }
    }
    const reason = 'This computer can’t run VMs yet. Link a worker computer (a Mac, a Linux PC or a Raspberry Pi) in Settings → Workers to run them there.'
    return { ...base, backend: null, accel: 'none', os: { linux: { available: false, reason }, macos: { available: false, reason: NO_MACOS }, windows: { available: false, reason: NO_WINDOWS } } }
  }

  /* ---------------------------------------------------------- creating */

  const shared = (file: string, work: () => Promise<void>): Promise<void> => {
    const running = downloads.get(file)
    if (running) return running
    const next = work().finally(() => downloads.delete(file))
    downloads.set(file, next)
    return next
  }

  const prepareLinux = async (vm: Stored, signal: AbortSignal): Promise<void> => {
    const image = linuxImage(vm.image)
    if (!image) throw new Error('That Linux version isn’t one Eaon knows.')
    const backend = needDriver()
    const url = image.urls[vm.arch]
    const file = join(imagesDir, basename(new URL(url).pathname))
    const progress = (step: string, fraction: number | null): void =>
      setPhase(vm.id, 'preparing', { progress: { step: step === 'Downloading' ? `Downloading ${image.name}` : step, fraction } })
    await shared(file, () => fetchVerified(url, file, image.sums, { signal, onProgress: progress }))
    const p = paths(vm.id)
    await backend.prepareDisk(vm, p, file, (step, fraction) => setPhase(vm.id, 'preparing', { progress: { step, fraction } }), signal)
    if (backend.kind === 'vz') await writeSeedIso(p.seed, seedOptions(vm))
  }

  const prepareMac = async (vm: Stored, ipsw: string | undefined, signal: AbortSignal): Promise<void> => {
    if (!options.helper) throw new Error('This copy of Eaon is missing its VM helper.')
    let file = ipsw
    if (!file) {
      setPhase(vm.id, 'preparing', { progress: { step: 'Asking Apple for the newest macOS', fraction: null } })
      const latest = await latestMacImage(options.helper)
      vm.version = `macOS ${latest.version}`
      save(vm)
      file = join(imagesDir, basename(new URL(latest.url).pathname))
      const target = file
      await shared(target, () =>
        existsSync(target)
          ? Promise.resolve()
          : download(latest.url, target, { signal, onProgress: (p) => setPhase(vm.id, 'preparing', { progress: { step: `Downloading ${vm.version}`, fraction: p.total ? p.received / p.total : null } }) })
      )
    } else if (!existsSync(file)) {
      throw new Error('That restore image isn’t on this computer.')
    }
    const p = paths(vm.id)
    const disk = await open(p.disk, 'w')
    await disk.truncate(vm.diskGB * 1024 ** 3)
    await disk.close()
    setPhase(vm.id, 'installing', { progress: { step: `Installing ${vm.version}`, fraction: 0 } })
    await installMacOS(options.helper, vm, p, file, (fraction) => setPhase(vm.id, 'installing', { progress: { step: `Installing ${vm.version}`, fraction } }), signal)
  }

  const create = async (request: CreateVmRequest): Promise<VmStatus> => {
    const device = await info()
    const support = device.os[request.os]
    if (!support?.available) throw new Error(support?.reason ?? 'This computer can’t run that.')
    const backend = needDriver()
    if (device.arch === 'other') throw new Error('VMs need a 64-bit system.')
    const limits = vmLimits(device, request.os, request.desktop)
    const within = (value: number, range: { min: number; max: number }): number => Math.max(range.min, Math.min(range.max, Math.round(value)))
    const image = request.os === 'linux' ? linuxImage(request.image) : null
    if (request.os === 'linux' && !image) throw new Error('That Linux version isn’t one Eaon knows.')
    const id = randomBytes(4).toString('hex')
    const name = freeVmName(request.name.trim() || (image ? image.name.split(' ')[0] : 'macOS'), [...vms.values()].map((v) => v.name))
    const vm: Stored = {
      id,
      name,
      os: request.os,
      image: request.image,
      version: image ? image.name : request.image === 'macos-file' ? 'macOS' : 'macOS (newest)',
      desktop: request.os === 'macos' ? true : request.desktop,
      cpus: within(request.cpus, limits.cpus),
      memoryMB: within(request.memoryMB, limits.memoryMB),
      diskGB: within(request.diskGB, limits.diskGB),
      agents: request.agents,
      backend: backend.kind,
      arch: device.arch,
      createdAt: Date.now(),
      user: 'eaon',
      snapshots: [],
      keepRunning: options.device === 'host',
      password: randomBytes(9).toString('base64url'),
      setUp: false,
      seedToken: randomBytes(16).toString('hex'),
      hostname: slug(name)
    }
    const dir = join(root, id)
    mkdirSync(join(dir, 'snapshots'), { recursive: true })
    writeFileSync(join(dir, '.preparing'), '')
    if (vm.os === 'linux') {
      const key = newSshKey(`eaon-${id}`)
      writeFileSync(join(dir, 'ssh-key'), key.privateKey, { mode: 0o600 })
      writeFileSync(join(dir, 'ssh-key.pub'), key.publicKey + '\n')
    }
    vms.set(id, vm)
    save(vm)
    const abort = new AbortController()
    setPhase(id, 'preparing', { progress: { step: 'Getting ready', fraction: null }, abort, error: null })
    void (async () => {
      try {
        if (vm.os === 'linux') await prepareLinux(vm, abort.signal)
        else await prepareMac(vm, request.ipsw, abort.signal)
        await rm(join(dir, '.preparing'), { force: true })
        setPhase(id, 'stopped', { progress: null, abort: null })
        await start(id)
      } catch (error) {
        if (abort.signal.aborted) return
        setPhase(id, 'error', { error: errorText(error), progress: null, abort: null })
      }
    })()
    return statusOf(vm)
  }

  const cancel = async (id: string): Promise<void> => {
    liveOf(id).abort?.abort()
    await remove(id)
  }

  /* --------------------------------------------------------- lifecycle */

  const sshTarget = (vm: Stored): SshTarget | null => {
    const route = driver?.ssh(vm, paths(vm.id))
    if (!route) return null
    return { route, user: vm.user, keyFile: join(root, vm.id, 'ssh-key'), knownHosts: join(root, vm.id, 'known_hosts') }
  }

  const start = (id: string): Promise<VmStatus> =>
    serial(id, async () => {
      const vm = need(id)
      const backend = needDriver()
      const state = liveOf(id)
      if (state.abort) throw new Error('This VM is still being made.')
      if (existsSync(join(root, id, '.preparing'))) throw new Error('Making this VM didn’t finish. Delete it and make it again.')
      setPhase(id, 'starting', { error: null, ready: false, progress: null, launching: true })
      try {
        await backend.start(vm, paths(id), { seedUrl: backend.kind === 'qemu' && vm.os === 'linux' ? await seedUrl(vm) : undefined, seed: !vm.setUp })
      } catch (error) {
        setPhase(id, 'error', { error: errorText(error), launching: false })
        throw error
      }
      state.launching = false
      void watchOnce().catch(() => undefined)
      return statusOf(vm)
    })

  const stop = (id: string, force = false): Promise<VmStatus> =>
    serial(id, async () => {
      const vm = need(id)
      dropScreen(id)
      await needDriver().stop(vm, paths(id), force)
      setPhase(id, force ? 'stopped' : 'stopping', { ready: false })
      return statusOf(vm)
    })

  const waitStopped = async (vm: Stored, ms: number): Promise<boolean> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (!driver?.status(vm, paths(vm.id)).running) return true
      await sleep(300)
    }
    return false
  }

  const remove = async (id: string): Promise<void> => {
    const vm = vms.get(id)
    if (!vm) return
    liveOf(id).abort?.abort()
    await serial(id, async () => {
      dropScreen(id)
      if (driver?.status(vm, paths(id)).running) {
        await driver.stop(vm, paths(id), true)
        await waitStopped(vm, 10_000)
      }
      const p = paths(id)
      await rm(p.dir, { recursive: true, force: true })
      for (const socket of [p.sshSocket, p.vncSocket, p.qmpSocket]) await rm(socket, { force: true })
    })
    vms.delete(id)
    live.delete(id)
    queues.delete(id)
    changed()
  }

  const requireStopped = (vm: Stored, action: string): void => {
    if (driver?.status(vm, paths(vm.id)).running) throw new Error(`Turn ${vm.name} off to ${action}.`)
  }

  const update = (id: string, change: VmChange): Promise<VmStatus> =>
    serial(id, async () => {
      const vm = need(id)
      if (change.name !== undefined) {
        const name = change.name.trim()
        if (!name) throw new Error('A VM needs a name.')
        vm.name = freeVmName(name, [...vms.values()].filter((v) => v.id !== id).map((v) => v.name))
      }
      if (change.agents !== undefined) vm.agents = change.agents
      if (change.keepRunning !== undefined) vm.keepRunning = change.keepRunning
      if (change.cpus !== undefined || change.memoryMB !== undefined) {
        requireStopped(vm, 'change its size')
        const limits = vmLimits(await info(), vm.os, vm.desktop)
        if (change.cpus !== undefined) vm.cpus = Math.max(limits.cpus.min, Math.min(limits.cpus.max, Math.round(change.cpus)))
        if (change.memoryMB !== undefined) vm.memoryMB = Math.max(limits.memoryMB.min, Math.min(limits.memoryMB.max, Math.round(change.memoryMB)))
      }
      save(vm)
      changed()
      return statusOf(vm)
    })

  const snapshot = (id: string, name?: string): Promise<VmStatus> =>
    serial(id, async () => {
      const vm = need(id)
      requireStopped(vm, 'take a snapshot')
      const snapshotId = randomBytes(4).toString('hex')
      await needDriver().snapshot(vm, paths(id), snapshotId)
      vm.snapshots.push({ id: snapshotId, name: name?.trim() || `Snapshot ${vm.snapshots.length + 1}`, at: Date.now() })
      save(vm)
      changed()
      return statusOf(vm)
    })

  const restore = (id: string, snapshotId: string): Promise<VmStatus> =>
    serial(id, async () => {
      const vm = need(id)
      requireStopped(vm, 'go back to a snapshot')
      if (!vm.snapshots.some((s) => s.id === snapshotId)) throw new Error('That snapshot isn’t here any more.')
      await needDriver().restore(vm, paths(id), snapshotId)
      changed()
      return statusOf(vm)
    })

  const deleteSnapshot = (id: string, snapshotId: string): Promise<VmStatus> =>
    serial(id, async () => {
      const vm = need(id)
      requireStopped(vm, 'delete a snapshot')
      await needDriver().deleteSnapshot(vm, paths(id), snapshotId)
      vm.snapshots = vm.snapshots.filter((s) => s.id !== snapshotId)
      save(vm)
      changed()
      return statusOf(vm)
    })

  /* ---------------------------------------------------------- agents */

  const exec = async (id: string, command: string, timeoutMs = 120_000): Promise<VmExecResult> => {
    const vm = need(id)
    if (vm.os !== 'linux') throw new Error(`Commands can’t be run in ${vm.name}: it has no SSH Eaon can reach. Use its screen instead.`)
    const target = sshTarget(vm)
    if (!target) throw new Error(`${vm.name} is off. Start it first.`)
    if (!liveOf(id).ready && !(await sshAnswers(target))) throw new Error(`${vm.name} is still starting up.`)
    return sshExec(target, command, { timeoutMs })
  }

  const dropScreen = (id: string): void => {
    screens.get(id)?.client.close()
    screens.delete(id)
  }

  const connectScreen = async (target: VncTarget): Promise<Socket> => {
    const socket = target.kind === 'tcp' ? netConnect(target.port, '127.0.0.1') : netConnect(target.path)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    return socket
  }

  const screenFor = async (id: string): Promise<RfbClient> => {
    const vm = need(id)
    const target = driver?.status(vm, paths(id)).vnc
    if (!target) throw new Error(`${vm.name}’s screen isn’t available${driver?.status(vm, paths(id)).running ? ' yet' : ': it’s off'}.`)
    const key = JSON.stringify(target)
    const cached = screens.get(id)
    if (cached && cached.key === key && cached.client.isOpen) return cached.client
    cached?.client.close()
    const client = await RfbClient.connect(await connectScreen(target), target.password)
    screens.set(id, { client, key })
    return client
  }

  const screenshot = async (id: string): Promise<VmScreenshot> => {
    const shot = await (await screenFor(id)).screenshot()
    return { png: encodePng(shot.width, shot.height, shot.rgba).toString('base64'), width: shot.width, height: shot.height }
  }

  const input = async (id: string, actions: VmInput[]): Promise<void> => {
    const screen = await screenFor(id)
    const tap = async (keysym: number): Promise<void> => {
      screen.key(keysym, true)
      screen.key(keysym, false)
    }
    for (const action of actions) {
      switch (action.type) {
        case 'move':
          screen.pointer(action.x, action.y, 0)
          break
        case 'click': {
          const mask = action.button === 'right' ? 4 : action.button === 'middle' ? 2 : 1
          screen.pointer(action.x, action.y, 0)
          await sleep(30)
          for (let i = 0; i < Math.max(1, Math.min(3, action.count ?? 1)); i++) {
            screen.pointer(action.x, action.y, mask)
            await sleep(40)
            screen.pointer(action.x, action.y, 0)
            await sleep(60)
          }
          break
        }
        case 'drag': {
          const [fx, fy] = action.from
          const [tx, ty] = action.to
          screen.pointer(fx, fy, 0)
          await sleep(40)
          screen.pointer(fx, fy, 1)
          for (let step = 1; step <= 12; step++) {
            await sleep(25)
            screen.pointer(fx + ((tx - fx) * step) / 12, fy + ((ty - fy) * step) / 12, 1)
          }
          await sleep(40)
          screen.pointer(tx, ty, 0)
          break
        }
        case 'scroll': {
          screen.pointer(action.x, action.y, 0)
          const notches = (count: number, up: number, down: number): Array<number> => Array.from({ length: Math.min(30, Math.abs(Math.round(count))) }, () => (count < 0 ? up : down))
          for (const mask of [...notches(action.dy, 8, 16), ...notches(action.dx ?? 0, 32, 64)]) {
            screen.pointer(action.x, action.y, mask)
            screen.pointer(action.x, action.y, 0)
            await sleep(15)
          }
          break
        }
        case 'type':
          for (const char of action.text) {
            const shift = needsShift(char)
            if (shift) screen.key(SHIFT, true)
            await tap(charKeysym(char))
            if (shift) screen.key(SHIFT, false)
            await sleep(8)
          }
          break
        case 'key': {
          const keys = parseCombo(action.keys).map((key) => (driver?.kind === 'vz' ? forAppleVnc(key) : key))
          for (const key of keys) screen.key(key, true)
          await sleep(30)
          for (const key of [...keys].reverse()) screen.key(key, false)
          break
        }
      }
    }
  }

  const openScreen = async (id: string): Promise<{ socket: Socket; password: string | null }> => {
    const vm = need(id)
    const target = driver?.status(vm, paths(id)).vnc
    if (!target) throw new Error(`${vm.name}’s screen isn’t available.`)
    return { socket: await connectScreen(target), password: target.password }
  }

  /* ------------------------------------------------------------- tools */

  const installTools = async (): Promise<VmToolsResult> => {
    if (process.platform !== 'linux' || !qemuSetup) return { ok: true, command: '', output: '' }
    const fix = qemuFix(qemuSetup, userInfo().username)
    if (!fix) return { ok: true, command: '', output: '' }
    const sudo = await runFile('sudo', ['-n', 'true'], { timeout: 10_000 }).then(
      () => true,
      () => false
    )
    if (!sudo) return { ok: false, needsPassword: true, command: fix.command, output: '' }
    const before = qemuSetup.kvm
    try {
      const { stdout, stderr } = await runFile('sh', ['-c', fix.command.replace(/\bsudo /g, 'sudo -n ')], { timeout: 15 * 60_000, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }, maxBuffer: 16 * 1024 * 1024 })
      qemuSetup = findQemu(qemuSetup.arch)
      driver = makeDriver()
      changed()
      return { ok: true, command: fix.command, output: (stdout + stderr).slice(-4000), restartNeeded: before === 'no-access' && fix.command.includes('usermod') }
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string }
      return { ok: false, command: fix.command, output: `${failure.stdout ?? ''}${failure.stderr ?? failure.message ?? ''}`.slice(-4000) }
    }
  }

  /* ---------------------------------------------------------- shutting down */

  const shutdown = async (request: { stopVms: boolean; resumeLater: boolean; graceMs?: number }): Promise<void> => {
    clearInterval(watcher)
    for (const id of screens.keys()) dropScreen(id)
    seedServer?.server.close()
    if (!request.stopVms || !driver) return
    const running = [...vms.values()].filter((vm) => driver?.status(vm, paths(vm.id)).running)
    for (const vm of running) {
      if (request.resumeLater) {
        vm.resume = true
        save(vm)
      }
      await driver.stop(vm, paths(vm.id), false).catch(() => undefined)
    }
    const grace = request.graceMs ?? 20_000
    // Asked, not waited for: the helper finishes the shutdown on its own.
    if (grace === 0) return
    await Promise.all(
      running.map(async (vm) => {
        if (!(await waitStopped(vm, grace))) await driver?.stop(vm, paths(vm.id), true).catch(() => undefined)
      })
    )
  }

  if (options.autostart) {
    const due = (): Stored[] => [...vms.values()].filter((vm) => (vm.keepRunning || vm.resume) && liveOf(vm.id).phase === 'stopped')
    setTimeout(async () => {
      // At boot the host can start before the desktop login that gives its user KVM (a Pi that
      // logs itself in); a VM started then would run without it, so give that login two minutes.
      for (let i = 0; i < 24 && due().length > 0 && qemuSetup?.kvm === 'no-access'; i++) {
        await new Promise((r) => setTimeout(r, 5000))
        qemuSetup = findQemu(qemuSetup.arch)
      }
      for (const vm of due()) {
        if (vm.resume) {
          vm.resume = false
          save(vm)
        }
        void start(vm.id).catch((error) => console.warn(`[vms] ${vm.name} didn’t start:`, errorText(error)))
      }
    }, 1000).unref?.()
  }

  return {
    info,
    list: () => [...vms.values()].sort((a, b) => a.createdAt - b.createdAt).map(statusOf),
    create,
    cancel,
    start,
    stop,
    remove,
    update,
    snapshot,
    restore,
    deleteSnapshot,
    login: (id) => {
      const vm = need(id)
      return { user: vm.user, password: vm.password }
    },
    exec,
    screenshot,
    input,
    vnc: (id) => {
      const vm = vms.get(id)
      return vm && driver ? driver.status(vm, paths(id)).vnc : null
    },
    openScreen,
    setAgentActive: (id, active) => {
      if (!vms.has(id)) return
      liveOf(id).agentActive = active
      changed()
    },
    installTools,
    shutdown
  }
}
