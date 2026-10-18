import { useEffect, useRef, useState, type JSX } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { CLI_TOOLS, CLI_TOOL_NAME, accountName, usageKey, type AccountUsage, type CliTool, type UsageWindow } from '@shared/cliAccounts'
import { useApp } from '../state/store'
import { useCliAccounts, untilText } from '../state/cliAccounts'
import { Popover } from './ui'
import { ProviderMark } from './composer/ProviderMark'
import '../styles/usageRings.css'

/**
 * The sidebar's plan usage: one ring per coding CLI that is signed in, its
 * logo in the middle, the week round the outside and the five-hour session
 * inside it, each arc the share still left. A click opens the figures: how
 * much of each window is left, when it resets, and whether the current pace
 * lasts until then.
 *
 * The figures are the CLIs' own (main's cliAccounts feature), read again
 * every few minutes and whenever the card opens.
 */

const MARK: Record<CliTool, string> = { claude: 'anthropic', codex: 'openai' }
const REFRESH_MS = 5 * 60_000

const usageOf = (tool: CliTool): ((s: ReturnType<typeof useCliAccounts.getState>) => AccountUsage | undefined) => (s) =>
  s.state ? s.state.usage[usageKey(tool, s.state.tools[tool].active)] : undefined

/**
 * What the ring draws: the week outside and the five-hour session inside.
 * A plan with neither (Codex's free tier counts by the month) gets one ring
 * for its first limit, named as that limit rather than passed off as a session.
 */
function pick(windows: UsageWindow[]): { outer?: UsageWindow; inner?: UsageWindow } {
  const session = windows.find((w) => w.id === 'session')
  const week = windows.find((w) => w.id === 'week') ?? windows.find((w) => w !== session && /week/i.test(w.label))
  if (session || week) return { outer: week, inner: session }
  return { inner: windows[0] }
}

/** A window's short name, as the card's rows and legend give it. */
const shortName = (w: UsageWindow): string => (w.id === 'session' ? '5h' : w.id === 'week' ? 'Weekly' : w.label)

export function UsageRings({ where = 'sidebar' }: { where?: 'sidebar' | 'header' }): JSX.Element | null {
  const { state, ensure, refresh } = useCliAccounts()
  // One card at a time: opening one ring's card closes the other's.
  const [opened, setOpened] = useState<CliTool | null>(null)

  useEffect(() => {
    ensure()
    void refresh()
    const id = setInterval(() => void refresh(), REFRESH_MS)
    return () => clearInterval(id)
  }, [ensure, refresh])

  if (!state) return null
  const tools = CLI_TOOLS.filter((t) => state.tools[t].installed)
  if (tools.length === 0) return null
  return (
    <div className="usage-rings" data-where={where} role="group" aria-label="Plan usage">
      {tools.map((tool) => (
        <Ring key={tool} tool={tool} where={where} open={opened === tool} setOpen={(open) => setOpened(open ? tool : null)} />
      ))}
    </div>
  )
}

function Ring({ tool, where, open, setOpen }: { tool: CliTool; where: 'sidebar' | 'header'; open: boolean; setOpen: (open: boolean) => void }): JSX.Element {
  const usage = useCliAccounts(usageOf(tool))
  const anchor = useRef<HTMLButtonElement>(null)
  const { outer, inner } = usage?.ok ? pick(usage.windows) : {}
  const left = (w?: UsageWindow): number => (w ? Math.max(0, 100 - w.percent) : 0)
  const label = usage?.ok
    ? [inner, outer]
        .filter((w): w is UsageWindow => Boolean(w))
        .map((w) => `${left(w)}% of ${shortName(w)} left`)
        .join(', ') || 'No limits reported'
    : 'Usage not available'

  return (
    <>
      <button
        ref={anchor}
        className="usage-ring"
        data-open={open || undefined}
        data-off={!usage?.ok || undefined}
        onClick={() => {
          setOpen(!open)
          if (!open) void useCliAccounts.getState().refresh({ tool, force: true })
        }}
        aria-label={`${CLI_TOOL_NAME[tool]}: ${label}`}
        title={`${CLI_TOOL_NAME[tool]} · ${label}`}
      >
        <svg className="usage-ring__svg" viewBox="0 0 40 40" aria-hidden="true">
          {outer && <Arc r={17.5} left={left(outer)} tone={tone(outer, 'week')} />}
          {inner && <Arc r={outer ? 12.5 : 16} left={left(inner)} tone={tone(inner, 'session')} />}
          {!inner && !outer && <circle className="usage-ring__track" cx="20" cy="20" r="16" />}
        </svg>
        <span className="usage-ring__mark">
          <ProviderMark providerId={MARK[tool]} size={outer ? 13 : 15} />
        </span>
      </button>
      {/* Beside the sidebar from its foot; under the ring from the ADE's header. */}
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        placement={where === 'sidebar' ? 'right-start' : 'bottom-end'}
        against=".sidebar__panel"
        standalone
        offset={10}
        width={300}
        className="usage-card"
      >
        <UsageCard tool={tool} close={() => setOpen(false)} />
      </Popover>
    </>
  )
}

/** Plenty left reads as the window's own colour; running low, as a warning. */
function tone(w: UsageWindow, kind: 'session' | 'week'): string {
  const left = 100 - w.percent
  if (left <= 10) return 'low'
  if (left <= 25) return 'warn'
  return kind
}

