/**
 * A worker computer: another machine (a Raspberry Pi, a spare Mac, a home
 * server) that runs the user's workers, and each worker's own browser, while
 * this computer is off. Eaon Desktop installs the host app on it, keeps it up
 * to date, sends it the keys and settings the workers need, and shows the
 * workers there in the Workers tab as if they ran here.
 *
 * The host is `src/host/`, the link both ends speak is
 * `main/workerHost/channel.ts`, and the desktop's side is
 * `main/features/workerHost.ts`. Everything here is plain data shared by the
 * desktop, the host, the Settings page and the tests.
 */

/** The port the host listens on unless told otherwise. */
export const WORKER_HOST_DEFAULT_PORT = 3268
/** Bumps only when the two ends can no longer understand each other. */
export const WORKER_HOST_PROTOCOL = 1
/** The path the link's WebSocket lives at. */
export const WORKER_HOST_PATH = '/eaon-host/v1'

/** What the host says about itself, on connect and whenever asked. */
export interface HostHello {
  protocol: number
  /** The host app's own build, compared with the one this desktop ships to decide whether to update it. */
  build: string
  appVersion: string
  name: string
  platform: string
  arch: string
  /** Electron (workers get their own browsers) or plain Node (no browsers). */
  runtime: 'electron' | 'node'
  /** Why there are no browsers, when `runtime` is node. */
  browserNote: string | null
  startedAt: number
  workers: number
  running: number
  /** Whether the desktop has sent keys and settings since the host started from scratch. */
  synced: boolean
  /** The host's free memory and load, for the status line. */
  memory: { free: number; total: number }
  load: number
}

/** A linked computer, as the desktop remembers it (the secret lives in the key vault, never here). */
export interface LinkedHost {
  id: string
  name: string
  /** Where the desktop reaches it: an IP address or a host name. */
  address: string
  port: number
  platform: string
  arch: string
  linkedAt: number
  /** How it was installed, so "Update" and "Unlink" can say what they will do. */
  via: 'ssh' | 'command'
  /** For SSH installs: who to log in as, for reinstalling and removing. */
  ssh?: { user: string; port: number; keyFile?: string }
}

export type HostConnection = 'connected' | 'connecting' | 'offline' | 'updating'

/** Everything Settings → Worker computer and the Workers tab show. */
export interface WorkerHostState {
  host: LinkedHost | null
  /** Whether workers run on the linked computer (true) or on this one. */
  enabled: boolean
  connection: HostConnection
  hello: HostHello | null
  /** The last thing that went wrong, for a person. */
  error: string | null
  /** When the desktop last heard from the host. */
  seenAt: number | null
  /** A move in progress, step by step. */
  moving: { direction: 'to-host' | 'to-here'; step: string } | null
  /** The copy of the workers taken when they last moved to the host, if one is kept. */
  backupAt: number | null
}

/** A one-line install in progress: what to run on the other computer. */
export interface HostPairing {
  code: string
  /** `curl … | sh` for Linux and macOS. */
  command: string
  /** Where the installer is served from, so Settings can say "on the same network as …". */
  address: string
  expiresAt: number
}

/** Progress lines from an install, as it runs. */
export interface HostInstallProgress {
  line: string
  done?: boolean
  error?: string
}

/** What the SSH install form asks for. */
export interface SshInstallRequest {
  /** `pi@raspberrypi.local`, `192.168.1.20`… */
  host: string
  user: string
  port?: number
  password?: string
  keyFile?: string
  /** What to call it; defaults to the computer's own name. */
  name?: string
}

/** Channels the host serves for the desktop's Workers tab, beyond `workers:*`. */
export const HOST_BROWSER_CHANNELS = ['agent-browser:watch', 'agent-browser:status', 'agent-browser:control', 'agent-browser:input', 'agent-browser:navigate'] as const

/** Whether a channel may be called on the host over the link. */
export function hostServesChannel(channel: string, args: unknown[]): boolean {
  if (channel.startsWith('workers:')) return true
  if ((HOST_BROWSER_CHANNELS as readonly string[]).includes(channel)) {
    // The browser channels take the target last; only workers' browsers live there.
    const target = args[args.length - 1]
    return typeof target === 'string' && target.startsWith('worker:')
  }
  return false
}

/** Events the host forwards to the desktop. */
export function hostForwardsEvent(channel: string): boolean {
  return channel.startsWith('workers:') || channel.startsWith('agent-browser:') || channel.startsWith('host:')
}
