import { useEffect, useRef, useState, type JSX } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import {
  CLI_TOOLS,
  CLI_TOOL_NAME,
  CLI_TOOL_SOURCE,
  accountName,
  usageKey,
  type AccountUsage,
  type CliAccountsState,
  type CliTool,
  type UsageWindow
} from '@shared/cliAccounts'
import { useApp } from '../../state/store'
import { agoText, untilText, useCliAccounts } from '../../state/cliAccounts'
import { Popover, useDisclosure } from '../ui'
import { useTerminals } from './terminal/terminalStore'
import { useCode } from './codeStore'

/**
 * The ADE header's usage meter: how much of the Claude Code (or Codex) plan
 * is used, as the CLI itself reports it. The pill shows the session and the
 * week; its panel has every limit, when each resets, and the other CLI.
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

export function UsageMeter(): JSX.Element | null {
  const { state, ensure, refresh } = useCliAccounts()
  const settings = useApp((s) => s.settings)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useDisclosure()
  const [tool, setTool] = useMeterTool(state)

  useEffect(() => {
    ensure()
    void refresh()
  }, [ensure, refresh])

  if (!state || !settings?.cliUsage.meter) return null
  if (!CLI_TOOLS.some((t) => state.tools[t].installed)) return null

  const usage = usageOf(state, tool)
  const windows = usage?.ok ? usage.windows : []
  const first = windows[0]
  const pill = usage?.ok && windows.length > 0 ? windows.slice(0, 2).map((w) => `${w.percent}%${shortLabel(w)}`).join(' · ') : 'Usage'

  return (
    <>
      <button
        ref={anchor}
        className="header-btn usage-pill"
        data-active={panel.open || undefined}
        data-severity={first?.severity}
        title={`${CLI_TOOL_NAME[tool]} plan usage`}
        onClick={() => {
          panel.toggle()
          if (!panel.open) void refresh()
        }}
      >
        <span className="usage-pill__bar" aria-hidden="true">
          <span style={{ width: `${first?.percent ?? 0}%` }} data-severity={first?.severity} />
        </span>
        <span className="usage-pill__text">{pill}</span>
      </button>
      <Popover anchor={anchor} open={panel.open} onClose={panel.close} placement="bottom-end" width={320} className="usage-panel">
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
  const loading = state.loading.includes(usageKey(tool, state.tools[tool].active))
  const others = CLI_TOOLS.filter((t) => t !== tool && state.tools[t].installed)

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
          onClick={() => void refresh({ force: true, ...(view === 'compact' ? {} : { tool }) })}
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
          {others.map((other) => (
            <button key={other} className="usage-panel__other" onClick={() => setTool(other)}>
              <span>{CLI_TOOL_NAME[other]}</span>
              <span className="usage-panel__other-figure">{summary(usageOf(state, other))}</span>
              <ChevronRight size={13} strokeWidth={2} />
            </button>
          ))}
        </>
      ) : (
        CLI_TOOLS.filter((t) => state.tools[t].installed).map((t) => <ToolCompact key={t} state={state} tool={t} now={now} picked={t === tool} onPick={() => setTool(t)} />)
      )}

      <button
        className="usage-panel__settings"
        onClick={() => {
          close()
          setSettingsPage('accounts')
        }}
      >
        Usage settings <ChevronRight size={13} strokeWidth={2} />
      </button>
    </div>
  )
}

/** "6% · 78% wk", or why there is nothing to show. */
function summary(usage: AccountUsage | undefined): string {
  if (!usage) return '…'
  if (!usage.ok) return usage.reason === 'signed-out' ? 'signed out' : usage.reason === 'no-limits' ? 'no plan limits' : 'unavailable'
  return usage.windows.slice(0, 2).map((w) => `${w.percent}%${shortLabel(w)}`).join(' · ') || 'no limits reported'
}

function ToolDetail({ state, tool, now }: { state: CliAccountsState; tool: CliTool; now: number }): JSX.Element {
  const usage = usageOf(state, tool)
  const account = state.tools[tool].accounts.find((a) => a.id === state.tools[tool].active)
  const loading = state.loading.includes(usageKey(tool, state.tools[tool].active))
  return (
    <div className="usage-tool">
      <Status usage={usage} tool={tool} loading={loading} />
      {usage?.ok &&
        usage.windows.map((w) => (
          <div key={w.id} className="usage-window" data-severity={w.severity}>
            <div className="usage-window__head">
              <span className="usage-window__label">{w.label}</span>
              <span className="usage-window__when">{resetText(w, now)}</span>
              <span className="usage-window__percent">{w.percent}%</span>
            </div>
            <div className="usage-window__bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.percent} aria-label={`${w.label} used`}>
              <span style={{ width: `${Math.max(w.percent, 1.5)}%` }} />
            </div>
            <div className="usage-window__note">
              {w.percent}% of your {w.label.toLowerCase()} limit
            </div>
          </div>
        ))}
      <div className="usage-tool__foot">
        {CLI_TOOL_SOURCE[tool]}’s own figures{usage ? ` · ${agoText(usage.at, now)}` : ''}
        {account && (account.email || account.plan) && (
          <div className="usage-tool__account">
            {accountName(account)}
            {account.plan ? ` · ${planLabel(account.plan)}` : ''}
          </div>
        )}
      </div>
    </div>
  )
}

function ToolCompact({ state, tool, now, picked, onPick }: { state: CliAccountsState; tool: CliTool; now: number; picked: boolean; onPick: () => void }): JSX.Element {
  const usage = usageOf(state, tool)
  const loading = state.loading.includes(usageKey(tool, state.tools[tool].active))
  return (
    <div className="usage-compact" data-picked={picked || undefined}>
      <button className="usage-compact__tool" onClick={onPick} title="Show this one in the header">
        {CLI_TOOL_NAME[tool]}
        <span>{CLI_TOOL_SOURCE[tool]}</span>
      </button>
      {usage?.ok ? (
        usage.windows.map((w) => (
          <div key={w.id} className="usage-compact__row" data-severity={w.severity}>
            <span className="usage-compact__label">{w.label}</span>
            <span className="usage-compact__bar">
              <span style={{ width: `${Math.max(w.percent, 2)}%` }} />
            </span>
            <span className="usage-compact__percent">{w.percent}%</span>
            <span className="usage-compact__when">{untilText(w.resetsAt, now) ?? ''}</span>
          </div>
        ))
      ) : (
        <Status usage={usage} tool={tool} loading={loading} />
      )}
    </div>
  )
}

function Status({ usage, tool, loading }: { usage: AccountUsage | undefined; tool: CliTool; loading: boolean }): JSX.Element | null {
  if (!usage) return <p className="usage-status">{loading ? `Asking ${CLI_TOOL_NAME[tool]}…` : 'Not read yet'}</p>
  if (usage.ok) return usage.windows.length === 0 ? <p className="usage-status">No limits reported for this plan.</p> : null
  if (usage.reason === 'signed-out') {
    return (
      <p className="usage-status">
        Not signed in to {CLI_TOOL_NAME[tool]}. Run <code>{tool === 'claude' ? 'claude' : 'codex login'}</code> in a pane, or add an account in Usage settings.
      </p>
    )
  }
  return <p className="usage-status" data-error={usage.reason === 'failed' || undefined}>{usage.message}</p>
}

function resetText(w: UsageWindow, now: number): string {
  const until = untilText(w.resetsAt, now)
  return until ? `resets in ${until}` : w.span
}

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
