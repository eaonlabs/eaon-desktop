import type { UsageWindow } from './cliAccounts'

/**
 * Settings → Usage & limits: how much of each coding plan is left, across
 * every tool signed in on this computer, not only Claude Code and Codex.
 *
 * Claude Code and Codex come from the CLI accounts feature (cliAccounts),
 * which reads them through the CLIs themselves. The rest are read here from
 * what each tool keeps on this computer — its own sign-in, or an API key
 * saved in Eaon — and asked of the provider directly. Recent token totals
 * come from the CLI logs Settings → Usage already reads.
 */

export type UsageProviderId =
  | 'codex'
  | 'claude'
  | 'cursor'
  | 'copilot'
  | 'grok'
  | 'opencode'
  | 'droid'
  | 'devin'
  | 'antigravity'
  | 'gemini'
  | 'pi'
  | 'kimi'
  | 'glm'
  | 'minimax'
  | 'qwen'
  | 'mimo'
  | 'openrouter'
  | 'deepseek'

export interface UsageProviderInfo {
  id: UsageProviderId
  name: string
  /** The mark to show: a provider id ProviderMark knows, else a monogram. */
  mark: string
  /** What signing in takes, for a provider that isn't. */
  signIn: string
  /** Its CLI's token totals in Settings → Usage (`cli:<tool>`), if it keeps any. */
  logs?: string
  /** A plan with limits (rings in the ADE header), or only a balance. */
  kind: 'plan' | 'credits'
}

/** In the order Settings lists them. */
export const USAGE_PROVIDERS: UsageProviderInfo[] = [
  { id: 'codex', name: 'Codex', mark: 'codex', signIn: 'codex login', logs: 'codex', kind: 'plan' },
  { id: 'claude', name: 'Claude', mark: 'anthropic', signIn: 'claude /login', logs: 'claude-code', kind: 'plan' },
  { id: 'cursor', name: 'Cursor', mark: 'cli:cursor', signIn: 'Sign in to Cursor', logs: 'cursor', kind: 'plan' },
  { id: 'copilot', name: 'GitHub Copilot', mark: 'github-copilot', signIn: 'Sign in to GitHub Copilot in Settings → Model providers', logs: 'copilot-cli', kind: 'plan' },
  { id: 'antigravity', name: 'Antigravity', mark: 'antigravity', signIn: 'Sign in to Antigravity', kind: 'plan' },
  { id: 'gemini', name: 'Gemini CLI', mark: 'cli:gemini-cli', signIn: 'gemini', logs: 'gemini-cli', kind: 'plan' },
  { id: 'grok', name: 'Grok', mark: 'cli:grok', signIn: 'grok login', logs: 'grok', kind: 'plan' },
  { id: 'droid', name: 'Droid', mark: 'cli:droid', signIn: 'droid', logs: 'droid', kind: 'plan' },
  { id: 'opencode', name: 'OpenCode Go', mark: 'opencode', signIn: 'Add an OpenCode Go key in Settings → Model providers, or run `opencode auth login`', logs: 'opencode', kind: 'plan' },
  { id: 'pi', name: 'Pi', mark: 'pi', signIn: 'pi', kind: 'plan' },
  { id: 'devin', name: 'Devin', mark: 'devin', signIn: 'devin auth login', kind: 'plan' },
  { id: 'kimi', name: 'Kimi For Coding', mark: 'kimi-coding', signIn: 'Add a Kimi For Coding key in Settings → Model providers', kind: 'plan' },
  { id: 'glm', name: 'GLM Coding Plan', mark: 'zai-coding', signIn: 'Add a GLM Coding Plan key in Settings → Model providers', kind: 'plan' },
  { id: 'minimax', name: 'MiniMax Token Plan', mark: 'minimax', signIn: 'Add a MiniMax Token Plan key in Settings → Model providers', kind: 'plan' },
  { id: 'qwen', name: 'Qwen Token Plan', mark: 'qwen-token-plan', signIn: 'Add a Qwen Token Plan key in Settings → Model providers', kind: 'plan' },
  { id: 'mimo', name: 'MiMo Token Plan', mark: 'xiaomi-token-plan', signIn: 'Add a MiMo Token Plan key in Settings → Model providers', kind: 'plan' },
  { id: 'openrouter', name: 'OpenRouter', mark: 'openrouter', signIn: 'Add an OpenRouter key in Settings → Model providers', kind: 'credits' },
  { id: 'deepseek', name: 'DeepSeek', mark: 'deepseek', signIn: 'Add a DeepSeek key in Settings → Model providers', kind: 'credits' }
]

