import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { run } from '../../features/eaonCode/locate'

/**
 * Finding Codex on this computer, its version, and the newest release.
 *
 * Codex arrives several ways and none of them is guaranteed to be on the PATH
 * an app launched from the Dock sees: npm's global folder, Homebrew, OpenAI's
 * own installer (~/.local/bin), or bundled inside the ChatGPT desktop app,
 * which is not on any PATH at all. Every location is checked, each copy's
 * version is read, and the newest one is used: the app-server protocol only
 * grows, so the newest copy is the one most likely to speak it.
 */

export type CodexSource = 'override' | 'npm' | 'homebrew' | 'installer' | 'chatgpt-app' | 'codex-app' | 'path'

/** For the user: where a copy came from. */
export const SOURCE_LABEL: Record<CodexSource, string> = {
  override: 'EAON_CODEX_BIN',
  npm: 'npm',
  homebrew: 'Homebrew',
  installer: 'Codex installer',
  'chatgpt-app': 'ChatGPT app',
  'codex-app': 'Codex app',
  path: 'PATH'
}

/**
 * The oldest Codex Eaon drives. 0.99.0 is the first release whose app-server
 * has everything the engine relies on: `turn/steer` with `expectedTurnId`
 * (added in 0.99), `inputModalities` on `model/list` (0.95), and the v2
 * thread/turn API with `thread/resume`, `turn/interrupt`, `config/read`,
 * `account/read` (with the plan), `account/login/start` →
 * `account/login/completed`, and accept/decline command and file-change
 * approvals (all present by 0.90). Checked against the protocol sources at
 * each release tag.
 */
export const MIN_CODEX_VERSION = '0.99.0'

export const NPM_PACKAGE = '@openai/codex'

export interface CodexCandidate {
  path: string
  source: CodexSource
}

