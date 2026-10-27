import { create } from 'zustand'
import { CLI_TOOL_NAME, accountName, liveWindow, usageKey, type CliAccountsState, type CliTool } from '@shared/cliAccounts'
import {
  USAGE_PROVIDERS,
  usageProvider,
  type BankedResets,
  type ProviderTokens,
  type ProviderUsageState,
  type ProviderWindow,
  type UsageLine,
  type UsageProviderId
} from '@shared/providerUsage'
import { agoText, useCliAccounts } from './cliAccounts'

/**
 * Every coding tool's limits as one shape, for Settings → Usage & limits and
 * the ADE header's rings: Claude Code's and Codex's from the CLI accounts
 * (cliAccounts), the rest from main's provider readers (providerUsage).
 */

interface ProviderUsageStore {
  state: ProviderUsageState | null
  ensure: () => void
  refresh: () => Promise<void>
}

let listening = false

export const useProviderUsage = create<ProviderUsageStore>((set) => ({
  state: null,
  ensure: () => {
    if (listening) return
    listening = true
    window.api.providerUsage.onChanged((state) => set({ state }))
    void window.api.providerUsage.state().then((state) => set({ state }))
  },
  refresh: async () => {
    try {
      set({ state: await window.api.providerUsage.refresh() })
    } catch {
      /* The figures stay as they were. */
    }
  }
}))

export interface LimitsView {
  id: UsageProviderId
  name: string
  mark: string
  account: string | null
  plan: string | null
  status: 'ok' | 'signed-out' | 'unsupported' | 'error' | 'loading'
  windows: ProviderWindow[]
  lines: UsageLine[]
  note: string | null
  banked: BankedResets | null
  tokens: ProviderTokens | null
}

const CLI: Partial<Record<UsageProviderId, CliTool>> = { claude: 'claude', codex: 'codex' }

/** One provider as the page and the rings show it, or null when it isn't signed in on this computer. */
export function limitsView(id: UsageProviderId, cli: CliAccountsState | null, provider: ProviderUsageState | null, now: number): LimitsView | null {
  const info = usageProvider(id)
  if (!info) return null
  const tokens = provider?.tokens[id] ?? null
  const tool = CLI[id]
  if (tool) {
    if (!cli || !cli.tools[tool].installed) return null
    const active = cli.tools[tool].active
    const account = cli.tools[tool].accounts.find((a) => a.id === active)
    const usage = cli.usage[usageKey(tool, active)]
    const loading = cli.loading.includes(usageKey(tool, active))
    if (usage && !usage.ok && usage.reason === 'signed-out') return null
    return {
      id,
      name: info.name,
      mark: info.mark,
      account: account ? accountName(account) : null,
      plan: usage?.ok ? usage.plan : (account?.plan ?? null),
      status: usage?.ok ? 'ok' : !usage ? 'loading' : usage.reason === 'no-limits' || usage.reason === 'in-cli' ? 'unsupported' : loading ? 'loading' : 'error',
      windows: usage?.ok ? usage.windows.map((w) => liveWindow(w, now)) : [],
      lines: [],
      // Claude Code's own copy of its limits can be hours old: say when it last looked.
      note: usage && !usage.ok ? usage.message : usage?.ok && usage.asOf ? `As ${CLI_TOOL_NAME[tool]} last saw them, ${agoText(usage.asOf, now)}.` : null,
      banked: usage?.ok ? (usage.banked ?? null) : null,
      tokens
    }
  }
  const read = provider?.providers.find((p) => p.id === id)
  if (!read) return null
  return {
    id,
    name: info.name,
    mark: info.mark,
    account: read.account,
    plan: read.plan,
    status: read.status,
    windows: read.windows.map((w) => ({ ...w, ...liveWindow(w, now) })),
    lines: read.lines,
    note: read.note ?? null,
    banked: read.banked ?? null,
    tokens
  }
}

/** Every provider signed in on this computer, in Settings' order. */
export function signedIn(cli: CliAccountsState | null, provider: ProviderUsageState | null, now: number): LimitsView[] {
  return USAGE_PROVIDERS.map((p) => limitsView(p.id, cli, provider, now)).filter((v): v is LimitsView => v !== null)
}

/** Keeps both sources loaded and fresh while something on screen shows them. */
export function useLimitsSources(): { cli: CliAccountsState | null; provider: ProviderUsageState | null } {
  const cli = useCliAccounts((s) => s.state)
  const provider = useProviderUsage((s) => s.state)
  return { cli, provider }
}

export function ensureLimits(): void {
  useCliAccounts.getState().ensure()
  useProviderUsage.getState().ensure()
}

export async function refreshLimits(): Promise<void> {
  await Promise.all([useCliAccounts.getState().refresh({ all: true, force: true }), useProviderUsage.getState().refresh()])
}

/** "74M", "2B", "10.5M", "980K", "12". */
export function compactTokens(n: number): string {
  if (n >= 1e9) return `${trim(n / 1e9)}B`
  if (n >= 1e6) return `${trim(n / 1e6)}M`
  if (n >= 1e3) return `${trim(n / 1e3)}K`
  return String(Math.round(n))
}
const trim = (v: number): string => (v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(1).replace(/\.0$/, ''))
