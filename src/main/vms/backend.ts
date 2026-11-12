import type { VmBackend, VmRecord } from '@shared/vms'
import type { SshRoute } from './ssh'

/**
 * What the manager (service.ts) needs from whatever runs the VMs on this
 * computer: the `eaon-vm` helper on a Mac (vz.ts), QEMU on Linux (qemu.ts).
 */

/** Where one VM's files are. */
export interface VmPaths {
  dir: string
  disk: string
  seed: string
  console: string
  runFile: string
  snapshots: string
  /** Short enough for a Unix socket's path (104 bytes on macOS). */
  sshSocket: string
  vncSocket: string
  qmpSocket: string
}

/** How to reach a running VM's screen. */
export type VncTarget = { kind: 'tcp'; port: number; password: string } | { kind: 'unix'; path: string; password: null }

export interface BackendRun {
  running: boolean
  stopping: boolean
  /** Why it stopped, when it stopped by failing. */
  error: string | null
  vnc: VncTarget | null
}

export interface VmBackendDriver {
  kind: VmBackend
  diskFormat: 'raw' | 'qcow2'
  /** Makes a Linux VM's disk from a downloaded cloud image (qcow2). */
  prepareDisk: (vm: VmRecord, paths: VmPaths, image: string, onProgress: (step: string, fraction: number | null) => void, signal?: AbortSignal) => Promise<void>
  /**
   * Starts the VM; resolves once it's running (not once the guest has booted). `seed`: the first-boot
   * data still goes in (a Mac attaches its ISO only until the VM is set up).
   */
  start: (vm: VmRecord, paths: VmPaths, extra: { seedUrl?: string; seed?: boolean }) => Promise<void>
  /** Asks the guest to shut down, or stops it at once. */
  stop: (vm: VmRecord, paths: VmPaths, force: boolean) => Promise<void>
  /** How it is now, read from what the running VM left (so it works after a restart of Eaon). */
  status: (vm: VmRecord, paths: VmPaths) => BackendRun
  /** Where its SSH is, if it has one Eaon can reach. */
  ssh: (vm: VmRecord, paths: VmPaths) => SshRoute | null
  /** Snapshots, taken and restored while the VM is off. */
  snapshot: (vm: VmRecord, paths: VmPaths, id: string) => Promise<void>
  restore: (vm: VmRecord, paths: VmPaths, id: string) => Promise<void>
  deleteSnapshot: (vm: VmRecord, paths: VmPaths, id: string) => Promise<void>
}