export interface CodexCopy extends CodexCandidate {
  version: string | null
  /** Why `--version` didn't work, when it didn't. */
  error: string | null
}

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  /** Folders holding .app bundles (macOS). */
  appDirs?: string[]
  /** `npm prefix -g`, or null when npm isn't there. Injected by tests. */
  npmPrefix?: () => Promise<string | null>
  /** Homebrew's and the system's bin folders; tests pass their own so a real Codex there doesn't count. */
  systemDirs?: string[]
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function realpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Where a copy really comes from, judged by where its file actually lives. */
export function classify(path: string, home: string): CodexSource {
  const real = realpath(path)
  if (/[\\/]node_modules[\\/]@openai[\\/]codex/i.test(real)) return 'npm'
  if (/\/chatgpt\.app\//i.test(real)) return 'chatgpt-app'
  if (/\/codex\.app\/contents\/resources\//i.test(real)) return 'codex-app'
  if (/[\\/](resources)[\\/]codex-cli[\\/]/i.test(real) && /chatgpt/i.test(real)) return 'chatgpt-app'
  if (/^\/(opt\/homebrew|usr\/local\/(Cellar|Caskroom|Homebrew)|home\/linuxbrew\/\.linuxbrew)\//i.test(real)) return 'homebrew'
  if (real.startsWith(join(home, '.codex', 'packages'))) return 'installer'
  return 'path'
}

/** The npm global prefix, asked once per detection. */
async function defaultNpmPrefix(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | null> {
  const npm = whichIn(env.PATH ?? '', platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'], platform)
  if (!npm) return null
  const result = await run(npm, ['prefix', '-g'], { timeoutMs: 8000 })
  const prefix = result.stdout.trim()
  return result.ok && prefix ? prefix : null
}

function whichIn(pathVar: string, names: string[], platform: NodeJS.Platform): string | null {
  for (const dir of pathVar.split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutable(candidate, platform)) return candidate
    }
  }
  return null
}

/**
 * Every place a Codex could be, most specific first, each existing file once
 * (by its real path). `EAON_CODEX_BIN` replaces the search entirely — for
 * tests and for someone who wants a particular build; `none` means "act as
 * if Codex isn't installed".
 */
export async function findCodexCandidates(options: DiscoveryOptions = {}): Promise<CodexCandidate[]> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const override = env.EAON_CODEX_BIN?.trim()
  if (override) {
    if (override === 'none') return []
    return isExecutable(override, platform) ? [{ path: override, source: 'override' }] : []
  }

  const names = platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex']
  const found: CodexCandidate[] = []
  const seen = new Set<string>()
  const add = (path: string | null, source?: CodexSource): void => {
    if (!path || !isExecutable(path, platform)) return
    const real = realpath(path)
    if (seen.has(real)) return
    seen.add(real)
    found.push({ path, source: source ?? classify(path, home) })
  }

  // 1. The login shell's PATH (adopted at startup), what the user's terminal runs.
  add(whichIn(env.PATH ?? '', names, platform))

  // 2. npm's global folder, for when it isn't on PATH yet.
  const prefix = await (options.npmPrefix ? options.npmPrefix() : defaultNpmPrefix(env, platform))
  if (prefix) {
    for (const name of names) add(platform === 'win32' ? join(prefix, name) : join(prefix, 'bin', name), 'npm')
  }

  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    for (const name of names) add(join(appData, 'npm', name), 'npm')
    add(join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), 'installer')
    add(join(home, '.codex', 'bin', 'codex.exe'), 'installer')
    add(join(local, 'Programs', 'ChatGPT', 'resources', 'codex-cli', 'bin', 'codex.exe'), 'chatgpt-app')
    add(join(local, 'Programs', 'ChatGPT', 'resources', 'codex.exe'), 'chatgpt-app')
    return found
  }

  // 3. Homebrew and the usual system folders.
  for (const dir of options.systemDirs ?? ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin']) add(join(dir, 'codex'))
  // 4. OpenAI's installer (curl … install.sh) and other per-user folders.
  add(join(home, '.local', 'bin', 'codex'))
  add(join(home, '.npm-global', 'bin', 'codex'), 'npm')
  add(join(home, '.volta', 'bin', 'codex'), 'npm')

  // 5. Bundled in a desktop app. The ChatGPT app ships it as codex-cli/bin
  //    (a launcher into CodexCLI.app); older builds put the binary straight
  //    in Resources, and before the rename the app was Codex.app.
  if (platform === 'darwin') {
    const appDirs = options.appDirs ?? ['/Applications', join(home, 'Applications')]
    for (const dir of appDirs) {
      add(join(dir, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'), 'chatgpt-app')
      add(join(dir, 'ChatGPT.app', 'Contents', 'Resources', 'codex'), 'chatgpt-app')
      add(join(dir, 'Codex.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'), 'codex-app')
      add(join(dir, 'Codex.app', 'Contents', 'Resources', 'codex'), 'codex-app')
    }
  }
  return found
}

/* ----------------------------------------------------------------- versions */

export function parseVersion(text: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(text)
  return match ? match[0] : null
}

/** Semver order: numbers first, and a pre-release sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string | null } => {
    const [core, ...rest] = v.split('-')
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: rest.length ? rest.join('-') : null }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  return x.pre < y.pre ? -1 : 1
}

const versionCache = new Map<string, { mtimeMs: number; version: string | null; error: string | null }>()

/** `codex --version` ("codex-cli 0.160.0"), remembered per file until it changes. */
export async function readVersion(path: string): Promise<{ version: string | null; error: string | null }> {
  let mtimeMs = 0
  try {
    mtimeMs = statSync(realpath(path)).mtimeMs
  } catch {
    /* gone: --version below says so */
  }
  const cached = versionCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs && cached.version) return cached
  const result = await run(path, ['--version'], { timeoutMs: 15_000 })
  const version = parseVersion(result.stdout) ?? parseVersion(result.stderr)
  const error = version
    ? null
    : `"${path} --version" ${result.error === 'not found' ? 'could not be run' : 'failed'}${
        (result.stderr || result.error) ? `: ${(result.stderr || result.error || '').trim().split('\n').slice(-2).join(' ').slice(0, 300)}` : '.'
      }`
  const entry = { mtimeMs, version, error }
  versionCache.set(path, entry)
  return entry
}

/** Each candidate with its version, newest first; copies that wouldn't run go last. */
export async function inspectCopies(candidates: CodexCandidate[]): Promise<CodexCopy[]> {
  const copies = await Promise.all(candidates.map(async (c) => ({ ...c, ...(await readVersion(c.path)) })))
  return copies
    .map((copy, index) => ({ copy, index }))
    .sort((a, b) => {
      if (a.copy.version && b.copy.version) return compareVersions(b.copy.version, a.copy.version) || a.index - b.index
      if (a.copy.version) return -1
      if (b.copy.version) return 1
      return a.index - b.index
    })
    .map(({ copy }) => copy)
}

/** How to update a copy, by where it came from. */
export function updateHint(source: CodexSource, path?: string): string {
  switch (source) {
    case 'npm':
      return `npm i -g ${NPM_PACKAGE}@latest`
    case 'homebrew':
      // Codex is a cask now; older installs came from the homebrew-core formula.
      return path && /\/Cellar\//.test(realpath(path)) ? 'brew upgrade codex' : 'brew upgrade --cask codex'
    case 'installer':
      return 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
    case 'chatgpt-app':
      return 'Update the ChatGPT app (ChatGPT → Check for Updates…). Codex comes with it.'
    case 'codex-app':
      return 'Update the Codex app, or install the ChatGPT app, which includes Codex.'
    case 'override':
      return 'Replace the build EAON_CODEX_BIN points at.'
    default:
      return `npm i -g ${NPM_PACKAGE}@latest`
  }
}

/** Ways to get Codex, for the "not installed" state. */
export const INSTALL_HINT = `Install the ChatGPT desktop app (Codex comes with it), or run: npm i -g ${NPM_PACKAGE}`

/* ------------------------------------------------------- the newest release */

export interface LatestVersionCache {
  version: string | null
  checkedAt: number
}

/** npm's dist-tags for the package; tiny compared with the full packument. */
export const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${NPM_PACKAGE}/dist-tags`
/** Checked at most this often; a failed check keeps the last answer. */
export const LATEST_TTL_MS = 6 * 60 * 60_000

export interface LatestVersionDeps {
  read: () => LatestVersionCache | null
  write: (value: LatestVersionCache) => void
  fetch?: typeof fetch
  now?: () => number
  offline?: boolean
}

/**
 * The newest stable Codex on npm (`latest` dist-tag), from a cache at most
 * six hours old. Offline or when npm doesn't answer, the last known answer is
 * kept — never replaced by nothing — and null only if there never was one.
 */
export async function latestVersion(deps: LatestVersionDeps, force = false): Promise<string | null> {
  const now = deps.now?.() ?? Date.now()
  const cached = deps.read()
  // A forced check still rides a fresh cache for a minute: Refresh pressed twice shouldn't hit npm twice.
  const fresh = cached && now - cached.checkedAt < (force ? 60_000 : LATEST_TTL_MS)
  if (fresh || deps.offline) return cached?.version ?? null
  try {
    const response = await (deps.fetch ?? fetch)(DIST_TAGS_URL, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`npm answered ${response.status}`)
    const tags = (await response.json()) as Record<string, unknown>
    const version = typeof tags.latest === 'string' ? parseVersion(tags.latest) : null
    if (!version) throw new Error('npm sent no latest version')
    deps.write({ version, checkedAt: now })
    return version
  } catch {
    return cached?.version ?? null
  }
}
