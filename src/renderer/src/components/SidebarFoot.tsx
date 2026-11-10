import { useEffect, useRef, useState, type JSX, type RefObject } from 'react'
import type { Settings } from '@shared/types'
import type { UsageDay, UsageTool } from '@shared/usage'
import { useApp } from '../state/store'
import { compactTokens } from '../state/limits'
import { money } from './settings/pages/Usage'
import { TOOL_LABEL, TOOL_ORDER } from './settings/pages/usageTools'
import { MenuItem, MenuSeparator, Popover } from './ui'
import { UsageRings } from './UsageRings'

type Foot = Settings['sidebarFoot']

export const FOOT_DEFAULTS: Foot = { show: true, period: 'today', figure: 'tokens', chart: true, rings: true }

/** How often the CLIs' own logs are looked at again, which also turns the day over at midnight. */
const REREAD_MS = 5 * 60_000

/** The last seven days, today last: read again when Eaon records use, and every few minutes for the CLIs' own. */
function useWeek(wanted: boolean): UsageDay[] | null {
  const [week, setWeek] = useState<UsageDay[] | null>(null)
  useEffect(() => {
    if (!wanted) return
    let live = true
    const load = (): void => {
      window.api.usage.week().then(
        (days) => live && setWeek(days),
        () => {}
      )
    }
    load()
    const stop = window.api.usage.onChanged(load)
    const timer = setInterval(load, REREAD_MS)
    return () => {
      live = false
      stop()
      clearInterval(timer)
    }
  }, [wanted])
  return week
}

/** Days added up, by tool too. */
function total(days: UsageDay[]): { tokens: number; costUsd: number; planUsd: number; tools: Map<UsageTool, number> } {
  const sum = { tokens: 0, costUsd: 0, planUsd: 0, tools: new Map<UsageTool, number>() }
  for (const day of days) {
    sum.tokens += day.tokens
    sum.costUsd += day.costUsd
    sum.planUsd += day.planUsd ?? 0
    for (const tool of TOOL_ORDER) {
      const tokens = day.tools?.[tool]?.tokens ?? 0
      if (tokens > 0) sum.tools.set(tool, (sum.tools.get(tool) ?? 0) + tokens)
    }
  }
  return sum
}

/**
 * What the use stands for in dollars, as the Usage chart counts it: spend
 * plus plan use at API rates, marked ≈ when a plan is in it.
 */
function dollarsOf(costUsd: number, planUsd: number): string {
  const usd = costUsd + planUsd
  return `${planUsd > 0 ? '≈ ' : ''}${usd >= 100 ? `$${Math.round(usd).toLocaleString()}` : money(usd)}`
}

/**
 * The foot of the sidebar: how much was used today (or over the week)
 * across Eaon, Claude Code and Codex, a bar a day for the week, and how
 * much of the Claude and Codex plans is left. Each part, and the foot
 * itself, can be turned off in Settings → Usage & limits or by
 * right-clicking it. The figures open Settings → Usage, which breaks them down.
 */
