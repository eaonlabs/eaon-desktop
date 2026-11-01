import type { TerminalAgentId } from './terminals'

/**
 * What an ADE terminal's coding agent may do without asking (Settings →
 * Agent providers). Each CLI has its own switches for this; a choice here is
 * the one an agent is started with, in terminals opened from then on. "Its
 * own settings" starts it plainly, so it follows what its own config says.
 */

export const AGENT_PERMISSIONS = ['own', 'ask', 'edits', 'auto', 'full'] as const
export type AgentPermission = (typeof AGENT_PERMISSIONS)[number]
/** A row's choice: one of those, or whatever "All agents" is set to. */
export type AgentPermissionChoice = AgentPermission | 'all'

type Switched = Exclude<AgentPermission, 'own'>

interface Launch {
  /** The flags for each choice the CLI has a switch for. */
  args?: Partial<Record<Switched, string>>
  /** Or the environment it reads it from instead (Goose). */
  env?: Partial<Record<Switched, Record<string, string>>>
  /** Where what a choice does differs from the general description. */
  notes?: Partial<Record<Switched, string>>
}

/**
 * Each CLI's switches. Claude Code 2.1.304, Codex 0.166, Gemini CLI 0.66,
 * Qwen Code 0.26, Cursor 2026.10.22, Copilot 1.0.105, Hermes 0.16 and
 * Crush 0.99 were checked against their own `--help` and argument parsing
 * (Codex's also in front of `resume`), and Amp's parser takes its
 * `--dangerously-allow-all`, which its help no longer lists; Grok Build,
 * Kimi, Aider and Goose are as their docs give them. A CLI without a switch
 * for a choice isn't offered it.
 */
export const PERMISSION_LAUNCH: Partial<Record<TerminalAgentId, Launch>> = {
  claude: {
    args: {
      // `default`, not `manual`: 2.1.304 lists `manual` but maps it to
      // `default`, which it still takes, and older Claude Codes know only `default`.
      ask: '--permission-mode default',
      edits: '--permission-mode acceptEdits',
      auto: '--permission-mode auto',
      full: '--dangerously-skip-permissions'
    }
  },
  codex: {
    args: {
      ask: '--sandbox read-only --ask-for-approval on-request',
      edits: '--sandbox workspace-write --ask-for-approval on-request',
      auto: '--approve-for-me',
      full: '--dangerously-bypass-approvals-and-sandbox'
    },
    notes: {
      ask: 'Asks before it edits files or runs a command that changes anything',
      edits: 'Edits and runs commands inside the project without asking; asks to go further'
    }
  },
  gemini: { args: { ask: '--approval-mode default', edits: '--approval-mode auto_edit', full: '--approval-mode yolo' } },
  qwen: {
    args: { ask: '--approval-mode default', edits: '--approval-mode auto-edit', auto: '--approval-mode auto', full: '--approval-mode yolo' },
    // Qwen Code's own words for `auto`: it blocks a risky action rather than asking.
    notes: { auto: 'Its classifier approves safe actions and blocks risky ones' }
  },
  cursor: { args: { auto: '--auto-review', full: '--yolo' } },
  copilot: { args: { full: '--yolo' } },
  hermes: { args: { full: '--yolo' } },
  grok: { args: { full: '--permission-mode bypassPermissions' } },
  amp: { args: { full: '--dangerously-allow-all' } },
  crush: { args: { full: '--yolo' } },
  // Kimi CLI's `--yolo` approves everything; in Kimi Code, its successor (also
  // `kimi`), it still asks before risky actions, and the `--auto` that never
  // asks would stop Kimi CLI from starting.
  kimi: { args: { full: '--yolo' }, notes: { full: 'Runs edits and commands without asking (Kimi Code still asks before risky ones)' } },
  aider: { args: { full: '--yes-always' } },
  goose: { env: { ask: { GOOSE_MODE: 'approve' }, auto: { GOOSE_MODE: 'smart_approve' }, full: { GOOSE_MODE: 'auto' } } }
}

export const PERMISSION_TEXT: Record<AgentPermission, { title: string; description: string }> = {
  own: { title: 'Its own settings', description: 'Starts it as it is: it follows its own permission settings' },
  ask: { title: 'Ask for approval', description: 'Asks before edits and commands its settings don’t allow' },
  edits: { title: 'Accept edits', description: 'Makes file edits without asking; asks before the rest' },
  auto: { title: 'Approve for me', description: 'Its reviewer approves safe requests and asks about risky ones' },
  full: { title: 'Full access', description: 'Never asks before edits or commands' }
}

/** The settings this reads; Settings['agentProviders'] has them. */
export interface PermissionPrefs {
  permissions?: AgentPermission
  agentPermissions?: Record<string, AgentPermissionChoice>
}

/** The choices an agent can be started with, `own` first; just `own` for one with no switches. */
export function permissionsFor(agent: string): AgentPermission[] {
  const launch = PERMISSION_LAUNCH[agent as TerminalAgentId]
  return AGENT_PERMISSIONS.filter((p) => p === 'own' || Boolean(launch?.args?.[p] ?? launch?.env?.[p]))
}

const isPermission = (value: unknown): value is AgentPermission => (AGENT_PERMISSIONS as readonly unknown[]).includes(value)

/** What a row is set to: its own choice, else "Same as all agents". */
export function permissionChoice(agent: string, prefs: PermissionPrefs | undefined): AgentPermissionChoice {
  const choice = prefs?.agentPermissions?.[agent]
  return isPermission(choice) ? choice : 'all'
}

/**
 * What an agent is started with: its row's choice, or the one for all
 * agents. One its CLI has no switch for (all agents on "Approve for me", and
 * Copilot has none) starts it on its own settings.
 */
export function effectivePermission(agent: string, prefs: PermissionPrefs | undefined): AgentPermission {
  const choice = permissionChoice(agent, prefs)
  const wanted = choice === 'all' ? (isPermission(prefs?.permissions) ? prefs.permissions : 'own') : choice
  return permissionsFor(agent).includes(wanted) ? wanted : 'own'
}

/** The flags the agent's command takes for it, or null for none. */
export function permissionArgs(agent: string, permission: AgentPermission): string | null {
  return permission === 'own' ? null : (PERMISSION_LAUNCH[agent as TerminalAgentId]?.args?.[permission] ?? null)
}

/** The environment its terminal gets for it (Goose reads its mode from GOOSE_MODE). */
export function permissionEnv(agent: string, permission: AgentPermission): Record<string, string> {
  return permission === 'own' ? {} : { ...PERMISSION_LAUNCH[agent as TerminalAgentId]?.env?.[permission] }
}

/** How a choice is described for one agent: its own note where the general words would be wrong. */
export function permissionDescription(agent: string, permission: AgentPermission): string {
  if (permission === 'own') return PERMISSION_TEXT.own.description
  return PERMISSION_LAUNCH[agent as TerminalAgentId]?.notes?.[permission] ?? PERMISSION_TEXT[permission].description
}
