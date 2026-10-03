import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import type { EaonCodeStatus } from '@shared/eaonCode'

/** Eaon Code's `engines.node`. Checked here so a too-old Node is named, not a stack trace. */
export const NODE_REQUIREMENT = '>=22.19.0'
const MIN_NODE: [number, number, number] = [22, 19, 0]

export interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  error?: string
}

/** Quote an argument for cmd.exe, which is what runs npm's `.cmd` shims. */
export const winQuote = (arg: string): string => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)

/**
 * How to spawn `command`. npm's `.cmd` shims on Windows run only through
 * cmd.exe, and with `shell: true` Node joins the command line unquoted — so
 * `C:\Program Files\nodejs\npm.cmd`, where Node installs npm by default, would
 * run `C:\Program`. Everything is quoted for cmd.exe here instead.
 */
export function spawnSpec(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[]; shell: boolean } {
  const shell = platform === 'win32' && /\.(cmd|bat)$/i.test(command)
  return shell ? { command: winQuote(command), args: args.map(winQuote), shell } : { command, args, shell }
}

/** execFile as a promise that never rejects; `.cmd` shims need a shell on Windows. */
export function run(command: string, args: string[], options: { timeoutMs?: number; cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const spec = spawnSpec(command, args)
    execFile(
      spec.command,
      spec.args,
      { timeout: options.timeoutMs ?? 15_000, cwd: options.cwd, shell: spec.shell, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : error ? null : 0
        resolve({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code,
          error: error ? ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : error.message) : undefined
        })
      }
    )
  })
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `which`, over the PATH adopted from the login shell at startup. */
export function findOnPath(name: string): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').concat('') : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase())
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

export function parseVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function versionAtLeast(version: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== min[i]) return version[i] > min[i]
  }
  return true
}

/** The Node that `#!/usr/bin/env node` will pick, and whether Eaon Code accepts it. */
export async function checkNode(): Promise<EaonCodeStatus['node']> {
  const path = findOnPath('node')
  if (!path) return { path: null, version: null, ok: false }
  const result = await run(path, ['--version'], { timeoutMs: 8000 })
  const parsed = parseVersion(result.stdout)
  return { path, version: parsed ? parsed.join('.') : null, ok: parsed ? versionAtLeast(parsed, MIN_NODE) : false }
}

/** Where Eaon Code's installer keeps its checkout, read the way install.sh reads it. */
export function installerDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.EAON_CODE_PREFIX || join(homedir(), '.local', 'share', 'eaon-code')
}

export interface InstallerCopy {
  /** The checkout, ~/.local/share/eaon-code by default. */
  dir: string
  /** The built CLI, run with Node. */
  cli: string
  /** When the installer last finished: it rewrites its marker at the very end. */
  updatedAt: number
}

/**
 * The copy Eaon Code's installer made, if there is one. The installer marks a
 * finished install with `.git/eaon-code-install.json`; without the marker, or
 * without the built CLI, the checkout is half-made and doesn't count.
 */
export function findInstallerCopy(env: NodeJS.ProcessEnv = process.env): InstallerCopy | null {
  const dir = installerDir(env)
  const marker = join(dir, '.git', 'eaon-code-install.json')
  const cli = join(dir, 'packages', 'coding-agent', 'dist', 'bundle', 'cli.js')
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { kind?: string }
    if (parsed.kind !== 'eaon-code-source-install' || !statSync(cli).isFile()) return null
    return { dir, cli, updatedAt: statSync(marker).mtimeMs }
  } catch {
    return null
  }
}

/** Where `npm install -g` puts binaries, for when that folder is not on PATH yet. */
async function npmGlobalBin(name: string): Promise<string | null> {
  const npm = findOnPath('npm')
  if (!npm) return null
  const result = await run(npm, ['prefix', '-g'], { timeoutMs: 10_000 })
  const prefix = result.stdout.trim()
  if (!result.ok || !prefix) return null
  const candidate = process.platform === 'win32' ? join(prefix, `${name}.cmd`) : join(prefix, 'bin', name)
  return isExecutable(candidate) ? candidate : null
}

export interface EaonPackageInfo {
  /** Folder holding Eaon Code's package.json, when it could be found. */
  dir: string | null
  /** `eaonConfig.configDir`: `.eaon` for published builds, `.pi` for a source checkout. */
  configDir: string
  /** `eaonConfig.name`, which prefixes its environment variables. */
  appName: string
}

/**
 * Reads the package.json next to the binary. The config folder name differs
 * between builds (a published 1.x uses `.eaon`, the source tree still says
 * `.pi`), and sessions live under it — so it is read, never assumed.
 */
