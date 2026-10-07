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

/** Variables an AppImage's runtime points into its own mount, which nothing Eaon starts should inherit. */
const APPIMAGE_LISTS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']

/**
 * Takes the AppImage's own entries back out of the environment. Its runtime
 * prepends folders inside the mounted image so Electron can find its
 * libraries, and leaves empty and relative entries (`.`, `./share/`) that
 * resolve against whatever folder a process starts in. Inherited by a
 * terminal, `run_command`, an MCP server or llama-server, they load the
 * image's libraries instead of the system's, or break outright once the image
 * is unmounted. APPIMAGE and APPDIR themselves stay: the updater needs them.
 */
export function leaveAppImageEnv(env: NodeJS.ProcessEnv = process.env): void {
  const appDir = env.APPIMAGE && env.APPDIR ? env.APPDIR.replace(/\/+$/, '') : null
  if (!appDir) return
  for (const name of APPIMAGE_LISTS) {
    const value = env[name]
    if (value === undefined) continue
    const kept = value.split(':').filter((entry) => entry.startsWith('/') && entry !== appDir && !entry.startsWith(`${appDir}/`))
    if (kept.length > 0) env[name] = kept.join(':')
    else delete env[name]
  }
}

/**
 * The PATH the user's login shell sets up, or null when it fails, prints
 * nothing useful or takes too long. `giveUpMs` is for tests.
 */
export function loginShellPath(shell: string, giveUpMs = 6000): Promise<string | null> {
  const marker = '__EAON_PATH__'
  const parse = (stdout: string): string | null => new RegExp(`${marker}(.*?)${marker}`).exec(stdout)?.[1] ?? null
  return new Promise<string | null>((resolve) => {
    let printed = ''
    const child = execFile(
      shell,
      // -i loads the interactive rc files where nvm, fnm and Homebrew usually
      // add themselves; -l loads the login profile for everyone else.
      ['-ilc', `printf '${marker}%s${marker}' "$PATH"`],
      // SIGKILL because an interactive shell may ignore the default SIGTERM.
      { timeout: 5000, killSignal: 'SIGKILL', env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true' } },
      (error, stdout) => {
        clearTimeout(giveUp)
        resolve(error && !stdout ? null : parse(stdout))
      }
    )
    // An rc file that asks for input (a prompt, `read`) would otherwise wait
    // on this pipe forever.
    child.stdin?.end()
    child.stdout?.on('data', (chunk) => (printed += String(chunk)))
    // execFile answers only once every pipe has closed, and a process the rc
    // files started in the background (an agent, a daemon) keeps stdout open
    // after the shell itself is gone, kill or no kill. Everything that spawns
    // waits on this lookup, so it gives up instead, with whatever was printed.
    const giveUp = setTimeout(() => {
      child.kill('SIGKILL')
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve(parse(printed))
    }, giveUpMs)
  })
}

async function readLoginShellPath(): Promise<void> {
  // Before the login shell runs, so it starts from a clean environment too.
  leaveAppImageEnv()
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const fromShell = await loginShellPath(shell)

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
