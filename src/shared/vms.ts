/**
 * Virtual machines: whole computers (Linux, macOS) that Eaon runs on this
 * computer or on the linked worker computer, for the user to use and for
 * agents to work in, Devin-style, without touching the real machine.
 *
 * A Mac runs them with Apple's Virtualization framework (the `eaon-vm`
 * helper, native/vm-mac); a Linux computer, a Raspberry Pi among them, with
 * QEMU and KVM. `main/vms/` is the manager both run, `features/vms.ts` the
 * desktop's side, and the Computers page the UI. Everything here is plain
 * data shared by all of them.
 */

export type VmOs = 'linux' | 'macos' | 'windows'
export type VmBackend = 'vz' | 'qemu'
/** Where a VM lives: this computer, or the linked worker computer. */
export type VmDevice = 'local' | 'host'
export type VmArch = 'arm64' | 'x64'

/** A version of an OS that can be picked for a new VM. */
export interface VmImage {
  id: string
  os: VmOs
  name: string
  /** One line under the name: support window, size. */
  detail: string
  /** The one picked unless the user picks another. */
  recommended?: boolean
}

/** A Linux cloud image: where it comes from for each CPU, and the file that vouches for it. */
export interface LinuxImage extends VmImage {
  os: 'linux'
  distro: 'ubuntu' | 'debian'
  urls: Record<VmArch, string>
  /** The checksums file next to the images, and its hash. */
  sums: { url: string; algorithm: 'sha256' | 'sha512' }
}

export const LINUX_IMAGES: LinuxImage[] = [
  {
    id: 'ubuntu-24.04',
    os: 'linux',
    distro: 'ubuntu',
    name: 'Ubuntu 24.04 LTS',
    detail: 'Supported until 2029. What most coding agents expect.',
    recommended: true,
    urls: {
      arm64: 'https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-arm64.img',
      x64: 'https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img'
    },
    sums: { url: 'https://cloud-images.ubuntu.com/releases/24.04/release/SHA256SUMS', algorithm: 'sha256' }
  },
  {
    id: 'ubuntu-26.04',
    os: 'linux',
    distro: 'ubuntu',
    name: 'Ubuntu 26.04 LTS',
    detail: 'The newest Ubuntu, supported until 2031.',
    urls: {
      arm64: 'https://cloud-images.ubuntu.com/releases/26.04/release/ubuntu-26.04-server-cloudimg-arm64.img',
      x64: 'https://cloud-images.ubuntu.com/releases/26.04/release/ubuntu-26.04-server-cloudimg-amd64.img'
    },
    sums: { url: 'https://cloud-images.ubuntu.com/releases/26.04/release/SHA256SUMS', algorithm: 'sha256' }
  },
  {
    id: 'debian-13',
    os: 'linux',
    distro: 'debian',
    name: 'Debian 13',
    detail: 'Small and steady. The lightest choice for a Raspberry Pi.',
    urls: {
      arm64: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-arm64.qcow2',
      x64: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2'
    },
    sums: { url: 'https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS', algorithm: 'sha512' }
  },
  {
    id: 'debian-12',
    os: 'linux',
    distro: 'debian',
    name: 'Debian 12',
    detail: 'The previous Debian, for software that isn’t ready for 13.',
    urls: {
      arm64: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-arm64.qcow2',
      x64: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2'
    },
    sums: { url: 'https://cloud.debian.org/images/cloud/bookworm/latest/SHA512SUMS', algorithm: 'sha512' }
  }
]

export const MACOS_IMAGES: VmImage[] = [
  { id: 'macos-latest', os: 'macos', name: 'Newest macOS this Mac can run', detail: 'Downloaded from Apple (about 18 GB).', recommended: true },
  { id: 'macos-file', os: 'macos', name: 'From a restore image you have', detail: 'An .ipsw file, for an older or a specific version.' }
]

export const linuxImage = (id: string): LinuxImage | undefined => LINUX_IMAGES.find((image) => image.id === id)

