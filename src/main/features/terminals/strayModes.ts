/**
 * Terminal modes a program left switched on when it ended.
 *
 * Claude Code, Codex and other full-screen CLIs turn on mouse reporting (and
 * focus reporting) while they run and turn it off as they exit. One that
 * crashes or is killed never does, and the pane's terminal goes on sending
 * every mouse move to whatever has the keyboard: the shell, which prints
 * them as `35;40;26M35;41;26M…` at its prompt, a line a second.
 *
 * A shell never asks for mouse reports. So mouse reports arriving while the
 * shell itself is the pane's foreground program are strays: they are dropped,
 * and the terminal is told to stop sending them (ptyManager `write`).
 */

/** One or more mouse reports and nothing else: SGR (`ESC [ < b ; x ; y M|m`), urxvt (`ESC [ b ; x ; y M`) or X10 (`ESC [ M` + 3 bytes). */
const MOUSE_REPORTS = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[\d+;\d+;\d+M|\x1b\[M[\s\S]{3})+$/

export function isMouseReport(data: string): boolean {
  return data.length > 0 && MOUSE_REPORTS.test(data)
}

/**
 * Written to the pane's terminal (as if the program printed it): every mouse
 * reporting mode off (X10, normal, button-event, any-event, UTF-8, SGR,
 * urxvt, SGR-pixels), focus reporting off, and the cursor shown again, which
 * the same programs hide while they draw.
 */
export const STRAY_MODES_OFF = '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?1004l\x1b[?25h'

/**
 * Whether the pane's foreground program is its shell. `foreground` is what
 * node-pty reports (`proc.process`): a name like `zsh`, or `-zsh` for a login
 * shell. Not on Windows, where ConPTY always names the shell it started.
 */
export function shellInForeground(foreground: string | undefined, shell: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32' || !foreground) return false
  const name = (path: string): string =>
    path
      .split(/[\\/]/)
      .pop()!
      .replace(/^-/, '')
      .toLowerCase()
  return name(foreground) === name(shell)
}
