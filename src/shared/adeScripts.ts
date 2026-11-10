/**
 * A project's scripts for its ADE sessions: one command each for what to do
 * when a session's worktree is made (install dependencies), to run the app,
 * and to clean up when a session is archived.
 *
 * They are kept in Eaon, per project, written by the person who owns the
 * project: never read from a file in the repository, where a repository you
 * cloned could start a command the moment you made a session in it. Each one
 * is shown in full before it runs: in the New session dialog (setup), on the
 * Run button, in the Archive dialog (teardown).
 */

export interface ProjectScripts {
  /** Run in a terminal named Setup when a new session's worktree is made, if the dialog's box is ticked. */
  setup?: string
  /** The top bar's Run button: starts it in a terminal named Run. */
  run?: string
  /** Run before a session is archived, if the Archive dialog's box is ticked; archiving waits for it. */
  teardown?: string
  /** The New session dialog starts with the setup box ticked. */
  setupOnNew?: boolean
}

export type ScriptKind = 'setup' | 'run' | 'teardown'

export const SCRIPT_KINDS: ScriptKind[] = ['setup', 'run', 'teardown']

/** Longest command kept: a script that long is a file, and the command is `sh that-file`. */
export const SCRIPT_MAX = 1000

/** A command as typed in a one-line field: trimmed, on one line (a line break would start a second command unseen), and no longer than a command should be. */
export function cleanCommand(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const one = value.replace(/[\r\n]+/g, ' ').trim()
  return one ? one.slice(0, SCRIPT_MAX) : null
}

/** A project's scripts as stored, made current: only the known commands, cleaned; nothing set means nothing kept. */
export function cleanScripts(raw: unknown): ProjectScripts {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: ProjectScripts = {}
  for (const kind of SCRIPT_KINDS) {
    const command = cleanCommand(v[kind])
    if (command) out[kind] = command
  }
  // Ticking setup for every new session means nothing without a setup command.
  if (v.setupOnNew === true && out.setup) out.setupOnNew = true
  return out
}

/** Every project's scripts as stored, made current; projects with none are dropped. */
export function cleanAllScripts(raw: unknown): Record<string, ProjectScripts> {
  const out: Record<string, ProjectScripts> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [project, scripts] of Object.entries(raw as Record<string, unknown>)) {
    const clean = cleanScripts(scripts)
    if (project && Object.keys(clean).length > 0) out[project] = clean
  }
  return out
}

export interface ScriptRun {
  ok: boolean
  /** The command that ran. */
  command: string
  /** Its exit code; null when it was ended (timed out) or never started. */
  code: number | null
  timedOut: boolean
  /** The end of what it printed, with colour codes taken out. */
  output: string
}

/** What to tell the user about a script that didn't succeed. */
export function failureText(kind: string, run: ScriptRun): string {
  const how = run.timedOut ? 'ran too long and was stopped' : run.code === null ? 'didn’t start' : `failed (exit code ${run.code})`
  const tail = run.output.trim().split('\n').slice(-6).join('\n').trim()
  return `The ${kind} script ${how}.${tail ? `\n${tail}` : ''}`
}
