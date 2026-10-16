import path from 'node:path'

/**
 * Writing a command line for a pane's shell, in that shell's own syntax.
 *
 * On macOS and Linux a pane runs a POSIX shell. On Windows it runs
 * PowerShell (cmd.exe only where there is no PowerShell at all), and POSIX
 * quoting goes wrong there twice over: a quoted program path is a string
 * PowerShell prints rather than a program it runs (it needs `& 'path'`), and
 * `'\''` is no way to put an apostrophe in a PowerShell string (`''` is).
 */

export type ShellKind = 'posix' | 'powershell' | 'cmd'

/** Which syntax `shell` reads. Anything else on Windows (Git Bash, WSL) is POSIX. */
export function shellKindOf(shell: string, platform: NodeJS.Platform = process.platform): ShellKind {
  if (platform !== 'win32') return 'posix'
  const name = path.win32.basename(shell).toLowerCase()
  if (/^(pwsh|powershell)(\.exe)?$/.test(name)) return 'powershell'
  if (/^cmd(\.exe)?$/.test(name)) return 'cmd'
  return 'posix'
}

/** PowerShell takes the typographic single quotes as quotes too, so each is doubled like `'`. */
const POWERSHELL_QUOTES = /['‘’‚‛]/g

/**
 * One argument, as the shell reads it back: bare when that is safe, else
 * quoted. PowerShell's and cmd's bare sets are smaller than POSIX's: a comma
 * makes a PowerShell array, `@` splats, and `%` expands in cmd.
 */
export function quoteArg(value: string, kind: ShellKind): string {
  if (kind === 'posix') return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
  if (/^[\w.:\\/-]+$/.test(value)) return value
  if (kind === 'powershell') return `'${value.replace(POWERSHELL_QUOTES, (q) => q + q)}'`
  return `"${value.replace(/"/g, '""')}"`
}

/** A program's path typed as the command to run. PowerShell runs a quoted one only after `&`. */
export function quoteCommand(program: string, kind: ShellKind): string {
  const quoted = quoteArg(program, kind)
  return kind === 'powershell' && quoted !== program ? `& ${quoted}` : quoted
}
