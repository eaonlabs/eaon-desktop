import { useEffect, useRef, useState, type JSX } from 'react'
import { ChevronRight, Gauge, Plus, RefreshCw } from 'lucide-react'
import {
  CLI_TOOLS,
  CLI_TOOL_NAME,
  CLI_TOOL_SOURCE,
  accountName,
  liveWindows,
  usageKey,
  type AccountUsage,
  type CliAccount,
  type CliAccountsState,
  type CliTool,
  type LiveWindow,
  type UsageWindow
} from '@shared/cliAccounts'
import { useApp } from '../../state/store'
import { agoText, resetClock, untilText, useCliAccounts } from '../../state/cliAccounts'
import { Popover, useDisclosure } from '../ui'
import { MoveCodexPanes } from './MoveCodexPanes'
import { useTerminals } from './terminal/terminalStore'
import { useCode } from './codeStore'

/**
 * The ADE header's usage meter: how much of the Claude Code (or Codex) plan
 * is used, as the CLI itself reports it. The pill shows the session and the
 * week; its panel has every limit, when each resets, the CLI's other
 * accounts (one click to switch to one), and the other CLI.
 */

const TOOL_KEY = 'eaon.usageMeter.tool'

function savedTool(): CliTool | null {
  try {
    const value = localStorage.getItem(TOOL_KEY)
    return value === 'claude' || value === 'codex' ? value : null
  } catch {
    return null
  }
}

/** The CLI the meter is about: the one picked in its panel, else the one the open folder's panes run. */
function useMeterTool(state: CliAccountsState | null): [CliTool, (tool: CliTool) => void] {
  const [picked, setPicked] = useState<CliTool | null>(savedTool)
  const cwd = useCode((s) => s.cwd)
  // The panes themselves (a stable reference); a mapped list made in the selector would be new every render.
  const panes = useTerminals((s) => (cwd ? s.layout[cwd] : undefined))
  const agents = (panes ?? []).map((p) => p.agent)
  const pick = (tool: CliTool): void => {
    setPicked(tool)
    try {
      localStorage.setItem(TOOL_KEY, tool)
    } catch {
      /* remembered for this session only */
    }
  }
  const installed = CLI_TOOLS.filter((t) => state?.tools[t].installed)
  if (picked && installed.includes(picked)) return [picked, pick]
  if (agents.includes('codex') && !agents.includes('claude') && installed.includes('codex')) return ['codex', pick]
  return [installed.includes('claude') ? 'claude' : (installed[0] ?? 'claude'), pick]
}

const usageOf = (state: CliAccountsState | null, tool: CliTool): AccountUsage | undefined =>
  state ? state.usage[usageKey(tool, state.tools[tool].active)] : undefined

const shortLabel = (w: UsageWindow): string => (w.id === 'session' ? '' : w.id === 'week' ? ' wk' : w.id === 'month' ? ' mo' : '')

export function UsageMeter({ where = 'header' }: { where?: 'sidebar' | 'header' }): JSX.Element | null {
  const { state, ensure, refresh } = useCliAccounts()
  const settings = useApp((s) => s.settings)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useDisclosure()
  const [tool, setTool] = useMeterTool(state)

  useEffect(() => {
    ensure()
    void refresh()
  }, [ensure, refresh])

  // Whether it shows at all is UsagePlacement's call (Settings → Accounts).
  if (!state || !settings) return null
  if (!CLI_TOOLS.some((t) => state.tools[t].installed)) return null

  const usage = usageOf(state, tool)
  const windows = liveWindows(usage, Date.now())
  const first = windows[0]
  const pill = windows.length > 0 ? windows.slice(0, 2).map((w) => `${w.percent}%${shortLabel(w)}`).join(' · ') : 'Usage'

  return (
    <>
      <button
        ref={anchor}
        className="header-btn usage-pill"
        data-where={where}
        data-active={panel.open || undefined}
        data-severity={first?.severity}
        title={`${CLI_TOOL_NAME[tool]} plan usage`}
        onClick={() => {
          panel.toggle()
          // Opening it reads every account, so the switcher's figures are current too.
          if (!panel.open) void refresh({ all: true })
        }}
      >
        {first ? (
          <span className="usage-pill__bar" aria-hidden="true">
            <span style={{ width: `${first.percent}%` }} data-severity={first.severity} />
          </span>
        ) : (
          // No limits read yet: an empty bar looked like a broken meter.
          <Gauge size={13} strokeWidth={2} aria-hidden="true" />
        )}
        <span className="usage-pill__text">{pill}</span>
      </button>
      <Popover anchor={anchor} open={panel.open} onClose={panel.close} placement={where === 'sidebar' ? 'top-start' : 'bottom-end'} width={320} className="usage-panel">
        <UsagePanel state={state} tool={tool} setTool={setTool} close={panel.close} />
      </Popover>
    </>
  )
}

