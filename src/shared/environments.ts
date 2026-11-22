/**
 * Where a session runs: this computer, or a cloud environment, a machine
 * Eaon reaches over SSH. Like Claude's environments: set one up once in
 * Settings → Environments, then pick it under the message box when a
 * session starts (or in the ADE's New session).
 *
 * Two kinds:
 * - `exe`: exe.dev. Eaon makes a VM for each session (`ssh exe.dev new`), or
 *   works on one VM of the user's. The user's own SSH key is their exe.dev
 *   login, so there is no token to keep.
 * - `ssh`: any machine over SSH (a VM at Hetzner, DigitalOcean, AWS, a box
 *   at home): one of the hosts the ADE already knows, and a folder there that
 *   sessions are made in.
 *
 * A session in an environment works on a copy of the project made on that
 * machine (main/features/environments/copy.ts): its folder is the
 * `ssh://<host id>/<path>` every remote feature already understands
 * (shared/adeRemote.ts). Bring back (environments/bringBack.ts) fetches what
 * was done there into the project here as a branch.
 */

import type { SshHost } from './adeRemote'

export type EnvironmentKind = 'exe' | 'ssh'

/** The id this computer goes by wherever an environment can be picked. */
export const LOCAL_ENVIRONMENT = 'local'

export interface ExeEnvironment {
  /** One of the user's VMs every session works on, or null for a new VM for each session. */
  vm: string | null
  /** A new VM's size: CPUs, and memory and disk in GB. Unset leaves exe.dev's defaults. */
  cpu?: number
  memory?: number
  disk?: number
  /** A container image for a new VM; unset is exe.dev's own (exeuntu, with git, Claude Code and Codex). */
  image?: string
  /** A script a new VM runs once, on its first boot. */
  setup?: string
  /** Deleting a chat deletes the VM Eaon made for it. On by default. */
  removeWithChat?: boolean
}

export interface SshEnvironment {
  /** An SSH host from ~/.ssh/config or one added in Eaon (adeRemote `SshHost.id`). */
  hostId: string
  /** The folder on it that sessions' copies are made in; `~` is the remote user's home. */
  folder: string
}

export interface CloudEnvironment {
  id: string
  name: string
  kind: EnvironmentKind
  exe?: ExeEnvironment
  ssh?: SshEnvironment
  /** A machine picked from a provider's CLI (Codespaces, AWS, Lima…): which provider, and the machine by its id there. */
  provider?: { id: ProviderId; machine: string }
  createdAt: number
}

/**
 * Where one session runs, kept on the session: the environment it was
 * started in, by name too (the environment may be renamed or removed since),
 * and the copy of the project made there.
 */
export interface SessionPlace {
  envId: string
  name: string
  kind: EnvironmentKind
  state: 'preparing' | 'ready' | 'failed'
  /** The copy's folder, `ssh://…`, once it is ready. */
  folder?: string
  /** How the machine is reached, for people: `eaon-app-x2k.exe.xyz`, or the SSH host's name. */
  host?: string
  /** The exe.dev VM the session is on. */
  vm?: string
  /** Eaon made the VM for this session, so it is the session's to delete. */
  madeVm?: boolean
  /** The project here it is a copy of, and the commit the copy started from. */
  source?: string
  base?: string
  /** The branch the copy is on. */
  branch?: string
  /** What is happening, while it is prepared, and what has happened so far (the newest last). */
  step?: string
  steps?: string[]
  error?: string
  at: number
}

/** What the renderer asks main to prepare. */
export interface PrepareRequest {
  /** Progress events carry it back: a chat's id, or the ADE's form. */
  key: string
  envId: string
  /** The project folder here, copied over. */
  project: string
  /** What the session is about, for the VM's and the folder's names. */
  title: string
  /** A branch to make for the session (the ADE's); otherwise the copy keeps the project's. */
  branch?: string
}

export type PrepareResult = { ok: true; place: SessionPlace } | { ok: false; error: string; place?: SessionPlace }

/** One line of progress while a place is prepared. */
export interface PrepareProgress {
  key: string
  step: string
}

export type BringBackResult = { ok: true; branch: string; commits: number; files: number; message: string } | { ok: false; error: string }

/** An exe.dev VM, as `ls --json` describes it. */
export interface ExeVm {
  name: string
  status: string
  /** The host to dial: `<name>.exe.xyz`. */
  host: string
  /** What `ssh` is given (may carry a user). */
  dest: string
  user: string | null
  cpus: number | null
  memoryGb: number | null
  diskGb: number | null
  image: string | null
  httpsUrl: string | null
  createdAt: string | null
  tags: string[]
}

export type ExeAccount =
  | { ok: true; email: string | null; region: string | null; vms: ExeVm[] }
  | { ok: false; reason: 'no-ssh' | 'not-registered' | 'no-plan' | 'unreachable' | 'other'; message: string }

/* ------------------------------------------------------------------ hosts */

const EXE_PREFIX = 'exe:'

/** The SSH host id of an exe.dev VM. */
export const exeHostId = (vm: string): string => `${EXE_PREFIX}${vm}`

/** A VM name as exe.dev takes it: lowercase letters, digits and hyphens. */
export const isVmName = (name: string): boolean => /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)

/**
 * An exe.dev VM as an SSH host. Nothing to store: the name says where it is.
 * A VM Eaon has just made has a host key nobody has seen, so ssh is told to
 * take it the first time (`trustNew`), as it would be told in a terminal.
 */