/** What a device can do about one OS. */
export interface VmOsSupport {
  available: boolean
  /** Why not, for a person; or a caveat when it is available ("slow without KVM"). */
  reason?: string
  /** One thing the user can do to make it available. */
  fix?: VmFix
}

export interface VmFix {
  label: string
  /** What `installTools` will run; shown so the user knows, and runnable by hand when sudo needs a password. */
  command: string
}

/** What a device reports about itself before any VM is made. */
export interface VmDeviceInfo {
  platform: string
  arch: VmArch | 'other'
  cpus: number
  memoryMB: number
  /** Free space where VMs' disks go. */
  diskFreeMB: number | null
  backend: VmBackend | null
  /** How Linux guests are sped up: KVM on Linux, the Virtualization framework on a Mac, or not at all. */
  accel: 'kvm' | 'vz' | 'none'
  os: Record<VmOs, VmOsSupport>
  /** The host's own name, for the device picker. */
  name: string
}

export type VmPhase = 'preparing' | 'installing' | 'stopped' | 'starting' | 'setting-up' | 'running' | 'stopping' | 'error'

export interface VmSnapshot {
  id: string
  name: string
  at: number
}

/** A VM as stored on the device that runs it. */
export interface VmRecord {
  id: string
  name: string
  os: VmOs
  /** The catalog id it was made from. */
  image: string
  /** What it runs, for a person: "Ubuntu 24.04 LTS", "macOS 26.1". */
  version: string
  /** Linux: a desktop (Xfce) as well as the terminal. */
  desktop: boolean
  cpus: number
  memoryMB: number
  diskGB: number
  /** Whether agents may use it (run commands, see and use its screen). */
  agents: boolean
  backend: VmBackend
  arch: VmArch
  createdAt: number
  /** The account inside: who agents log in as. */
  user: string
  snapshots: VmSnapshot[]
  /** Started again when the device starts (the worker computer after a reboot). */
  keepRunning: boolean
}

/** A VM as the Computers page and agents see it: the record (never its password) and how it is now. */
export interface VmStatus extends VmRecord {
  device: VmDevice
  phase: VmPhase
  /** What it is doing while it prepares, installs or sets up, and how far along. */
  progress: { step: string; fraction: number | null } | null
  error: string | null
  /** Commands can be run in it (SSH answers). */
  ready: boolean
  /** Its screen can be watched. */
  screen: boolean
  /** An agent is using it right now. */
  agentActive: boolean
}

export interface CreateVmRequest {
  name: string
  os: VmOs
  image: string
  desktop: boolean
  cpus: number
  memoryMB: number
  diskGB: number
  agents: boolean
  /** macOS from a file the user has: its path on the device. */
  ipsw?: string
}

export type VmChange = Partial<Pick<VmRecord, 'name' | 'cpus' | 'memoryMB' | 'agents' | 'keepRunning'>>

/** The login inside a VM, for the user to type on its lock screen. Only ever sent when asked for. */
export interface VmLogin {
  user: string
  password: string
}

export interface VmLimits {
  cpus: { min: number; max: number; value: number }
  memoryMB: { min: number; max: number; value: number }
  diskGB: { min: number; max: number; value: number }
}

const MB = 1
const GB = 1024 * MB

/**
 * Sizes for a new VM on this device: what it needs at least, what the device
 * can spare, and a sensible pick between them. A Raspberry Pi with 8 GB gets
 * a 4 GB desktop VM; a Mac with 24 GB gets more room.
 */
