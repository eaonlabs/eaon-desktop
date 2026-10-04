import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cliHome } from '../runtime/paths'
import { CLI_PACKAGE, CLI_VERSION } from './version'

/**
 * Updating the CLI from npm.
 *
 * The full-screen app asks the npm registry for the package's dist-tags in
 * the background, at most every few hours, and keeps the answer in the
 * profile (`update.json`). When a newer version is out it asks whether to
 * update now (`tui/update.ts`); `eaon update` does the same from a shell.
 * Updating runs the package manager that installed this copy — for npm,
 * `npm install --global --prefix <this install's prefix> @eaonlabs/cli@<version>` —
 * so it replaces this install rather than one somewhere else. A beta follows
 * the `beta` tag as well as `latest`; a stable version only `latest`.
 *
 * Run from a source checkout (bin/eaon.mjs) or through npx, it says how to
 * update instead of doing it. EAON_NO_UPDATE_CHECK, NO_UPDATE_NOTIFIER or CI
 * turn the check off; EAON_UPDATE_REGISTRY points the check and the install
 * at another registry (a mirror, or a test registry).
 */

const CHECK_EVERY_MS = 6 * 3_600_000
/** After a failed check (offline), the next try. */
const RETRY_MS = 30 * 60_000
/** "Later" puts the question off this long. */
const REMIND_AFTER_MS = 24 * 3_600_000
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

export interface UpdateState {
  /** When the registry was last asked. */
  checkedAt: number
  /** Its dist-tags then: { latest, beta, … }. */
  tags: Record<string, string>
  /** A version the user said not to offer again. */
  skipped?: string
  /** "Later": not before this. */
  remindAfter?: number
}

export interface UpdateOffer {
  current: string
  latest: string
}

/* ------------------------------------------------------------- versions */

function parts(version: string): { core: number[]; pre: string[] } {
  const v = version.trim().replace(/^v/, '').split('+')[0]
  const dash = v.indexOf('-')
  return {
    core: (dash === -1 ? v : v.slice(0, dash)).split('.').map((n) => Number.parseInt(n, 10) || 0),
    pre: dash === -1 ? [] : v.slice(dash + 1).split('.')
  }
}

/** Semver order, prereleases included: 0.1.0-beta.2 < 0.1.0-beta.10 < 0.1.0-rc.1 < 0.1.0 < 0.1.1. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0)
    if (d) return Math.sign(d)
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) {
      const d = Number(p) - Number(q)
      if (d) return Math.sign(d)
    } else if (pn !== qn) return pn ? -1 : 1
    else if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** The newest version this install should move to, if any: `latest`, and for a prerelease `beta` and `next` too. */
export function newerVersion(current: string, tags: Record<string, string>): string | null {
  const channels = parts(current).pre.length ? ['latest', 'beta', 'next'] : ['latest']
  let best: string | null = null
  for (const tag of channels) {
    const v = tags[tag]
    if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) && (!best || compareVersions(v, best) > 0)) best = v
  }
  return best && compareVersions(best, current) > 0 ? best : null
}

/* -------------------------------------------------------- the install */

export type InstallKind = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'npx' | 'source'

export interface Install {
  kind: InstallKind
  /** npm's global prefix this copy lives under, when it can be read from the path. */
  prefix?: string
  /** The package folder (node_modules/eaon). */
  dir?: string
}

/** The running bundle (eaon.mjs). */
function bundlePath(): string {
  try {
    return fileURLToPath(import.meta.url)
  } catch {
    return process.argv[1] ?? ''
  }
}