function UsagePanel({ state, tool, setTool, close }: { state: CliAccountsState; tool: CliTool; setTool: (tool: CliTool) => void; close: () => void }): JSX.Element {
  const view = useApp((s) => s.settings?.cliUsage.view ?? 'detailed')
  const patchSettings = useApp((s) => s.patchSettings)
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  const refresh = useCliAccounts((s) => s.refresh)
  const now = useNow()
  const loading = state.tools[tool].accounts.some((a) => state.loading.includes(usageKey(tool, a.id)))
  const others = CLI_TOOLS.filter((t) => t !== tool && state.tools[t].installed)
  const [error, setError] = useState<string | null>(null)

  const manage = (): void => {
    close()
    setSettingsPage('accounts')
  }
  /** The CLI's own sign-in runs in Settings → Accounts, where it can show its page and take a code. */
  const add = (): void => {
    setError(null)
    window.api.cliAccounts.add(tool).then(manage, (e: unknown) => setError(errorText(e)))
  }
  const use = (t: CliTool, id: string): void => {
    setError(null)
    window.api.cliAccounts.use(t, id).catch((e: unknown) => setError(errorText(e)))
  }

  return (
    <div className="usage-panel__inner">
      <header className="usage-panel__head">
        <span className="usage-panel__title">Usage</span>
        <span className="usage-panel__source">from {CLI_TOOL_SOURCE[tool]}</span>
        <button
          className="usage-panel__refresh"
          aria-label="Read usage again"
          title="Read usage again"
          data-spinning={loading || undefined}
          onClick={() => void refresh({ force: true, all: true, ...(view === 'compact' ? {} : { tool }) })}
        >
          <RefreshCw size={13} strokeWidth={2} />
        </button>
      </header>

      <div className="usage-panel__views" role="tablist">
        {(['detailed', 'compact'] as const).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} data-active={view === v || undefined} onClick={() => void patchSettings({ cliUsage: { ...useApp.getState().settings!.cliUsage, view: v } })}>
            {v === 'detailed' ? 'Detailed' : 'Compact'}
          </button>
        ))}
      </div>

      {view === 'detailed' ? (
        <>
          <ToolDetail state={state} tool={tool} now={now} />
          <OtherAccounts state={state} tool={tool} now={now} use={use} />
          {tool === 'codex' && <MoveCodexPanes state={state} />}
          {others.map((other) => (
            <button key={other} className="usage-panel__other" onClick={() => setTool(other)}>
              <span>{CLI_TOOL_NAME[other]}</span>
              <span className="usage-panel__other-figure">{summary(usageOf(state, other), now)}</span>
              <ChevronRight size={13} strokeWidth={2} />
            </button>
          ))}
        </>
      ) : (
        CLI_TOOLS.filter((t) => state.tools[t].installed).map((t) => <ToolCompact key={t} state={state} tool={t} now={now} picked={t === tool} onPick={() => setTool(t)} use={use} />)
      )}

      {error && <p className="usage-status" data-error>{error}</p>}
      <div className="usage-panel__links">
        <button className="usage-panel__settings" disabled={state.login.state === 'running'} onClick={add}>
          <Plus size={13} strokeWidth={2} /> Add account
        </button>
        <button className="usage-panel__settings" onClick={manage}>
          Manage accounts <ChevronRight size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

/** "6% · 78% wk", or why there is nothing to show. */
function summary(usage: AccountUsage | undefined, now: number): string {
  if (!usage) return '…'
  if (!usage.ok) return usage.reason === 'signed-out' ? 'signed out' : usage.reason === 'no-limits' ? 'no plan limits' : 'unavailable'
  return liveWindows(usage, now).slice(0, 2).map((w) => `${w.percent}%${shortLabel(w)}`).join(' · ') || 'no limits reported'
}

