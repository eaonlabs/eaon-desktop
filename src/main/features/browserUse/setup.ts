import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Browser Use (github.com/browser-use/browser-use, MIT) is a Python program.
 * Setup puts it, and a Python of its own, in Eaon's data folder with uv
 * (github.com/astral-sh/uv, Apache-2.0): nothing goes into the system Python
 * or the user's home. uv itself is downloaded the first time, pinned and
 * checksummed like Browser Use's version, which is only moved after testing.
 */

export const BROWSER_USE_VERSION = '0.13.11'
export const PYTHON_VERSION = '3.12'
const UV_VERSION = '0.12.24'

/** uv's release archive for each platform, and its SHA-256 from the release. */
const UV: Record<string, { target: string; sha256: string }> = {
  'darwin-arm64': { target: 'aarch64-apple-darwin', sha256: '0c4346de7abdb49495b393b9ec809fe387aa43e586be20fecb972216c1e71732' },
  'darwin-x64': { target: 'x86_64-apple-darwin', sha256: '4fa82e37cb94767661f532b001e470b67a186c7260e305bd84ddb78fd545c0b6' },
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', sha256: 'b4dfaef47d491a7296981f8374a4595f55dbf84e8937c8ecd2983574d8bb3da6' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', sha256: '5231be65f496304623895dacdbf1de8504fec90303684bdf05805aa34414dd21' },
  'win32-x64': { target: 'x86_64-pc-windows-msvc', sha256: '7c38608c8a18ee137d748a1773053b07ec8f3a30fab49aebaa6f4e4efeceb019' },
  'win32-arm64': { target: 'aarch64-pc-windows-msvc', sha256: '4b783bda5cc44bbae0651a837223873a7acee31152381aef5fc86ef6bef25997' }
}

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

/** Where everything lives, under one folder in Eaon's data. */
export function layout(root: string) {
  return {
    root,
    uv: join(root, 'uv', UV_VERSION, exe('uv')),
    tools: join(root, 'tools'),
    bin: join(root, 'bin'),
    python: join(root, 'python'),
    browserUse: join(root, 'bin', exe('browser-use')),
    stamp: join(root, 'installed.json'),
    /** Browser Use's own config and scratch files: never the user's home. */
    config: join(root, 'config'),
    home: join(root, 'home')
  }
}

export interface InstallState {
  installed: boolean
  version: string | null
}

export function installState(root: string): InstallState {
  const paths = layout(root)
  try {
    const stamp = JSON.parse(readFileSync(paths.stamp, 'utf8')) as { version?: string }
    if (existsSync(paths.browserUse) && stamp.version === BROWSER_USE_VERSION) return { installed: true, version: stamp.version }
    return { installed: false, version: stamp.version ?? null }
  } catch {
    return { installed: false, version: null }
  }
}

/** The environment uv runs with: everything inside `root`, only uv's own Pythons, no user config. */
export function uvEnv(root: string, cache: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const paths = layout(root)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  return {
    ...env,
    UV_TOOL_DIR: paths.tools,
    UV_TOOL_BIN_DIR: paths.bin,
    UV_PYTHON_INSTALL_DIR: paths.python,
    UV_PYTHON_BIN_DIR: join(root, 'python-bin'),
    UV_CACHE_DIR: cache,
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_NO_CONFIG: '1',
    UV_NO_MODIFY_PATH: '1'
  }
}

export type SetupProgress = (step: string) => void

async function fetchUv(root: string, progress: SetupProgress, fetchImpl: typeof fetch): Promise<string> {
  const paths = layout(root)
  if (existsSync(paths.uv)) return paths.uv
  const key = `${process.platform}-${process.arch}`
  const spec = UV[key]
  if (!spec) throw new Error(`Browser control isn't available for ${key} yet.`)
  const archive = `uv-${spec.target}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`
  progress('Downloading the Python installer…')
  const response = await fetchImpl(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${archive}`)
  if (!response.ok) throw new Error(`Couldn't download uv (${response.status}). Check your connection and try again.`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== spec.sha256) throw new Error('The downloaded Python installer failed its checksum, so it was not used.')
  const work = join(root, 'uv', `.download-${process.pid}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, archive), bytes)
  // bsdtar unpacks both formats, and ships with macOS, Linux and Windows 10+.
  await run('tar', ['-xf', join(work, archive), '-C', work], {})
  const found = [join(work, `uv-${spec.target}`, exe('uv')), join(work, exe('uv'))].find((p) => existsSync(p))
  if (!found) throw new Error("uv's archive didn't have uv in it.")
  mkdirSync(join(paths.uv, '..'), { recursive: true })
  renameSync(found, paths.uv)
  if (process.platform !== 'win32') chmodSync(paths.uv, 0o755)
  rmSync(work, { recursive: true, force: true })
  return paths.uv
}

function run(command: string, args: string[], env: Record<string, string>, onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: Object.keys(env).length ? env : process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const take = (chunk: Buffer): void => {
      const text = String(chunk)
      tail = (tail + text).slice(-2000)
      for (const line of text.split(/\r?\n|\r/)) if (line.trim()) onLine?.(line.trim())
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(tail.trim().split('\n').pop() || `${command} failed (${code})`))))
  })
}

/** uv's lines, as steps a person can follow. */
function stepOf(line: string): string | null {
  if (/download.*cpython|installing python|cpython-/i.test(line)) return 'Getting Python…'
  if (/^resolved \d+/i.test(line)) return 'Working out what Browser Use needs…'
  if (/^(prepared|downloading|downloaded)\b/i.test(line)) return 'Downloading Browser Use…'
  if (/^installed \d+ packages?/i.test(line)) return 'Installing…'
  return null
}

let installing: Promise<InstallState> | null = null

/** Installs (or repairs) Browser Use. One install at a time; a second caller waits for the first. */
export function install(root: string, progress: SetupProgress = () => undefined, fetchImpl: typeof fetch = fetch): Promise<InstallState> {
  return (installing ??= (async () => {
    const paths = layout(root)
    mkdirSync(root, { recursive: true })
    const uv = await fetchUv(root, progress, fetchImpl)
    // The download cache is only needed while installing: nearly 300 MB, dropped after.
    const cache = join(tmpdir(), `eaon-uv-cache-${process.pid}`)
    try {
      progress('Getting Python…')
      await run(uv, ['tool', 'install', '--force', '--python', PYTHON_VERSION, `browser-use==${BROWSER_USE_VERSION}`], uvEnv(root, cache), (line) => {
        const step = stepOf(line)
        if (step) progress(step)
      })
    } finally {
      rmSync(cache, { recursive: true, force: true })
    }
    if (!existsSync(paths.browserUse)) throw new Error("Browser Use installed, but its program isn't where it should be.")
    writeFileSync(paths.stamp, JSON.stringify({ version: BROWSER_USE_VERSION, at: new Date().toISOString() }))
    progress('Ready')
    return installState(root)
  })().finally(() => (installing = null)))
}

/** Removes Browser Use, its Python and uv: everything setup put there. */
export function uninstall(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
