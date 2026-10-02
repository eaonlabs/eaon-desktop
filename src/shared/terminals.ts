/**
 * The ADE's terminal view: a grid of real terminals in the project folder,
 * each running a shell or a CLI coding agent (Eaon Code, Claude Code, Codex…).
 * Shells live in the main process (`features/terminals/`) so they outlive the
 * renderer; the renderer only draws them (`components/code/terminal/`).
 */

export type TerminalAgentId = 'shell' | 'eaon-code' | 'claude' | 'codex' | 'gemini' | 'opencode'

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
}

export interface TerminalSpawnResult {
  ok: boolean
  error?: string
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
