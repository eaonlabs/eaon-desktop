import { spawn } from 'node:child_process'
import { findOnPath, run } from './locate'

/** POSIX single-quote a word for the shell line Terminal runs. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** Escape for an AppleScript string literal. */
const appleString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * Opens a real terminal in `cwd` running Eaon Code — the escape hatch for
 * anything the Code tab does not cover (the full TUI, /login, /tree, themes).
 * With `sessionFile`, the terminal continues that session.
 */
export async function openInTerminal(
  cwd: string,
  binary: string,
  sessionFile?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const args = sessionFile ? ['--session', sessionFile] : []

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
    const quoted = [binary, ...args].map((part) => `"${part}"`).join(' ')
    const child = spawn('cmd.exe', ['/c', 'start', '"Eaon Code"', 'cmd.exe', '/k', quoted], {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true
    })
    child.unref()
    return { ok: true }
  }

  // Linux has no standard terminal; try the common ones in turn.
  const line = `${[binary, ...args].map(shellQuote).join(' ')}; exec "$SHELL"`
  const candidates: [string, string[]][] = [
    ['x-terminal-emulator', ['-e', 'sh', '-c', line]],
    ['gnome-terminal', [`--working-directory=${cwd}`, '--', 'sh', '-c', line]],
    ['konsole', ['--workdir', cwd, '-e', 'sh', '-c', line]],
    ['xterm', ['-e', 'sh', '-c', line]]
  ]
  for (const [name, terminalArgs] of candidates) {
    const path = findOnPath(name)
    if (!path) continue
    const child = spawn(path, terminalArgs, { cwd, detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true }
  }
  return { ok: false, error: 'No terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xterm).' }
}
