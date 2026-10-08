/**
 * The ADE's terminal view: a grid of real terminals in the project folder,
 * each running a shell or a CLI coding agent (Eaon Code, Eaon CLI, Claude Code, Codex…).
 * Shells live in the main process (`features/terminals/`) so they outlive the
 * renderer; the renderer only draws them (`components/code/terminal/`).
 */

export const TERMINAL_AGENT_IDS = ['shell', 'eaon-code', 'eaon-cli', 'claude', 'codex', 'antigravity', 'opencode'] as const
export type TerminalAgentId = (typeof TERMINAL_AGENT_IDS)[number]

/**
 * A pane's agent as saved by an older version, made current. Gemini CLI was
 * replaced by Antigravity; a pane saved as Gemini (or anything else this
 * version doesn't know) comes back as a plain shell.
 */
export function knownAgent(agent: unknown): TerminalAgentId {
  return (TERMINAL_AGENT_IDS as readonly unknown[]).includes(agent) ? (agent as TerminalAgentId) : 'shell'
}

/** CLIs older versions ran in panes and this one no longer does. */
const RETIRED_AGENTS: Record<string, string> = { gemini: 'Gemini CLI' }

/**
 * A saved pane made current. One whose agent this version no longer runs
 * comes back as a shell — and says so in its name, rather than still being
 * called "Gemini CLI" while a plain shell runs in it.
 */
export function currentPane(pane: TerminalPaneSpec): TerminalPaneSpec {
  const agent = knownAgent(pane.agent)
  if (agent === pane.agent) return pane
  const was = RETIRED_AGENTS[String(pane.agent)] ?? (typeof pane.agent === 'string' && pane.agent ? pane.agent : null)
  return { ...pane, agent, name: was ? `Shell (was ${was})` : pane.name || 'Shell' }
}

export interface TerminalAgent {
  id: TerminalAgentId
  label: string
  /** What is typed into the shell once its prompt appears; null for a plain shell. */
  command: string | null
  /** Whether the CLI was found on this machine's PATH (always true for the shell). */
  installed: boolean
  /** Where to get it when it is missing. */
  installHint?: string
}

/** One pane in a folder's grid, as saved between launches. */
export interface TerminalPaneSpec {
  id: string
  name: string
  agent: TerminalAgentId
  /**
   * A conversation of `agent` to reopen when the pane first starts (a past
   * Claude Code or Codex conversation picked in the ADE's sidebar). After
   * that the pane's record of what it runs takes over, as for any pane.
   */
  resume?: string
}

/** Every folder's panes, keyed by folder path. */
export type TerminalLayout = Record<string, TerminalPaneSpec[]>

export interface TerminalSpawnRequest {
  paneId: string
  cwd: string
  cols: number
  rows: number
  /** Typed into the shell once it is ready. */
  command: string | null
  /** What runs in the pane; Eaon Code panes get Eaon's API keys when Settings → Eaon Code shares them. */
  agent?: TerminalAgentId
  /** A conversation of `agent` to reopen instead of starting a new one. */
  resume?: string
}

export interface TerminalSpawnResult {
  ok: boolean
  error?: string
  /** macOS's privacy settings keep Eaon out of the folder; the pane offers to open them. */
  privacy?: boolean
  /** The pane already had a live shell for this folder; nothing was restarted. */
  reattached?: boolean
  /**
   * With `reattached`: the shell's recent output, so a renderer that was
   * reloaded (and lost its scrollback) can draw the screen again.
   */
  replay?: string
  /**
   * The pane was brought back from the last time Eaon ran: what it showed
   * then, to draw before its shell starts. The agent it was running is
   * resumed by the command main typed into it.
   */
  restored?: string
}

/** The agent running in a pane changed — the user quit one CLI and started another. */
export interface TerminalAgentEvent {
  paneId: string
  agent: TerminalAgentId
}

export interface TerminalDataEvent {
  paneId: string
  data: string
}

export interface TerminalExitEvent {
  paneId: string
  exitCode: number
  signal?: number
  /** True when the app ended it (close, restart); false when it exited on its own. */
  requested: boolean
}

/** Names panes get, in order — a grid of "Cynthia" and "Andy" is easier to talk about than "Terminal 3". */
export const PANE_NAMES = [
  'Cynthia',
  'Andy',
  'Sarah',
  'David',
  'Maya',
  'Leo',
  'Iris',
  'Theo',
  'Nora',
  'Felix',
  'Ruby',
  'Oscar',
  'Hazel',
  'Milo',
  'Ada',
  'Jonah'
]

/** Grid shape for a pane count: 1 → 1×1, 2 → 2×1, 3–4 → 2×2, 5–6 → 3×2, 7–9 → 3×3, more → 4 wide. */
export function gridColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}

/**
 * What to tell someone whose terminal couldn't start because macOS keeps Eaon
 * out of its folder (Privacy & Security → Files and Folders). Everything Eaon
 * starts is held to Eaon's permissions, so a shell there can't even list it:
 * Homebrew's startup says "the current working directory must be readable"
 * and Claude Code fails with "An unknown error occurred (Unexpected)".
 */
export function privacyBlockedMessage(cwd: string, home: string): string {
  const h = home.replace(/[\\/]+$/, '')
  const top = cwd.startsWith(`${h}/`) ? cwd.slice(h.length + 1).split('/')[0] : null
  const named: Record<string, string> = { Downloads: 'Downloads Folder', Documents: 'Documents Folder', Desktop: 'Desktop Folder' }
  const where = top && named[top] ? `turn on Eaon → ${named[top]}` : 'give Eaon access to this folder (or Full Disk Access)'
  return `macOS isn’t letting Eaon open this folder, so nothing started here could read it. In System Settings → Privacy & Security → Files and Folders, ${where}, then restart this terminal.`
}
