import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EAON_CODE_INSTALLER } from '@shared/eaonCode'
import { checkNode, findOnPath, NODE_REQUIREMENT, run } from './locate'

/**
 * Git for Windows' bash, which install.sh needs there. The `bash.exe` that
 * Windows itself puts on PATH is WSL's, and would install into Linux instead.
 */
export function findBash(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (platform !== 'win32') return findOnPath('bash') ?? (existsSync('/bin/bash') ? '/bin/bash' : null)
  const git = findOnPath('git')
  const candidates = [
    // git.exe lives in Git\cmd (or Git\bin); bash.exe is in Git\bin.
    ...(git ? [join(dirname(git), '..', 'bin', 'bash.exe'), join(dirname(git), 'bash.exe')] : []),
    join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')] : [])
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}

/**
 * Turns the installer's failure output into the one thing the user can do
 * about it. install.sh reports its own checks as `eaon-code: <reason>` and
 * exits, so that line is the answer when there is one.
 */
export function explainInstallFailure(output: string, code: number | null): string {
  const own = /^eaon-code: (.+)$/m.exec(output)?.[1]?.trim()
  if (own) return `${own.charAt(0).toUpperCase()}${own.slice(1)}`
  if (/EACCES|permission denied/i.test(output)) {
    return 'The installer could not write to a folder it needs (permission denied). Check that you own ~/.local, then try again.'
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|Could not resolve host|unable to access/i.test(output)) {
    return 'The installer could not reach GitHub or the npm registry. Check your internet connection or proxy settings and try again.'
  }
  const last = output
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .slice(-3)
    .join(' ')
  return `The installer stopped with code ${code ?? 'unknown'}${last ? `: ${last}` : '.'}`
}

export interface InstallOptions {
  env?: NodeJS.ProcessEnv
  /** The installer script's text. Fetched from GitHub by default; swappable for tests. */
  fetchScript?: () => Promise<string>
}

async function downloadInstaller(): Promise<string> {
  const response = await fetch(EAON_CODE_INSTALLER, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the installer.`)
  return response.text()
}

let running: Promise<{ ok: boolean; message: string }> | null = null

/**
 * Runs Eaon Code's own installer, the README's
 * `curl -fsSL …/install.sh | bash`. It clones eaonlabs/eaon-code into
 * ~/.local/share/eaon-code, or brings an existing clone up to the latest
 * commit, and builds it. So the same run installs and updates.
 *
 * One run at a time: two would build in the same folder at once. A second
 * caller (another window, say) gets the run already going.
 */
export function installEaonCode(onLog: (line: string) => void, options: InstallOptions = {}): Promise<{ ok: boolean; message: string }> {
  running ??= runInstaller(onLog, options).finally(() => {
    running = null
  })
  return running
}

async function runInstaller(onLog: (line: string) => void, options: InstallOptions): Promise<{ ok: boolean; message: string }> {
  const env = options.env ?? process.env
  const node = await checkNode()
  if (!node.path) {
    return { ok: false, message: `Node.js was not found on your PATH. Install Node ${NODE_REQUIREMENT} from nodejs.org, then try again.` }
  }
  if (!node.ok) {
    return {
      ok: false,
      message: `Eaon Code needs Node ${NODE_REQUIREMENT}, but your PATH has Node ${node.version ?? '(unknown)'} at ${node.path}. Install a newer Node (for example \`nvm install 22\`), then try again.`
    }
  }
  if (!findOnPath('npm')) {
    return { ok: false, message: 'npm was not found on your PATH. It ships with Node.js: reinstall Node from nodejs.org, then try again.' }
  }
  // macOS has a `git` stub that only offers to install the developer tools, so it is run, not just found.
  const git = findOnPath('git')
  if (!git || !(await run(git, ['--version'], { timeoutMs: 10_000 })).ok) {
    return {
      ok: false,
      message:
        process.platform === 'darwin'
          ? 'The installer needs Git. Run `xcode-select --install` in Terminal to get it, then try again.'
          : 'The installer needs Git. Install it from git-scm.com, then try again.'
    }
  }
  const bash = findBash(process.platform, env)
  if (!bash) {
    return { ok: false, message: 'The installer is a bash script. Install Git for Windows from git-scm.com (it includes Git Bash), then try again.' }
  }

  onLog(`Downloading ${EAON_CODE_INSTALLER}`)
  let script: string
  try {
    script = await (options.fetchScript ?? downloadInstaller)()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Could not download Eaon Code's installer: ${reason}` }
  }

  const folder = mkdtempSync(join(tmpdir(), 'eaon-code-install-'))
  const file = join(folder, 'install.sh')
  writeFileSync(file, script, { mode: 0o700 })
  onLog('$ bash install.sh')
  try {
    return await new Promise((resolve) => {
      let output = ''
      const child = spawn(bash, [file], { cwd: homedir(), env, windowsHide: true })
      const collect = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        output = (output + text).slice(-20_000)
        for (const line of text.split('\n')) if (line.trim()) onLog(line)
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.on('error', (error) => resolve({ ok: false, message: `Could not run the installer: ${error.message}` }))
      child.on('close', (code) =>
        resolve(code === 0 ? { ok: true, message: 'Eaon Code is installed.' } : { ok: false, message: explainInstallFailure(output, code) })
      )
    })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}