function ToolDetail({ state, tool, now }: { state: CliAccountsState; tool: CliTool; now: number }): JSX.Element {
  const usage = usageOf(state, tool)
  const account = state.tools[tool].accounts.find((a) => a.id === state.tools[tool].active)
  const loading = state.loading.includes(usageKey(tool, state.tools[tool].active))
  const several = state.tools[tool].accounts.length > 1
  return (
    <div className="usage-tool">
      {account && (several || account.email || account.plan) && (
        <div className="usage-tool__active">
          <span className="usage-account__dot" data-active aria-hidden="true" />
          <span className="usage-account__name">{accountName(account)}</span>
          {account.plan && <span className="usage-account__plan">{planLabel(account.plan)}</span>}
          {several && <span className="usage-account__state">In use</span>}
        </div>
      )}
      <Status usage={usage} tool={tool} loading={loading} />
      {liveWindows(usage, now).map((w) => (
        <div key={w.id} className="usage-window" data-severity={w.severity}>
          <div className="usage-window__head">
            <span className="usage-window__label">{w.label}</span>
            <span className="usage-window__when" title={w.resetsAt ? `Resets ${resetClock(w.resetsAt, now)}` : undefined}>
              {resetText(w, now)}
            </span>
            <span className="usage-window__percent">{w.hasReset ? '—' : `${w.percent}%`}</span>
          </div>
          <div className="usage-window__bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.percent} aria-label={`${w.label} used`}>
            <span style={{ width: `${Math.max(w.percent, 1.5)}%` }} />
          </div>
          <div className="usage-window__note">
            {w.hasReset
              ? `Your ${w.label.toLowerCase()} limit has reset since this was read`
              : w.detail
                ? `${w.detail} used${w.resetsAt ? ` · resets ${resetClock(w.resetsAt, now)}` : ` ${w.span}`}`
                : `${w.percent}% used${w.resetsAt ? ` · resets ${resetClock(w.resetsAt, now)}` : ` of your ${w.label.toLowerCase()} limit`}`}
          </div>
        </div>
      ))}
      <div className="usage-tool__foot">
        {CLI_TOOL_SOURCE[tool]}’s own figures{usage ? ` · ${agoText(usage.at, now)}` : ''}
      </div>
    </div>
  )
}

/**
 * The CLI's other accounts, each a line per limit, and one click to use it.
 * Nothing at all for someone with one account.
 */
function OtherAccounts({ state, tool, now, use }: { state: CliAccountsState; tool: CliTool; now: number; use: (tool: CliTool, id: string) => void }): JSX.Element | null {
  const entry = state.tools[tool]
  const others = entry.accounts.filter((a) => a.id !== entry.active)
  if (others.length === 0) return null
  return (
    <div className="usage-accounts">
      <div className="usage-accounts__head">Other accounts</div>
      {others.map((account) => (
        <AccountCard key={account.id} state={state} tool={tool} account={account} now={now} onUse={() => use(tool, account.id)} />
      ))}
      {tool === 'codex' && <p className="usage-accounts__fine">New panes, chats and workers use the account in use; a Codex turn already running finishes first.</p>}
    </div>
  )
}

/** One account in the switcher: who, how much is used, and the button that makes it the one in use. */
function AccountCard({ state, tool, account, now, onUse }: { state: CliAccountsState; tool: CliTool; account: CliAccount; now: number; onUse: () => void }): JSX.Element {
  const usage = state.usage[usageKey(tool, account.id)]
  const loading = state.loading.includes(usageKey(tool, account.id))
  const signedOut = usage && !usage.ok && usage.reason === 'signed-out'
  return (
    <button className="usage-account" onClick={onUse} disabled={signedOut || undefined} title={signedOut ? 'Sign this account in from Manage accounts first' : `Use ${accountName(account)} for ${CLI_TOOL_NAME[tool]}`}>
      <span className="usage-account__line">
        <span className="usage-account__dot" aria-hidden="true" />
        <span className="usage-account__name">{accountName(account)}</span>
        {account.plan && <span className="usage-account__plan">{planLabel(account.plan)}</span>}
        <span className="usage-account__state">{signedOut ? 'Signed out' : 'Use'}</span>
      </span>
      {usage?.ok ? (
        <WindowRows usage={usage} now={now} />
      ) : (
        <span className="usage-account__note">{loading && !usage ? 'Reading…' : summary(usage, now)}</span>
      )}
    </button>
  )
}