export function SidebarFoot({ rings: ringsHere }: { rings: boolean }): JSX.Element | null {
  const saved = useApp((s) => s.settings?.sidebarFoot)
  const patchSettings = useApp((s) => s.patchSettings)
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  const foot: Foot = { ...FOOT_DEFAULTS, ...saved }
  const set = (patch: Partial<Foot>): void => void patchSettings({ sidebarFoot: { ...foot, ...patch } })
  const usageShown = foot.chart || foot.figure !== 'none'
  const week = useWeek(foot.show && usageShown)
  const root = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState(false)

  const rings = ringsHere && foot.rings
  if (!foot.show || (!usageShown && !rings)) return null

  let usage: JSX.Element | null = null
  if (usageShown && week?.length) {
    const today = week[week.length - 1]
    const sum = total(foot.period === 'today' ? [today] : week)
    const other = total(foot.period === 'today' ? week : [today])
    const period = foot.period === 'today' ? 'Today' : '7 days'
    const tokens = sum.tokens > 0 ? `${compactTokens(sum.tokens)} tokens` : ''
    const dollars = sum.costUsd + sum.planUsd > 0 ? dollarsOf(sum.costUsd, sum.planUsd) : ''
    const [main, sub] =
      foot.figure === 'dollars'
        ? [dollars || (tokens ? '$0' : 'Nothing yet'), tokens ? `${period} · ${tokens}` : period]
        : [tokens || 'No tokens yet', dollars ? `${period} · ${dollars}` : period]
    const byTool = [...sum.tools].sort((a, b) => b[1] - a[1])
    const title = [
      byTool.length > 0
        ? `${foot.period === 'today' ? 'Today' : 'Last 7 days'}: ${byTool.map(([tool, n]) => `${TOOL_LABEL[tool]} ${compactTokens(n)}`).join(', ')}`
        : foot.period === 'today'
          ? 'Nothing used yet today'
          : 'Nothing used in the last 7 days',
      sum.costUsd > 0 ? `${money(sum.costUsd)} spent` : null,
      sum.planUsd > 0 ? `≈ ${money(sum.planUsd)} covered by plans: what it would cost at API rates, not a charge` : null,
      `${foot.period === 'today' ? 'Last 7 days' : 'Today'}: ${compactTokens(other.tokens)} tokens`,
      'Click for Settings → Usage. Right-click to change what shows here'
    ]
      .filter(Boolean)
      .join('\n')
    usage = (
      <button className="today" title={title} onClick={() => setSettingsPage('usage')}>
        {foot.chart && <WeekBars days={week} />}
        {foot.figure !== 'none' && (
          <span className="today__text">
            <span className="today__main">{main}</span>
            <span className="today__sub">{sub}</span>
          </span>
        )}
      </button>
    )
  }

  return (
    <div
      ref={root}
      className="sidebar-foot"
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu(true)
      }}
    >
      {usage ?? <span className="sidebar-foot__gap" />}
      {rings && <UsageRings placement="top-end" />}
      <FootMenu anchor={root} open={menu} onClose={() => setMenu(false)} foot={foot} set={set} ringsHere={ringsHere} />
    </div>
  )
}

/** Right-click: what the foot shows, changed in place. It stays open, to change more than one thing. */
function FootMenu({
  anchor,
  open,
  onClose,
  foot,
  set,
  ringsHere
}: {
  anchor: RefObject<HTMLElement>
  open: boolean
  onClose: () => void
  foot: Foot
  set: (patch: Partial<Foot>) => void
  ringsHere: boolean
}): JSX.Element {
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  // The last part showing stays: turning it off would take the foot, and
  // this menu with it, away. Hide footer is the way to do that.
  const numbers = foot.figure !== 'none'
  const rings = ringsHere && foot.rings
  const only = (part: boolean, ...others: boolean[]): boolean => part && !others.some(Boolean)
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="top-start" width={220}>
      <MenuItem title="Tokens first" checked={foot.figure === 'tokens'} onClick={() => set({ figure: 'tokens' })} />
      <MenuItem title="Dollars first" checked={foot.figure === 'dollars'} onClick={() => set({ figure: 'dollars' })} />
      <MenuItem title="No numbers" checked={!numbers} disabled={only(numbers, foot.chart, rings)} onClick={() => set({ figure: 'none' })} />
      <MenuSeparator />
      <MenuItem title="Today" checked={foot.period === 'today'} disabled={!numbers} onClick={() => set({ period: 'today' })} />
      <MenuItem title="Last 7 days" checked={foot.period === 'week'} disabled={!numbers} onClick={() => set({ period: 'week' })} />
      <MenuSeparator />
      <MenuItem title="Week chart" checked={foot.chart} disabled={only(foot.chart, numbers, rings)} onClick={() => set({ chart: !foot.chart })} />
      {ringsHere && <MenuItem title="Plan rings" checked={foot.rings} disabled={only(rings, numbers, foot.chart)} onClick={() => set({ rings: !foot.rings })} />}
      <MenuSeparator />
      <MenuItem
        title="More options…"
        onClick={() => {
          onClose()
          setSettingsPage('usage-limits')
        }}
      />
      <MenuItem
        title="Hide footer"
        onClick={() => {
          onClose()
          set({ show: false })
        }}
      />
    </Popover>
  )
}

/**
 * A bar a day, today's in the accent, each against the week's busiest. On
 * a square-root scale, so a quiet day still shows beside a heavy one.
 */
function WeekBars({ days }: { days: UsageDay[] }): JSX.Element {
  const top = Math.sqrt(Math.max(1, ...days.map((day) => day.tokens)))
  return (
    <span className="today__bars" aria-hidden>
      {days.map((day, i) => (
        <span
          key={day.day}
          data-today={i === days.length - 1 || undefined}
          style={day.tokens > 0 ? { height: `${Math.max(15, (Math.sqrt(day.tokens) / top) * 100)}%` } : undefined}
        />
      ))}
    </span>
  )
}