/** How this copy was installed, from where it runs. */
export function detectInstall(file = bundlePath(), platform: NodeJS.Platform = process.platform, pkg = CLI_PACKAGE): Install {
  const p = file.replace(/\\/g, '/')
  const marker = `/node_modules/${pkg}/`
  const at = p.lastIndexOf(marker)
  if (at === -1) return { kind: 'source' }
  // Slicing the original keeps Windows separators.
  const dir = file.slice(0, at + marker.length - 1)
  if (p.includes('/_npx/')) return { kind: 'npx', dir }
  if (p.includes('/.bun/')) return { kind: 'bun', dir }
  if (/\/\.?pnpm\//.test(p)) return { kind: 'pnpm', dir }
  if (/\/yarn\/global\//i.test(p) || p.includes('/.config/yarn/')) return { kind: 'yarn', dir }
  // npm puts global packages in <prefix>/lib/node_modules, or <prefix>\node_modules on Windows.
  if (platform === 'win32') return { kind: 'npm', prefix: file.slice(0, at), dir }
  if (p.slice(0, at).endsWith('/lib')) return { kind: 'npm', prefix: file.slice(0, at - 4), dir }
  return { kind: 'npm', dir }
}

export function registryUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.EAON_UPDATE_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, '')
}

/** The command that installs `version` over this copy, or null when it isn't one a package manager owns. */
export function updateCommand(install: Install, version: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | null {
  const spec = `${CLI_PACKAGE}@${version}`
  const registry = env.EAON_UPDATE_REGISTRY ? ['--registry', registryUrl(env)] : []
  switch (install.kind) {
    case 'npm':
      return { command: 'npm', args: ['install', '--global', ...(install.prefix ? ['--prefix', install.prefix] : []), ...registry, spec] }
    case 'pnpm':
      return { command: 'pnpm', args: ['add', '--global', ...registry, spec] }
    case 'yarn':
      return { command: 'yarn', args: ['global', 'add', ...registry, spec] }
    case 'bun':
      return { command: 'bun', args: ['add', '--global', spec] }
    default:
      return null
  }
}

const quote = (arg: string): string => (/[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)

/** What to type to update by hand. */
export function manualUpdate(install: Install, version: string): string {
  if (install.kind === 'npx') return `npx ${CLI_PACKAGE}@${version}`
  if (install.kind === 'source') return 'git pull, then npm install && npm run build:cli'
  const command = updateCommand(install, version)!
  return [command.command, ...command.args.map(quote)].join(' ')
}

/* -------------------------------------------------------------- checking */

const stateFile = (): string => join(cliHome(), 'update.json')

export function readUpdateState(): UpdateState {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf8')) as Partial<UpdateState>
    return {
      checkedAt: Number(s.checkedAt) || 0,
      tags: s.tags && typeof s.tags === 'object' ? (s.tags as Record<string, string>) : {},
      ...(typeof s.skipped === 'string' ? { skipped: s.skipped } : {}),
      ...(Number(s.remindAfter) ? { remindAfter: Number(s.remindAfter) } : {})
    }
  } catch {
    return { checkedAt: 0, tags: {} }
  }
}

export function saveUpdateState(state: UpdateState): void {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true })
    const tmp = `${stateFile()}.tmp`
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, stateFile())
  } catch {
    /* a read-only profile: ask again next time */
  }
}

export function updatesDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.EAON_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI)
}