export function readPackageInfo(binaryPath: string): EaonPackageInfo {
  const starts: string[] = []
  try {
    starts.push(dirname(realpathSync(binaryPath)))
  } catch {
    starts.push(dirname(binaryPath))
  }
  // npm's Windows shims and some global layouts do not symlink into the package.
  starts.push(join(dirname(binaryPath), 'node_modules/@eaonlabs/eaon-code'))
  starts.push(join(dirname(binaryPath), '../lib/node_modules/@eaonlabs/eaon-code'))

  for (const start of starts) {
    let dir = start
    for (let depth = 0; depth < 6; depth++) {
      const file = join(dir, 'package.json')
      if (existsSync(file)) {
        try {
          const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
            name?: string
            eaonConfig?: { configDir?: string; name?: string }
            bin?: Record<string, string>
          }
          if (pkg.eaonConfig || pkg.name === '@eaonlabs/eaon-code' || pkg.bin?.['eaon-code']) {
            return {
              dir,
              configDir: pkg.eaonConfig?.configDir || '.pi',
              appName: pkg.eaonConfig?.name || 'eaon-code'
            }
          }
        } catch {
          /* keep walking */
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return { dir: null, configDir: '.eaon', appName: 'eaon-code' }
}

/** `~/.eaon/agent`, or whatever the environment overrides it to — mirrors Eaon Code's getAgentDir(). */
export function agentDirFor(info: EaonPackageInfo, env: NodeJS.ProcessEnv = process.env): string {
  const prefix = info.appName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const fromEnv = env[`${prefix}_CODING_AGENT_DIR`] ?? env.PI_CODING_AGENT_DIR
  if (fromEnv) return fromEnv.startsWith('~') ? join(homedir(), fromEnv.slice(1)) : fromEnv
  return join(homedir(), info.configDir, 'agent')
}

const isScript = (path: string): boolean => /\.[cm]?js$/i.test(path)

/**
 * Finds Eaon Code and checks it runs: the configured path if there is one,
 * then the installer's copy, then `eaon-code` or `pi` on PATH, then npm's
 * global bin folder. The installer's copy comes before PATH because it's the
 * one Settings → Eaon Code installs and updates; an older npm copy on PATH
 * would otherwise shadow it.
 */
export async function detectEaonCode(configured: string | null, env: NodeJS.ProcessEnv = process.env): Promise<EaonCodeStatus> {
  const node = await checkNode()
  const base = { node, nodeRequirement: NODE_REQUIREMENT }
  const viaNode = (script: string): EaonCodeStatus['launch'] => ({ command: node.path ?? 'node', args: [script] })

  let binaryPath: string | null = null
  let launch: EaonCodeStatus['launch'] = null
  let source: EaonCodeStatus['source'] = null
  let copy: InstallerCopy | null = null
  if (configured) {
    // A picked cli.js is run with Node, so it needn't be executable itself.
    const usable = isAbsolute(configured) && (isScript(configured) ? existsSync(configured) : isExecutable(configured))
    if (!usable) {
      return {
        ...base,
        state: 'broken',
        binaryPath: configured,
        launch: null,
        source: 'setting',
        version: null,
        error: `The path set in Settings → Eaon Code is not an executable file: ${configured}`
      }
    }
    binaryPath = configured
    launch = isScript(configured) ? viaNode(configured) : { command: configured, args: [] }
    source = 'setting'
  } else if ((copy = findInstallerCopy(env))) {
    binaryPath = copy.cli
    launch = viaNode(copy.cli)
    source = 'installer'
  } else {
    binaryPath = findOnPath('eaon-code') ?? findOnPath('pi')
    source = binaryPath ? 'path' : null
    if (!binaryPath) {
      binaryPath = await npmGlobalBin('eaon-code')
      source = binaryPath ? 'npm-prefix' : null
    }
    launch = binaryPath ? { command: binaryPath, args: [] } : null
  }
  if (!binaryPath || !launch) return { ...base, state: 'missing', binaryPath: null, launch: null, source: null, version: null }

  const found = { ...base, binaryPath, launch, source, ...(copy ? { installDir: copy.dir, updatedAt: copy.updatedAt } : {}) }
  const result = await run(launch.command, [...launch.args, '--version'], { timeoutMs: 20_000 })
  const parsed = parseVersion(result.stdout)
  if (!result.ok || !parsed) {
    const detail = (result.stderr || result.stdout || result.error || '').trim().split('\n').slice(-3).join(' ')
    return {
      ...found,
      state: 'broken',
      version: null,
      error: !node.ok
        ? `Eaon Code needs Node ${NODE_REQUIREMENT}, but ${node.version ? `Node ${node.version}` : 'no Node'} is on your PATH.`
        : `"${[launch.command, ...launch.args].join(' ')} --version" failed${detail ? `: ${detail}` : '.'}`
    }
  }
  return { ...found, state: 'ready', version: parsed.join('.') }
}
