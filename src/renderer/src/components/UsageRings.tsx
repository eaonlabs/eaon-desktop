import { useEffect, useRef, useState, type JSX } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import type { ProviderWindow, UsageProviderId } from '@shared/providerUsage'
import { useApp } from '../state/store'
import { ensureLimits, limitsView, refreshLimits, useLimitsSources, type LimitsView } from '../state/limits'
import { LimitsCard, windowName } from './LimitsCard'
import { Popover } from './ui'
import { ProviderMark } from './composer/ProviderMark'
import '../styles/usageRings.css'
import '../styles/limits.css'

/**
 * The sidebar's plan usage: a ring for each provider picked in Settings →
 * Usage & limits (at most two), its logo in the middle. Both limits draw
 * the week round the outside and the five-hour session inside, each arc the
 * share still left; or one ring for whichever the setting picks. A click
 * opens the provider's card: every limit, when each resets, whether the pace
 * lasts, and its details.
 */

const REFRESH_MS = 5 * 60_000

/** What the ring draws, by the setting: both limits, or one of them. */
function pick(windows: ProviderWindow[], mode: 'both' | '5h' | 'weekly'): { outer?: ProviderWindow; inner?: ProviderWindow } {
  const session = windows.find((w) => w.id === 'session') ?? windows.find((w) => /5\s*h/i.test(`${w.label} ${w.span}`))
  const week = windows.find((w) => w.id === 'week') ?? windows.find((w) => w !== session && /week/i.test(w.label))
  if (mode === '5h') return { inner: session ?? week ?? windows[0] }
  if (mode === 'weekly') return { inner: week ?? session ?? windows[0] }
  if (session || week) return { outer: week, inner: session }
  return { inner: windows[0] }
}

export function UsageRings({ where = 'sidebar' }: { where?: 'sidebar' | 'header' }): JSX.Element | null {
  const { cli, provider } = useLimitsSources()
  const chosen = useApp((s) => s.settings?.usageLimits?.sidebar ?? ['codex', 'claude'])
  // One card at a time: opening one ring's card closes the other's.
  const [opened, setOpened] = useState<string | null>(null)

  useEffect(() => {
    ensureLimits()
    const id = setInterval(() => void refreshLimits(), REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  const now = Date.now()
  const views = chosen
    .slice(0, 2)
    .map((id) => limitsView(id as UsageProviderId, cli, provider, now))
    .filter((v): v is LimitsView => v !== null)
  if (views.length === 0) return null
  return (
    <div className="usage-rings" data-where={where} role="group" aria-label="Plan usage">
      {views.map((view) => (
        <Ring key={view.id} view={view} where={where} open={opened === view.id} setOpen={(open) => setOpened(open ? view.id : null)} />
      ))}
    </div>
  )
}

function Ring({ view, where, open, setOpen }: { view: LimitsView; where: 'sidebar' | 'header'; open: boolean; setOpen: (open: boolean) => void }): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const limits = useApp((s) => s.settings?.usageLimits)
  const patchSettings = useApp((s) => s.patchSettings)
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  const [details, setDetails] = useState(limits?.details ?? false)
  const { outer, inner } = pick(view.windows, limits?.ring ?? 'both')
  const left = (w?: ProviderWindow): number => (w ? Math.max(0, 100 - w.percent) : 0)
  const label =
    [inner, outer]
      .filter((w): w is ProviderWindow => Boolean(w))
      .map((w) => `${Math.round(left(w))}% of ${windowName(w)} left`)
      .join(', ') || (view.note ?? 'No limits reported')

  return (
    <>
      <button
        ref={anchor}
        className="usage-ring"
        data-open={open || undefined}
        data-off={view.windows.length === 0 || undefined}
        onClick={() => {
          setOpen(!open)
          if (!open) {
            setDetails(limits?.details ?? false)
            void refreshLimits()
          }
        }}
        aria-label={`${view.name}: ${label}`}
        title={`${view.name} · ${label}`}
      >
        <svg className="usage-ring__svg" viewBox="0 0 40 40" aria-hidden="true">
          {outer && <Arc r={17.5} left={left(outer)} tone={tone(outer, 'week')} />}
          {inner && <Arc r={outer ? 12.5 : 16} left={left(inner)} tone={tone(inner, 'session')} />}
          {!inner && !outer && <circle className="usage-ring__track" cx="20" cy="20" r="16" />}
        </svg>
        <span className="usage-ring__mark">
          <ProviderMark providerId={view.mark} size={outer ? 13 : 15} />
        </span>
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        placement={where === 'sidebar' ? 'right-start' : 'bottom-end'}
        against=".sidebar__panel"
        standalone
        offset={10}
        width={320}
        className="usage-card"
      >
        <div className="usage-card__inner">
          <LimitsCard
            view={view}
            flat
            details={details}
            banked={limits?.banked ?? true}
            tokens={limits?.tokens ?? true}
            onDetailsChange={(next) => {
              setDetails(next)
              // The last choice is the next card's default.
              if (limits) void patchSettings({ usageLimits: { ...limits, details: next } })
            }}
          />
          <div className="usage-card__foot">
            <button className="usage-card__refresh" onClick={() => void refreshLimits()} aria-label="Read usage again" title="Read usage again">
              <RefreshCw size={12} strokeWidth={2} />
            </button>
            <button
              className="usage-card__more"
              onClick={() => {
                setOpen(false)
                setSettingsPage('usage-limits')
              }}
            >
              Usage & limits
              <ChevronRight size={13} strokeWidth={2} />
            </button>
          </div>
        </div>
      </Popover>
    </>
  )
}

/** Plenty left reads as the window's own colour; running low, as a warning. */
function tone(w: ProviderWindow, kind: 'session' | 'week'): string {
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