/** A line per limit: its name, a bar, the figure and when it resets. */
function WindowRows({ usage, now }: { usage: AccountUsage; now: number }): JSX.Element {
  const windows = liveWindows(usage, now)
  if (windows.length === 0) return <span className="usage-account__note">No limits reported</span>
  return (
    <>
      {windows.map((w) => (
        <span
          key={w.id}
          className="usage-compact__row"
          data-severity={w.severity}
          title={[w.detail, w.resetsAt ? `Resets ${resetClock(w.resetsAt, now)}` : null].filter(Boolean).join(' · ') || undefined}
        >
          <span className="usage-compact__label">{w.label}</span>
          <span className="usage-compact__bar">
            <span style={{ width: `${Math.max(w.percent, 2)}%` }} />
          </span>
          <span className="usage-compact__percent">{w.hasReset ? '—' : `${w.percent}%`}</span>
          <span className="usage-compact__when">{w.hasReset ? 'reset' : (untilText(w.resetsAt, now) ?? '')}</span>
        </span>
      ))}
    </>
  )
}

function ToolCompact({
  state,
  tool,
  now,
  picked,
  onPick,
  use
}: {
  state: CliAccountsState
  tool: CliTool
  now: number
  picked: boolean
  onPick: () => void
  use: (tool: CliTool, id: string) => void
}): JSX.Element {
  const entry = state.tools[tool]
  const usage = usageOf(state, tool)
  const loading = state.loading.includes(usageKey(tool, entry.active))
  const active = entry.accounts.find((a) => a.id === entry.active)
  const others = entry.accounts.filter((a) => a.id !== entry.active)
  return (
    <div className="usage-compact" data-picked={picked || undefined}>
      <button className="usage-compact__tool" onClick={onPick} title="Show this one in the header">
        {CLI_TOOL_NAME[tool]}
        <span>{CLI_TOOL_SOURCE[tool]}</span>
      </button>
      {others.length > 0 && active && (
        <div className="usage-tool__active usage-tool__active--compact">
          <span className="usage-account__dot" data-active aria-hidden="true" />
          <span className="usage-account__name">{accountName(active)}</span>
          <span className="usage-account__state">In use</span>
        </div>
      )}
      {usage?.ok ? <WindowRows usage={usage} now={now} /> : <Status usage={usage} tool={tool} loading={loading} />}
      {others.map((account) => (
        <AccountCard key={account.id} state={state} tool={tool} account={account} now={now} onUse={() => use(tool, account.id)} />
      ))}
      {tool === 'codex' && <MoveCodexPanes state={state} compact />}
    </div>
  )
}

function Status({ usage, tool, loading }: { usage: AccountUsage | undefined; tool: CliTool; loading: boolean }): JSX.Element | null {
  if (!usage) return <p className="usage-status">{loading ? `Asking ${CLI_TOOL_NAME[tool]}…` : 'Not read yet'}</p>
  if (usage.ok) {
    return usage.windows.length === 0 ? (
      <p className="usage-status">{CLI_TOOL_NAME[tool]} reports no usage limits for {usage.plan ? `this ${planLabel(usage.plan)} plan` : 'this plan'}.</p>
    ) : null
  }
  if (usage.reason === 'signed-out') {
    return (
      <p className="usage-status">
        Not signed in to {CLI_TOOL_NAME[tool]}. Run <code>{tool === 'claude' ? 'claude' : 'codex login'}</code> in a pane, or add an account.
      </p>
    )
  }
  return <p className="usage-status" data-error={usage.reason === 'failed' || undefined}>{usage.message}</p>
}

function resetText(w: LiveWindow, now: number): string {
  if (w.hasReset) return 'reset since last read'
  const until = untilText(w.resetsAt, now)
  return until ? `resets in ${until}` : w.span
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const planLabel = (plan: string): string => plan.charAt(0).toUpperCase() + plan.slice(1)

/** The time, ticking every half minute while the panel is open. */
function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}