export function exeHost(id: string): SshHost | null {
  if (!id.startsWith(EXE_PREFIX)) return null
  const vm = id.slice(EXE_PREFIX.length)
  if (!isVmName(vm)) return null
  return { id, label: `${vm}.exe.xyz`, hostname: `${vm}.exe.xyz`, user: null, port: null, identityFile: null, source: 'manual', alias: null, trustNew: true }
}

/* ------------------------------------------------------------------ names */

/** A name's words as a slug: `Fix the CI checks` → `fix-the-ci-checks`, cut to `max`. */
export function slugOf(text: string, max = 24): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
  return slug || 'session'
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/** A few letters no one picks: what keeps two sessions' VMs and folders apart. */
export function shortId(length = 5, random: () => number = Math.random): string {
  let id = ''
  for (let i = 0; i < length; i++) id += ALPHABET[Math.floor(random() * ALPHABET.length)]
  return id
}

/**
 * A new VM's name: `eaon-<project>-<id>`. exe.dev's names are shared by
 * everyone on it, so the id makes it the user's own.
 */
export function vmNameFor(project: string, random?: () => number): string {
  return `eaon-${slugOf(project, 20)}-${shortId(5, random)}`
}

/* ------------------------------------------------------------------ words */

export const KIND_LABEL: Record<EnvironmentKind, string> = { exe: 'exe.dev', ssh: 'SSH machine' }

/** One line under an environment's name: where its sessions go. */
export function environmentSummary(env: CloudEnvironment, hostLabel?: (id: string) => string | null): string {
  if (env.kind === 'exe') {
    if (env.exe?.vm) return `Each session in ~/eaon on ${env.exe.vm}`
    const size = [env.exe?.cpu ? `${env.exe.cpu} CPU` : null, env.exe?.memory ? `${env.exe.memory} GB` : null].filter(Boolean).join(', ')
    return `A new exe.dev VM for each session${size ? ` (${size})` : ''}`
  }
  if (env.provider) return `${PROVIDER_NAMES[env.provider.id] ?? env.provider.id} · ${env.provider.machine} · ${env.ssh?.folder || '~'}`
  const host = env.ssh ? (hostLabel?.(env.ssh.hostId) ?? env.ssh.hostId.replace(/^cfg:/, '')) : 'no host'
  return `${host} · ${env.ssh?.folder || '~'}`
}

/** The environments that can be picked, the broken ones (no host) left out by the caller's check. */
export function environmentsOf(list: CloudEnvironment[] | undefined): CloudEnvironment[] {
  return (list ?? []).filter((env) => env && typeof env.id === 'string' && (env.kind === 'exe' || (env.kind === 'ssh' && Boolean(env.ssh?.hostId))))
}

/** A session's place in a few words, for a header or a sidebar row. */
export function placeLabel(place: SessionPlace): string {
  return place.vm ?? place.host ?? place.name
}

/* ------------------------------------------------------------- providers */

/**
 * VM providers whose command-line tools Eaon looks for on this computer
 * (main/features/environments/providers.ts), so a machine of theirs can be
 * picked and used as an environment without typing an address.
 */
export type ProviderId = 'exe' | 'freestyle' | 'codespaces' | 'aws' | 'gcp' | 'azure' | 'digitalocean' | 'hetzner' | 'linode' | 'vultr' | 'coder' | 'tailscale' | 'lima' | 'orbstack'

/** A machine a provider's CLI lists. */
export interface ProviderMachine {
  id: string
  name: string
  /** The provider's word for its state (running, stopped, Available…). */
  status: string
  running: boolean
  /** Where it is and what it is, in a few words: `fsn1 · cx22`, `linux · online`. */
  detail: string | null
  /** The user ssh logs in as, when the provider says or Eaon can tell; the person can change it. */
  user: string | null
  /** Why it can't be used as it is, and how to fix it ("Stopped: start it with limactl start deb"). */
  why: string | null
}

export type ProviderState =
  /** Its CLI isn't on this computer. */
  | 'missing'
  /** Installed, not signed in (or missing a permission). */
  | 'signed-out'
  | 'ready'
  /** It answered with something Eaon couldn't read. */
  | 'error'

export interface ProviderStatus {
  id: ProviderId
  name: string
  state: ProviderState
  /** The CLI found, for people: `az`, `gh`. */
  cli: string | null
  /** Who it is signed in as, or which project or subscription, when the CLI says. */
  account: string | null
  /** What's wrong, in words. */
  message: string | null
  /** A command to run in Terminal to fix it: sign in, grant a permission, install. */
  fix: string | null
  machines: ProviderMachine[]
  /** Its site, for people who don't have it yet. */
  site: string
}

/** Picking a provider's machine as an environment. */
export interface GrabRequest {
  provider: ProviderId
  machine: string
  name: string
  /** The user to log in as; the provider's own when left out. */
  user?: string
  /** The folder sessions go in there. */
  folder?: string
}

export type GrabResult = { ok: true; env: CloudEnvironment } | { ok: false; error: string }

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  exe: 'exe.dev',
  freestyle: 'Freestyle',
  codespaces: 'GitHub Codespaces',
  aws: 'AWS EC2',
  gcp: 'Google Cloud',
  azure: 'Azure',
  digitalocean: 'DigitalOcean',
  hetzner: 'Hetzner Cloud',
  linode: 'Linode',
  vultr: 'Vultr',
  coder: 'Coder',
  tailscale: 'Tailscale',
  lima: 'Lima',
  orbstack: 'OrbStack'
}
