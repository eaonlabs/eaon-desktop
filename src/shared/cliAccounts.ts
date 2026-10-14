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
  /** The CLI says this limit has been hit (Codex's `rateLimitReachedType`). */
  reached?: boolean
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

/* ------------------------------------------------------------ as of now */

/** A window as it stands at `now`, not as it was read. */
export interface LiveWindow extends UsageWindow {
  /** Its reset time has passed since it was read: it starts again from nothing. */
  hasReset: boolean
}

/**
 * The figures were read at some point; a window whose reset time has gone by
 * since is empty again, whatever it said then. Never a stale 100%.
 */
export function liveWindow(w: UsageWindow, now: number): LiveWindow {
  if (w.resetsAt === null || w.resetsAt > now) return { ...w, hasReset: false }
  return { ...w, percent: 0, severity: 'normal', reached: false, resetsAt: null, hasReset: true }
}

export function liveWindows(usage: AccountUsage | undefined, now: number): LiveWindow[] {
  return usage?.ok ? usage.windows.map((w) => liveWindow(w, now)) : []
}

/** At or past this, an account is close to its limit. */
export const NEAR_LIMIT = 90

export type LimitLevel = 'near' | 'reached'
const LEVEL_RANK: Record<LimitLevel, number> = { near: 1, reached: 2 }

/** How close a window is to its limit, if close at all. */
export function limitLevel(w: UsageWindow): LimitLevel | null {
  if (w.reached || w.percent >= 100) return 'reached'
  return w.percent >= NEAR_LIMIT ? 'near' : null
}

/** Whether an account can take more work now: signed in to a plan, every window under 90%. */
export function hasRoom(usage: AccountUsage | undefined, now: number): boolean {
  return Boolean(usage?.ok) && liveWindows(usage, now).every((w) => limitLevel(w) === null)
}

/** The fullest window, for ranking accounts against each other. */
const fullest = (usage: AccountUsage | undefined, now: number): number => Math.max(0, ...liveWindows(usage, now).map((w) => w.percent))

/**
 * Another account of the same CLI to move to: signed in, with room, the
 * emptiest first. Null when none has room.
 */
export function switchTarget(
  tool: CliTool,
  state: { tools: Record<CliTool, { active: string; accounts: CliAccount[] }>; usage: Record<string, AccountUsage> },
  now: number,
  from: string = state.tools[tool].active
): CliAccount | null {
  const candidates = state.tools[tool].accounts.filter((a) => a.id !== from && hasRoom(state.usage[usageKey(tool, a.id)], now))
  candidates.sort((a, b) => fullest(state.usage[usageKey(tool, a.id)], now) - fullest(state.usage[usageKey(tool, b.id)], now))
  return candidates[0] ?? null
}

/** A limit worth telling the user about. */
export interface LimitAlert {
  tool: CliTool
  accountId: string
  windowId: string
  label: string
  level: LimitLevel
  percent: number
  resetsAt: number | null
}

/**
 * What has been said about each window, keyed `${tool}:${accountId}:${windowId}`:
 * how far it had got, and the reset that was about.
 */
export type AlertMemory = Record<string, { level: LimitLevel; resetsAt: number | null }>

/**
 * The alerts a fresh reading calls for: a window reaching 90%, or its limit,
 * said once per window — again only after it resets (its reset time passes,
 * or it reads under 90% again) or when it goes from near to reached.
 * Returns the memory to keep for next time.
 */
export function limitAlerts(
  tool: CliTool,
  accountId: string,
  usage: AccountUsage | undefined,
  memory: AlertMemory,
  now: number
): { alerts: LimitAlert[]; memory: AlertMemory } {
  if (!usage?.ok) return { alerts: [], memory }
  const next: AlertMemory = { ...memory }
  const alerts: LimitAlert[] = []
  const prefix = `${tool}:${accountId}:`
  const seen = new Set<string>()
  for (const w of liveWindows(usage, now)) {
    const key = prefix + w.id
    seen.add(key)
    let prev: AlertMemory[string] | undefined = next[key]
    if (prev && prev.resetsAt !== null && prev.resetsAt <= now) prev = undefined
    const level = limitLevel(w)
    if (!level) {
      delete next[key]
      continue
    }
    if (prev && LEVEL_RANK[prev.level] >= LEVEL_RANK[level]) continue
    next[key] = { level, resetsAt: w.resetsAt }
    alerts.push({ tool, accountId, windowId: w.id, label: w.label, level, percent: w.percent, resetsAt: w.resetsAt })
  }
  // A window the CLI no longer reports has nothing left to remember.
  for (const key of Object.keys(next)) if (key.startsWith(prefix) && !seen.has(key)) delete next[key]
  return { alerts, memory: next }
}

/** A limit alert, with what can be done about it. */
export interface LimitNotice extends LimitAlert {
  /** The account's name, as Eaon shows it. */
  name: string
  /** Another signed-in account of the same CLI with room, if there is one. */
  switchTo: { id: string; name: string } | null
  /** Eaon already moved to it (the automatic switch). */
  switched: boolean
}

/** What the system notification says. */
export function limitNoticeText(notice: LimitNotice, now: number): { title: string; body: string } {
  const tool = CLI_TOOL_NAME[notice.tool]
  const window = notice.label.toLowerCase()
  const title = notice.level === 'reached' ? `${tool}: ${notice.name} hit its ${window} limit` : `${tool}: ${notice.name} is at ${notice.percent}% of its ${window} limit`
  const parts: string[] = []
  const until = untilText(notice.resetsAt, now)
  if (notice.resetsAt !== null && until) parts.push(`Resets ${resetClock(notice.resetsAt, now)} (in ${until}).`)
  if (notice.switched && notice.switchTo) parts.push(`New ${tool} sessions now use ${notice.switchTo.name}.`)
  else if (notice.switchTo) parts.push(`${notice.switchTo.name} has room.`)
  return { title, body: parts.join(' ') }
}

/** "4h 23m", "2d 5h", "12m", "now". */
export function untilText(at: number | null, now: number): string | null {
  if (at === null) return null
  const ms = at - now
  if (ms <= 0) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** "at 4:30 PM", or "Tue at 4:30 PM" when it isn't today. In the computer's own clock. */
export function resetClock(at: number, now: number): string {
  const when = new Date(at)
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (when.toDateString() === new Date(now).toDateString()) return `at ${time}`
  const day = at - now < 6 * 86_400_000 ? when.toLocaleDateString([], { weekday: 'short' }) : when.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${day} at ${time}`
}

/** An ADE pane running Codex, and the account it started on — for moving it to another. */
export interface CodexPane {
  paneId: string
  /** The CODEX_HOME it started with; null for Codex's default folder. */
  dir: string | null
  /** The conversation it is in, once Eaon has seen it. */
  sessionId: string | null
  /** Codex is working in it right now. */
  busy: boolean
  /** The active account's Codex can resume that conversation. */
  resumable: boolean
}
