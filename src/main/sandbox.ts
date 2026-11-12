import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { normalizeSandbox, seatbeltProfile } from '@shared/sandbox'
import type { Settings } from '@shared/types'

/**
 * Runs the agent's shell commands inside macOS's Seatbelt when the person has
 * turned the sandbox on (shared/sandbox.ts has the profile). Anywhere else the
 * switch can't do what it says, so a command is refused rather than run
 * unprotected.
 */

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

export const sandboxAvailable = (platform: NodeJS.Platform = process.platform): boolean => platform === 'darwin' && existsSync(SANDBOX_EXEC)

export const SANDBOX_UNAVAILABLE =
  'The command sandbox is turned on in Settings → General, but it only works on macOS. Turn it off there to run commands on this computer, or ask the user to.'

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The repository's git folder when `cwd` is a worktree (it lives outside the folder, and git writes to it). */
function gitCommonDir(cwd: string): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', ['rev-parse', '--git-common-dir'], { cwd, timeout: 3000, windowsHide: true }, (error, stdout) => {
      const out = String(stdout ?? '').trim()
      done(error || !out ? null : real(isAbsolute(out) ? out : resolve(cwd, out)))
    })
  })
}

export interface SandboxedSpawn {
  file: string
  args: string[]
}

/**
 * How to start `command` in `cwd` under the person's sandbox setting: null
 * when it is off; the wrapped invocation when it is on; a thrown error when it
 * is on and can't be honoured.
 */
export async function sandboxedSpawn(command: string, cwd: string, shell: string, settings: Pick<Settings, 'general'> | undefined, extraRoots: readonly string[] = []): Promise<SandboxedSpawn | null> {
  const config = normalizeSandbox(settings?.general.sandbox)
  if (!config.enabled) return null
  if (!sandboxAvailable()) throw new Error(SANDBOX_UNAVAILABLE)
  const folder = real(cwd)
  const common = await gitCommonDir(folder)
  const tmp = [...new Set([real(tmpdir()), '/private/tmp', '/private/var/folders'])]
  const profile = seatbeltProfile({ cwd: folder, home: real(homedir()), tmp, writable: [...(common && !common.startsWith(`${folder}/`) ? [common] : []), ...extraRoots.map(real)], network: config.network })
  return { file: SANDBOX_EXEC, args: ['-p', profile, shell, '-c', command] }
}
