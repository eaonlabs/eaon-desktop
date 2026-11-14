/**
 * Work from the other apps that run coding agents in worktrees (Conductor,
 * Orca, Paradev (Superset), Claude Squad, T3 Code, Synara, Crystal), brought
 * into the ADE: each of their
 * sessions becomes an ADE session on the same folder and branch, with its
 * Claude Code or Codex conversation reopened in a pane, and a project's
 * setup, run and archive scripts become its scripts in Eaon.
 *
 * Only what those apps keep about the work is read: folders, branches, names,
 * the agent's conversation id and the scripts. Never their accounts, tokens or
 * chats, and nothing in them is changed. Every read is on this computer.
 */

export type AgentAppId = 'conductor' | 'orca' | 'superset' | 'claude-squad' | 't3code' | 'synara' | 'crystal'

/** The agents whose conversations an imported session can reopen. */
export type ForeignAgent = 'claude' | 'codex'

/** A session another app has, as Import shows it before anything is brought in. */
export interface ForeignSession {
  /** `app:cwd`: what the window sends back to import it. */
  key: string
  app: AgentAppId
  /** The name the other app gave it; null names it after its branch, as the ADE does. */
  title: string | null
  /** The folder its agents ran in (a worktree, usually). */
  cwd: string
  /** The repository it belongs to, when the other app says. */
  project: string | null
  branch: string | null
  /** The agent it ran, and that agent's conversation to reopen, when the other app kept them. */
  agent: ForeignAgent | null
  resume: string | null
  /** When it was last used (ms); 0 when the other app doesn't say. */
  touched: number
  /** Archived in the other app: it comes in archived too. */
  archived: boolean
  /** The ADE has a session for this folder already. */
  already: boolean
}

/** When a project's command runs: as a new session's worktree is made, from Run, or as a session is archived. */
export type ForeignScriptWhen = 'setup' | 'run' | 'teardown' | null

/** One of a project's commands in another app. */
export interface ForeignCommand {
  name: string
  command: string
  when: ForeignScriptWhen
}

/**
 * A project's scripts in another app, as Import shows them: every command in
 * full, before any is kept. Brought in, setup, run and teardown become the
 * project's ADE scripts (when it has none), and the setup and run commands
 * (and any other named ones) its scripts in Chat, each still shown before it
 * runs.
 */
export interface ForeignScripts {
  key: string
  app: AgentAppId
  project: string
  commands: ForeignCommand[]
  /** Where the other app keeps them: a file in the project (conductor.json) or its own settings. */
  source: string
}

export interface AgentAppScan {
  id: AgentAppId
  name: string
  sessions: ForeignSession[]
  scripts: ForeignScripts[]
  /** Its data was there but couldn't be read (a newer format, a locked file): said, not hidden. */
  error?: string
}

export interface AgentAppImport {
  sessions: string[]
  scripts: string[]
}

export interface AgentAppImportResult {
  sessions: number
  scripts: number
  /** Picked, but not brought in, with why: the folder is gone, or it was removed from the ADE before. */
  skipped: { key: string; why: string }[]
}

export const AGENT_APP_NAMES: Record<AgentAppId, string> = {
  conductor: 'Conductor',
  orca: 'Orca',
  superset: 'Paradev (Superset)',
  'claude-squad': 'Claude Squad',
  t3code: 'T3 Code',
  synara: 'Synara',
  crystal: 'Crystal'
}

/** A Claude Code or Codex conversation id the ADE can reopen: the same rule as a pane's resume (terminals.ts). */
export const resumableId = (value: unknown): string | null =>
  typeof value === 'string' && /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ses_[A-Za-z0-9]+)$/i.test(value.trim()) ? value.trim() : null

/** "claude-code", "Claude", "codex-cli"… as one of the agents a session can reopen, or null. */
export function foreignAgent(value: unknown): ForeignAgent | null {
  if (typeof value !== 'string') return null
  const v = value.toLowerCase()
  if (v.includes('claude')) return 'claude'
  if (v.includes('codex')) return 'codex'
  return null
}

/** A time the other app wrote (ms, seconds, or an ISO date) as ms, or 0. */
export function whenOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return whenOf(n)
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}
