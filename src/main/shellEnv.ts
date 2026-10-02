import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * Adopts the user's login-shell PATH.
 *
 * An app opened from the Dock or Finder inherits launchd's PATH —
 * `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — so `npx`, `node`,
 * Homebrew's `python3`, `gh` and `eaon-code` all fail to resolve even though
 * they work in the user's terminal. That silently broke every stdio MCP
 * server, most of what the agent tried in `run_command`, and the Code tab.
 * Asking the login shell once at startup fixes all of them together.
 */
let adopted: Promise<void> | null = null

export function adoptLoginShellPath(): Promise<void> {
  return (adopted ??= readLoginShellPath())
}

/** Where `bin` is on PATH (the login shell's, once adopted), or null. */
export function onPath(bin: string): string | null {
  const names = process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin]
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        /* not here */
      }
    }
  }
  return null
}

async function readLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const marker = '__EAON_PATH__'

  const fromShell = await new Promise<string | null>((resolve) => {
    execFile(
      shell,
      // -i loads the interactive rc files where nvm, fnm and Homebrew usually
      // add themselves; -l loads the login profile for everyone else.
      ['-ilc', `printf '${marker}%s${marker}' "$PATH"`],
      { timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true' } },
      (error, stdout) => {
        if (error && !stdout) return resolve(null)
        const match = new RegExp(`${marker}(.*?)${marker}`).exec(stdout)
        resolve(match?.[1] ?? null)
      }
    )
  })

  // Common install locations as a floor, for shells whose rc files print
  // nothing useful or time out.
  const home = homedir()
  const floor = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(home, '.local/bin'),
    join(home, '.bun/bin'),
    join(home, '.cargo/bin'),
    join(home, '.volta/bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]

  const parts = [...(fromShell?.split(delimiter) ?? []), ...(process.env.PATH?.split(delimiter) ?? []), ...floor]
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(delimiter)
}
