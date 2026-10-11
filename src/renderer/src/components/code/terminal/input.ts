/**
 * Watches what is typed into a pane for `/theme` (or `/themes`) followed by
 * Enter, which opens the ADE's theme picker instead of reaching the CLI.
 *
 * Only a line typed from its start, keystroke by keystroke, counts: anything
 * the watcher cannot follow (arrow keys, a paste, a control key other than
 * the few it knows) makes the line unknown until the next Enter, and an
 * unknown line is never taken. So a `/theme` in the middle of a sentence, or
 * one recalled from history, goes to the CLI as typed.
 *
 * When it does take one, what was typed is erased with Backspaces, which
 * every CLI prompt and shell understands, and the Enter is never sent.
 */

export const THEME_COMMANDS = new Set(['/theme', '/themes'])

/** What has been typed since the last Enter, or null when it can't be known. */
export type LineState = string | null

export interface Fed {
  line: LineState
  /** The Enter that ended a theme command: open the picker, send nothing. */
  command: 'theme' | null
  /** Backspaces to send so the CLI's prompt is empty again. */
  erase: number
}

const BACKSPACE = new Set(['\x7f', '\b'])

/**
 * What the terminal sends on its own, which changes nothing on the line:
 * focus in and out (Claude Code turns focus reporting on, so focusing the
 * pane sends one), mouse reports, and xterm's answers to the questions a CLI
 * asks it when it starts — device attributes, cursor position, mode reports,
 * colours (OSC) and the like (DCS).
 */
const REPORT = new RegExp(
  '^(?:' +
    [
      '\x1b\\[[IO]', // focus
      '\x1b\\[<\\d+;\\d+;\\d+[Mm]', // SGR mouse
      '\x1b\\[M[\\s\\S]{3}', // X10 mouse
      '\x1b\\[[?>=][\\d;]*\\$?[a-zA-Z]', // device attributes, mode reports
      '\x1b\\[\\d+;\\d+R', // cursor position
      '\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)', // OSC answers
      '\x1bP[\\s\\S]*?\x1b\\\\' // DCS answers
    ].join('|') +
    ')+$'
)

export function feedInput(line: LineState, data: string): Fed {
  if (data === '\r') {
    if (line !== null && THEME_COMMANDS.has(line.trim().toLowerCase())) return { line: '', command: 'theme', erase: line.length }
    return { line: '', command: null, erase: 0 }
  }
  // Ctrl+U and Ctrl+C clear the line in shells and CLI prompts alike.
  if (data === '\x15' || data === '\x03') return { line: '', command: null, erase: 0 }
  if (BACKSPACE.has(data)) return { line: line === null ? null : line.slice(0, -1), command: null, erase: 0 }
  if (REPORT.test(data)) return { line, command: null, erase: 0 }
  // Escape on its own closes a CLI's menu or clears its prompt: a fresh line.
  if (data === '\x1b') return { line: '', command: null, erase: 0 }
  // Escape sequences (arrows, a bracketed paste), other control keys, or a
  // chunk carrying a newline: the line is no longer something to follow.
  if (/[\x00-\x1f\x7f]/.test(data)) return { line: null, command: null, erase: 0 }
  return { line: line === null ? null : line + data, command: null, erase: 0 }
}

/** A path as a shell (or a CLI's prompt) reads it back: bare when that is safe, else in single quotes. */
export function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}