/** The package's dist-tags from the registry. */
export async function fetchDistTags(fetchImpl: typeof fetch = fetch): Promise<Record<string, string>> {
  const response = await fetchImpl(`${registryUrl()}/-/package/${CLI_PACKAGE.replace('/', '%2f')}/dist-tags`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(6000)
  })
  if (!response.ok) throw new Error(`The npm registry answered ${response.status} for ${CLI_PACKAGE}.`)
  const tags = (await response.json()) as Record<string, unknown>
  return Object.fromEntries(Object.entries(tags ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>
}

/** Asks the registry (unless it was asked lately, or `force`) and says whether a newer version is out. */
export async function checkForUpdate(options: { force?: boolean; now?: number; current?: string; fetchImpl?: typeof fetch } = {}): Promise<UpdateOffer | null> {
  if (updatesDisabled()) return null
  const now = options.now ?? Date.now()
  const current = options.current ?? CLI_VERSION
  let state = readUpdateState()
  if (options.force || now - state.checkedAt >= CHECK_EVERY_MS) {
    try {
      state = { ...state, checkedAt: now, tags: await fetchDistTags(options.fetchImpl) }
    } catch {
      // Offline, or the registry is down: keep what was known and try again in a while.
      state = { ...state, checkedAt: now - CHECK_EVERY_MS + RETRY_MS }
    }
    saveUpdateState(state)
  }
  const latest = newerVersion(current, state.tags)
  return latest ? { current, latest } : null
}

/** A newer version the last check found, without asking the registry (for one-shot commands). */
export function knownUpdate(current = CLI_VERSION): string | null {
  return updatesDisabled() ? null : newerVersion(current, readUpdateState().tags)
}

/** Whether to ask about `version` now: not skipped, and not put off with "later". */
export function shouldOffer(version: string, now = Date.now()): boolean {
  const state = readUpdateState()
  return state.skipped !== version && !(state.remindAfter && now < state.remindAfter)
}

export function skipVersion(version: string): void {
  saveUpdateState({ ...readUpdateState(), skipped: version })
}

export function remindLater(now = Date.now()): void {
  saveUpdateState({ ...readUpdateState(), remindAfter: now + REMIND_AFTER_MS })
}

/* -------------------------------------------------------------- updating */

export interface UpdateResult {
  ok: boolean
  /** The version now in this install's folder, read back after the install. */
  installed: string | null
  output: string
  /** When it failed: what went wrong, and what to do. */
  hint?: string
  /** When it failed: the command to run by hand. */
  command?: string
}

function installedVersion(install: Install): string | null {
  if (!install.dir) return null
  try {
    return (JSON.parse(readFileSync(join(install.dir, 'package.json'), 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

function failure(output: string, install: Install, version: string): { hint: string; command?: string } {
  const manual = manualUpdate(install, version)
  const where = install.prefix ?? 'its global folder'
  if (/EACCES|EPERM|permission denied/i.test(output))
    return process.platform === 'win32'
      ? { hint: `${install.kind} couldn’t write to ${where}. Run this in an administrator terminal:`, command: manual }
      : { hint: `${install.kind} couldn’t write to ${where}. Run it yourself with sudo:`, command: `sudo ${manual}` }
  if (/EBUSY|resource busy/i.test(output)) return { hint: 'A file of this install is in use. Quit eaon, then run:', command: manual }
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(output)) return { hint: 'Couldn’t reach the npm registry. Check the connection and try again.' }
  return { hint: 'It didn’t finish. Run it yourself:', command: manual }
}

type Spawn = (command: string, args: string[], options: Record<string, unknown>) => Pick<ChildProcess, 'on' | 'stdout' | 'stderr'>

/** Installs `version` over this copy, reporting the package manager's output line by line. */
export function runUpdate(version: string, onOutput: (line: string) => void = () => {}, install: Install = detectInstall(), spawnImpl: Spawn = spawn as unknown as Spawn): Promise<UpdateResult> {
  const command = updateCommand(install, version)
  if (!command) return Promise.resolve({ ok: false, installed: null, output: '', hint: 'Update it with:', command: manualUpdate(install, version) })
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const done = (result: UpdateResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const windows = process.platform === 'win32'
    let child: ReturnType<Spawn>
    try {
      // npm and friends are .cmd files on Windows, which only start through a shell.
      child = spawnImpl(command.command, windows ? command.args.map(quote) : command.args, {
        shell: windows,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }
      })
    } catch (error) {
      return done({ ok: false, installed: null, output, hint: error instanceof Error ? error.message : String(error), command: manualUpdate(install, version) })
    }
    const take = (chunk: Buffer | string): void => {
      const text = chunk.toString()
      output += text
      for (const line of text.split(/\r?\n/)) if (line.trim()) onOutput(line.trim())
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', (error: NodeJS.ErrnoException) =>
      done({
        ok: false,
        installed: null,
        output,
        hint: error.code === 'ENOENT' ? `${command.command} isn’t on your PATH. Update it with:` : error.message,
        command: manualUpdate(install, version)
      })
    )
    child.on('close', (code: number | null) => {
      const ok = code === 0
      done({ ok, installed: installedVersion(install), output, ...(ok ? {} : failure(output, install, version)) })
    })
  })
}

/** After an update: forget "later" and "skip", so the next version is offered as usual. */
export function updated(): void {
  const { checkedAt, tags } = readUpdateState()
  saveUpdateState({ checkedAt, tags })
}
