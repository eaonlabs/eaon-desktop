import { spawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { findOnPath, run } from './locate'

/** POSIX single-quote a word for the shell line Terminal runs. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** Escape for an AppleScript string literal. */
const appleString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * Arguments for `cmd.exe`, spawned with windowsVerbatimArguments, that open a
 * console window titled `title` running `parts` and staying open afterwards.
 *
 * `cmd /k` strips the first and last quote of its line whenever it holds
 * more than two, so `"C:\Program Files\nodejs\node.exe" "…cli.js"` ran
 * `C:\Program`. With `/s` it always strips exactly those two, so the line
 * gets one more pair around it. The cmd that runs `start` reads each part
 * as outside quotes, though, so its metacharacters are escaped for that
 * reading with ^, which it removes before `start` sees them.
 */
export function cmdKeepOpenArgs(title: string, parts: string[]): string[] {
  const line = parts.map((part) => `"${part.replace(/"/g, '').replace(/[&|<>^]/g, '^$&')}"`).join(' ')
  return ['/c', 'start', `"${title.replace(/["&|<>^%]/g, '')}"`, 'cmd.exe', '/s', '/k', `"${line}"`]
}

/**
 * Starts a program that outlives the app, resolving with why it could not
 * start, or null once it has. Without an 'error' listener a failed spawn — a
 * folder that has gone, a terminal that will not run — is an uncaught
 * exception in the main process.
 */
export function launchDetached(command: string, args: string[], options: SpawnOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, detached: true, stdio: 'ignore' })
    child.on('error', (error) => resolve(error.message))
    child.once('spawn', () => {
      child.unref()
      resolve(null)
    })
  })
}

/**
 * Linux has no standard terminal, so these are tried in turn, each with its
 * own way of being handed a command. xdg-terminal-exec runs whichever the
 * user chose; Ptyxis (Fedora 41's default) and GNOME Console (kgx) come
 * before the older names, which they often do not provide.
 */
const LINUX_TERMINALS: [string, (argv: string[], cwd?: string) => string[]][] = [
  ['xdg-terminal-exec', (argv) => argv],
  ['ptyxis', (argv) => ['--', ...argv]],
  ['kgx', (argv) => ['--', ...argv]],
  ['x-terminal-emulator', (argv) => ['-e', ...argv]],
  ['gnome-terminal', (argv, cwd) => [...(cwd ? [`--working-directory=${cwd}`] : []), '--', ...argv]],
  ['konsole', (argv, cwd) => [...(cwd ? ['--workdir', cwd] : []), '-e', ...argv]],
  ['xterm', (argv) => ['-e', ...argv]]
]

/** Opens a new terminal window on Linux running `argv`, trying the next terminal if one will not start. */
export async function openLinuxTerminal(argv: string[], cwd?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let failure: string | null = null
  for (const [name, terminalArgs] of LINUX_TERMINALS) {
    const path = findOnPath(name)
    if (!path) continue
    const error = await launchDetached(path, terminalArgs(argv, cwd), { cwd })
    if (!error) return { ok: true }
    failure ??= `${name}: ${error}`
  }
  return {
    ok: false,
    error: failure
      ? `The terminal did not open (${failure}).`
      : `No terminal app found (tried ${LINUX_TERMINALS.map(([name]) => name).join(', ')}).`
  }
}

/**
 * Opens a real terminal in `cwd` running Eaon Code — the escape hatch for
 * anything the Code tab does not cover (the full TUI, /login, /tree, themes).
 * With `sessionFile`, the terminal continues that session.
 */
export async function openInTerminal(
  cwd: string,
  launch: { command: string; args: string[] },
  sessionFile?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const binary = launch.command
  const args = [...launch.args, ...(sessionFile ? ['--session', sessionFile] : [])]
  if (!existsSync(cwd)) return { ok: false, error: `The folder ${cwd} does not exist.` }

  if (process.platform === 'darwin') {
    const line = `cd ${shellQuote(cwd)} && ${[binary, ...args].map(shellQuote).join(' ')}`
    const result = await run('/usr/bin/osascript', [
      '-e',
      `tell application "Terminal" to do script ${appleString(line)}`,
      '-e',
      'tell application "Terminal" to activate'
    ])
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.stderr.trim() || result.error || 'Terminal did not open.' }
  }

  if (process.platform === 'win32') {
    // The cmd.exe that runs `start` has no console (detached), so nothing flashes before the window opens.
    const error = await launchDetached('cmd.exe', cmdKeepOpenArgs('Eaon Code', [binary, ...args]), { cwd, windowsVerbatimArguments: true })
    return error ? { ok: false, error: `The terminal did not open: ${error}` } : { ok: true }
  }

  // Terminals that hand the window to a running server (gnome-terminal,
  // Ptyxis) do not start in the spawn's folder, so the line changes into it.
  const line = `cd ${shellQuote(cwd)} && ${[binary, ...args].map(shellQuote).join(' ')}; exec "\${SHELL:-/bin/sh}"`
  return openLinuxTerminal(['sh', '-c', line], cwd)
}
