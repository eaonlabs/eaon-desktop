/**
 * Claude Code and Codex accounts, and how much of each plan's limits is used.
 *
 * Eaon never handles either CLI's sign-in itself. Each account is a folder
 * the CLI keeps its own login in — the default one (~/.claude, ~/.codex), or
 * one Eaon made, passed to the CLI the way it documents (CLAUDE_CONFIG_DIR,
 * CODEX_HOME). Signing in runs the CLI's own login, and the figures come from
 * the CLI's own usage requests (Claude Code's `get_usage`, Codex's
 * `account/rateLimits/read`): what `/usage` shows, read the way it reads it.
 */

export type CliTool = 'claude' | 'codex'
export const CLI_TOOLS: CliTool[] = ['claude', 'codex']

export const CLI_TOOL_NAME: Record<CliTool, string> = { claude: 'Claude Code', codex: 'Codex' }
/** Who the figures come from. */
export const CLI_TOOL_SOURCE: Record<CliTool, string> = { claude: 'Anthropic', codex: 'OpenAI' }

/** The account in the CLI's own default folder. */
export const DEFAULT_ACCOUNT_ID = 'default'

export interface CliAccount {
  id: string
  /** The folder the CLI keeps this account in; null for its default (~/.claude, ~/.codex). */
  dir: string | null
  /** What the user called it, if anything; else it goes by its email. */
  label: string
  /** As the CLI last reported them. */
  email: string | null
  plan: string | null
  addedAt: number
}

export interface CliToolAccounts {
  /** The CLI was found on this computer. */
  installed: boolean
  active: string
  accounts: CliAccount[]
}

export type UsageSeverity = 'normal' | 'warning' | 'critical'

/** One limit: the 5-hour session, the week, a model's own week, Codex's month. */
export interface UsageWindow {
  id: string
  /** "Session", "Week", "Fable week". */
  label: string
  /** "rolling 7 days", "5 hours" — shown when there is no reset time. */
  span: string
  /** 0–100. */
  percent: number
  /** When it resets (ms), if known. */
  resetsAt: number | null
  severity: UsageSeverity
}

export type AccountUsage =
  | { ok: true; at: number; plan: string | null; windows: UsageWindow[] }
  | {
      ok: false
      at: number
      /** Not signed in, an API key (no plan limits), or the CLI failed. */
      reason: 'signed-out' | 'no-limits' | 'failed'
      message: string
    }

/** Signing in to a new account, run by the CLI's own login. */
export type CliLogin =
  | { state: 'idle' }
  | {
      state: 'running' | 'done' | 'failed'
      tool: CliTool
      accountId: string
      /** The sign-in page the CLI opened (also opened in the browser for them). */
      url: string | null
      /** The last lines the CLI printed, for anything it asks. */
      output: string
      message?: string
    }

export interface CliAccountsState {
  tools: Record<CliTool, CliToolAccounts>
  /** Keyed `${tool}:${accountId}`. */
  usage: Record<string, AccountUsage>
  /** Which accounts are being read right now, same keys. */
  loading: string[]
  login: CliLogin
}

export const usageKey = (tool: CliTool, accountId: string): string => `${tool}:${accountId}`

/** What an account is called: its own name, else its email, else which one it is. */
export function accountName(account: CliAccount): string {
  return account.label || account.email || (account.id === DEFAULT_ACCOUNT_ID ? 'Default account' : 'New account')
}

/** The severity Eaon shows when the CLI doesn't say: amber from 75%, red from 90%. */
export function severityOf(percent: number): UsageSeverity {
  return percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal'
}