export const usageProvider = (id: string): UsageProviderInfo | undefined => USAGE_PROVIDERS.find((p) => p.id === id)

/** A limit, with how long its window runs when the provider says, for the pace. */
export interface ProviderWindow extends UsageWindow {
  durationMs?: number
}

/** A figure beside the limits: a credit balance, on-demand spend, a note. */
export interface UsageLine {
  label: string
  value: string
  sub?: string
}

/** Codex's banked resets: credits that clear the rate-limit windows. */
export interface BankedResets {
  available: number
  /** The soonest one to expire, if any do. */
  nextExpiry: number | null
}

export interface ProviderUsage {
  id: UsageProviderId
  /** The signed-in account, by email or name, when the tool says. */
  account: string | null
  plan: string | null
  status: 'ok' | 'signed-out' | 'unsupported' | 'error'
  windows: ProviderWindow[]
  lines: UsageLine[]
  /** Why there are no limits, or what went wrong, in a sentence. */
  note?: string
  banked?: BankedResets
  at: number
}

/** Tokens over a stretch of days, and how many sessions they came from, when the tool keeps sessions apart. */
export interface TokenSpan {
  tokens: number
  sessions: number | null
}

export interface ProviderTokens {
  day: TokenSpan
  week: TokenSpan
  month: TokenSpan
}

export interface ProviderUsageState {
  /** Every provider other than Claude Code and Codex that is signed in, or was looked for. */
  providers: ProviderUsage[]
  /** Token totals by provider id, for those whose CLI keeps counts. */
  tokens: Partial<Record<UsageProviderId, ProviderTokens>>
  loading: boolean
  at: number
}

/**
 * Whether the pace so far lasts the window: how far ahead of an even spend
 * (`reserve`, in points; negative is a deficit), and when it runs out at this
 * rate if it won't last. Null when the window's length or reset isn't known,
 * or it has barely begun.
 */
export function usagePace(w: ProviderWindow, now: number): { reserve: number; runsOutAt: number | null } | null {
  const duration = w.durationMs ?? spanMs(w)
  if (!duration || w.resetsAt === null || w.resetsAt <= now) return null
  const start = w.resetsAt - duration
  if (now < start) return null
  const elapsed = Math.max(0.05, (now - start) / duration)
  const expected = elapsed * 100
  const reserve = Math.round(expected - w.percent)
  if (w.percent <= 0 || reserve >= 0) return { reserve, runsOutAt: null }
  const rate = w.percent / (elapsed * duration)
  const runsOutAt = now + (100 - w.percent) / rate
  return { reserve, runsOutAt: runsOutAt < w.resetsAt ? runsOutAt : null }
}

/** How long a window runs, from its id or name when the provider didn't say. */
export function spanMs(w: UsageWindow): number | null {
  const text = `${w.id} ${w.label} ${w.span}`.toLowerCase()
  if (w.id === 'session' || /\b5\s*h|five.?hour|5-hour/.test(text)) return 5 * 3_600_000
  if (/daily|\bday\b|24\s*h/.test(text)) return 24 * 3_600_000
  if (/week|7\s*d/.test(text)) return 7 * 24 * 3_600_000
  if (/month|30\s*d/.test(text)) return 30 * 24 * 3_600_000
  return null
}