export function vmLimits(info: Pick<VmDeviceInfo, 'cpus' | 'memoryMB' | 'diskFreeMB'>, os: VmOs, desktop: boolean): VmLimits {
  const need = os === 'macos' ? { cpus: 2, memory: 4 * GB, disk: 40 } : desktop ? { cpus: 1, memory: 2 * GB, disk: 12 } : { cpus: 1, memory: 1 * GB, disk: 8 }
  const want = os === 'macos' ? { cpus: 4, memory: 8 * GB, disk: 80 } : desktop ? { cpus: 4, memory: 4 * GB, disk: 32 } : { cpus: 2, memory: 2 * GB, disk: 20 }
  // Leave the device enough to keep running itself.
  const maxCpus = Math.max(need.cpus, info.cpus)
  const maxMemory = Math.max(need.memory, Math.floor((info.memoryMB - Math.max(1 * GB, info.memoryMB / 4)) / 256) * 256)
  const maxDisk = Math.max(need.disk, info.diskFreeMB === null ? 512 : Math.floor((info.diskFreeMB - 5 * GB) / GB))
  const halfCpus = Math.max(need.cpus, Math.floor(info.cpus / 2))
  const halfMemory = Math.max(need.memory, Math.floor(info.memoryMB / 2 / 256) * 256)
  return {
    cpus: { min: need.cpus, max: maxCpus, value: Math.min(want.cpus, halfCpus, maxCpus) },
    memoryMB: { min: need.memory, max: maxMemory, value: Math.min(want.memory, halfMemory, maxMemory) },
    diskGB: { min: need.disk, max: maxDisk, value: Math.max(need.disk, Math.min(want.disk, maxDisk)) }
  }
}

/**
 * About how much free space making a VM takes, in MB: its download plus what setting it up writes.
 * Disks are sparse, so this, not the disk's size, is what has to fit. macOS: Apple's restore image
 * (unless the user has one) and the installed system; Linux: what a first boot installs (Ubuntu's
 * desktop came to 4.1 GB on a Pi).
 */
export function vmSpaceNeededMB(os: VmOs, image: string, desktop: boolean): number {
  if (os === 'macos') return (image === 'macos-file' ? 0 : 18 * GB) + 25 * GB
  return (desktop ? 6 : 3) * GB
}

/** The images a device can make a VM from, by OS. */
export function imagesFor(os: VmOs): VmImage[] {
  return os === 'linux' ? LINUX_IMAGES : os === 'macos' ? MACOS_IMAGES : []
}

/** A name for a new VM that isn't taken: "Ubuntu", "Ubuntu 2". */
export function freeVmName(base: string, taken: string[]): string {
  const names = new Set(taken.map((name) => name.toLowerCase()))
  if (!names.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/** A one-line status for a VM, as the list and agents say it. */
export function vmPhaseLabel(status: Pick<VmStatus, 'phase' | 'progress' | 'error'>): string {
  const percent = status.progress?.fraction != null ? ` ${Math.round(status.progress.fraction * 100)}%` : ''
  switch (status.phase) {
    case 'preparing':
      return `${status.progress?.step ?? 'Preparing'}${percent}`
    case 'installing':
      return `${status.progress?.step ?? 'Installing'}${percent}`
    case 'setting-up':
      return status.progress?.step ?? 'Setting up'
    case 'starting':
      return 'Starting'
    case 'running':
      return 'Running'
    case 'stopping':
      return 'Shutting down'
    case 'stopped':
      return 'Off'
    case 'error':
      return status.error ?? 'Something went wrong'
  }
}

/** What an agent does with a VM's mouse and keyboard, in screen pixels. */
export type VmInput =
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; count?: number }
  | { type: 'drag'; from: [number, number]; to: [number, number] }
  | { type: 'scroll'; x: number; y: number; dy: number; dx?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: string }

export interface VmExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface VmScreenshot {
  /** PNG, base64. */
  png: string
  width: number
  height: number
}

/** The result of installing what a device needs to run VMs. */
export interface VmToolsResult {
  ok: boolean
  /** sudo wanted a password: the user runs `command` themselves. */
  needsPassword?: boolean
  command: string
  output: string
  /** A group was added (kvm): the host app must restart before it counts. */
  restartNeeded?: boolean
}

/** A device and its VMs, as the Computers page lists them. */
export interface VmDeviceState {
  device: VmDevice
  name: string
  /** For the worker computer: whether it can be reached now. */
  connected: boolean
  info: VmDeviceInfo | null
  vms: VmStatus[]
  error: string | null
}