function Arc({ r, left, tone }: { r: number; left: number; tone: string }): JSX.Element {
  const length = 2 * Math.PI * r
  const shown = Math.max(0, Math.min(100, left))
  return (
    <>
      <circle className="usage-ring__track" cx="20" cy="20" r={r} />
      <circle
        className="usage-ring__arc"
        data-tone={tone}
        cx="20"
        cy="20"
        r={r}
        strokeDasharray={`${(length * shown) / 100} ${length}`}
        // From twelve o'clock, clockwise.
        transform="rotate(-90 20 20)"
      />
    </>
  )
}

/* ------------------------------------------------------------------- card */

/** How long each window runs, for the pace: the five-hour session, the week, the month. */
function spanMs(w: UsageWindow): number | null {
  const text = `${w.id} ${w.label} ${w.span}`
  if (w.id === 'session' || /5\s*h/i.test(w.span)) return 5 * 3_600_000
  if (/week|7\s*d/i.test(text)) return 7 * 24 * 3_600_000
  if (/month|30\s*d/i.test(text)) return 30 * 24 * 3_600_000
  return null
}

/**
 * Whether the pace so far lasts the window: how far ahead of an even spend it
 * is, or when it runs out at this rate.
 */
function pace(w: UsageWindow, now: number): { reserve: number; at: number | null; expected: number } | null {
  const span = spanMs(w)
  if (!span || w.resetsAt === null) return null
  const elapsed = Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / span))
  if (elapsed <= 0.02) return null
  const expected = Math.round(elapsed * 100)
  const reserve = expected - w.percent
  const rate = w.percent / (elapsed * span)
  const at = reserve < 0 && rate > 0 ? now + (100 - w.percent) / rate : null
  return { reserve, at, expected }
}

function UsageCard({ tool, close }: { tool: CliTool; close: () => void }): JSX.Element {
  const state = useCliAccounts((s) => s.state)
  const usage = useCliAccounts(usageOf(tool))
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const account = state?.tools[tool].accounts.find((a) => a.id === state.tools[tool].active)
  const loading = Boolean(state?.loading.includes(usageKey(tool, state.tools[tool].active)))
  const { outer, inner } = usage?.ok ? pick(usage.windows) : {}
  const plan = usage?.ok ? usage.plan : account?.plan

  return (
    <div className="usage-card__inner">
      <header className="usage-card__head">
        <span className="usage-card__title">{CLI_TOOL_NAME[tool]}</span>
        {plan && <span className="usage-card__plan">{plan.charAt(0).toUpperCase() + plan.slice(1)}</span>}
        <button
          className="usage-card__refresh"
          data-spinning={loading || undefined}
          onClick={() => void useCliAccounts.getState().refresh({ tool, force: true })}
          aria-label="Read usage again"
          title="Read usage again"
        >
          <RefreshCw size={12} strokeWidth={2} />
        </button>
      </header>

      {/* Which arc is which, when there are two to tell apart. */}
      {usage?.ok && outer && inner && (
        <div className="usage-card__legend">
          <span>
            <i data-tone="week" /> {shortName(outer)} · outer
          </span>
          <span>
            <i data-tone="session" /> {shortName(inner)} · inner
          </span>
        </div>
      )}

      {usage?.ok ? (
        usage.windows.length === 0 ? (
          <p className="usage-card__note">No limits reported for this plan.</p>
        ) : (
          usage.windows.map((w) => <WindowRow key={w.id} w={w} now={now} kind={w === outer ? 'week' : w === inner ? 'session' : 'other'} />)
        )
      ) : (
        <p className="usage-card__note">
          {!usage
            ? loading
              ? `Asking ${CLI_TOOL_NAME[tool]}…`
              : 'Not read yet.'
            : usage.reason === 'signed-out'
              ? `Not signed in to ${CLI_TOOL_NAME[tool]}.`
              : usage.message}
        </p>
      )}

      <button
        className="usage-card__more"
        onClick={() => {
          close()
          setSettingsPage('accounts')
        }}
      >
        <ChevronRight size={13} strokeWidth={2} />
        Details
        {account && <span className="usage-card__account">{accountName(account)}</span>}
      </button>
    </div>
  )
}

function WindowRow({ w, now, kind }: { w: UsageWindow; now: number; kind: 'session' | 'week' | 'other' }): JSX.Element {
  const left = Math.max(0, 100 - w.percent)
  const until = untilText(w.resetsAt, now)
  const p = pace(w, now)
  const label = shortName(w)
  return (
    <div className="usage-row">
      <div className="usage-row__top">
        <span className="usage-row__label">{label}</span>
        <span className="usage-row__left">{left}% left</span>
        <span className="usage-row__reset">{until ? `Resets in ${until}` : w.span}</span>
      </div>
      <div className="usage-row__bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label={`${label}: ${left}% left`}>
        <span data-tone={kind === 'other' ? tone(w, 'session') : tone(w, kind)} style={{ width: `${Math.max(left, 1.5)}%` }} />
        {/* Where an even spend would have the window by now. */}
        {p && <i style={{ left: `${100 - p.expected}%` }} />}
      </div>
      {p && (
        <div className="usage-row__pace">
          {p.reserve >= 0 ? (
            <>
              <span>{p.reserve}% in reserve</span>
              <span>Lasts until reset</span>
            </>
          ) : (
            <>
              <span data-over>{-p.reserve}% ahead of pace</span>
              <span>{p.at && untilText(p.at, now) ? `Runs out in ~${untilText(p.at, now)}` : 'May run out early'}</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
