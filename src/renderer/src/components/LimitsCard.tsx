import { useEffect, useState, type JSX } from 'react'
import { ChevronDown } from 'lucide-react'
import { usagePace, type ProviderWindow } from '@shared/providerUsage'
import { untilText } from '../state/cliAccounts'
import { compactTokens, type LimitsView } from '../state/limits'
import { ProviderMark } from './composer/ProviderMark'

/**
 * One provider's limits: each window as a bar of what's left, with a tick
 * where an even spend would have it by now and whether the pace lasts until
 * it resets; then the details — balances, banked resets and recent token
 * totals. Settings → Usage & limits shows it whole; a header ring's card
 * keeps the details behind a toggle unless the setting opens them.
 */

/** A window's short name: "5h", "Weekly", else its own. */
export const windowName = (w: ProviderWindow): string => (w.id === 'session' ? '5h' : w.id === 'week' ? 'Weekly' : w.label)

/** Plenty left in the window's colour; running low, a warning, then danger. */
function tone(w: ProviderWindow): 'good' | 'warn' | 'low' {
  const left = 100 - w.percent
  return left <= 10 ? 'low' : left <= 25 ? 'warn' : 'good'
}

export function useNow(every = 30_000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(id)
  }, [every])
  return now
}

export function LimitRow({ w, now }: { w: ProviderWindow; now: number }): JSX.Element {
  const left = Math.max(0, Math.round(100 - w.percent))
  const until = untilText(w.resetsAt, now)
  const pace = usagePace(w, now)
  // Where an even spend would have the bar by now, as a share left.
  const expectedLeft = pace ? Math.max(0, Math.min(100, left - pace.reserve)) : null
  const label = windowName(w)
  return (
    <div className="limit">
      <div className="limit__name">
        {label}
        <i className="limit__dot" data-tone={w.reached ? 'low' : tone(w)} />
        {w.detail && <span className="limit__detail">{w.detail}</span>}
      </div>
      <div className="limit__bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label={`${label}: ${left}% left`}>
        <span data-tone={tone(w)} style={{ width: `${Math.max(left, left > 0 ? 1.5 : 0)}%` }} />
        {expectedLeft !== null && <i style={{ left: `${expectedLeft}%` }} />}
      </div>
      <div className="limit__line">
        <span>{w.reached ? 'Limit reached' : `${left}% left`}</span>
        <span>{until ? `Resets in ${until}` : w.span}</span>
      </div>
      {pace && (
        <div className="limit__line limit__line--quiet">
          {pace.reserve >= 0 ? <span>{pace.reserve}% in reserve</span> : <span data-over>{-pace.reserve}% in deficit</span>}
          <span>{pace.runsOutAt && untilText(pace.runsOutAt, now) ? `Runs out in ~${untilText(pace.runsOutAt, now)}` : 'Lasts until reset'}</span>
        </div>
      )}
    </div>
  )
}

function Details({ view, banked, tokens, now }: { view: LimitsView; banked: boolean; tokens: boolean; now: number }): JSX.Element | null {
  const lines = tokens ? view.lines : []
  const showBanked = banked && view.banked && view.banked.available > 0
  const totals = tokens ? view.tokens : null
  if (lines.length === 0 && !showBanked && !totals) return null
  const span = (label: string, t: { tokens: number; sessions: number | null }): JSX.Element => (
    <div className="limits-detail">
      <div>
        <span className="limits-detail__label">{label}</span>
        {t.sessions !== null && t.sessions > 0 && <span className="limits-detail__sub">{t.sessions === 1 ? '1 recent session' : `${t.sessions} recent sessions`}</span>}
      </div>
      <span className="limits-detail__value">{compactTokens(t.tokens)} tokens</span>
    </div>
  )
  return (
    <div className="limits-card__details">
      {lines.map((line) => (
        <div key={line.label + line.value} className="limits-detail">
          <div>
            <span className="limits-detail__label">{line.label}</span>
            {line.sub && <span className="limits-detail__sub">{line.sub}</span>}
          </div>
          <span className="limits-detail__value">{line.value}</span>
        </div>
      ))}
      {showBanked && (
        <div className="limits-detail">
          <div>
            <span className="limits-detail__label">Banked resets</span>
            {view.banked!.nextExpiry && <span className="limits-detail__sub">Next expires in {untilText(view.banked!.nextExpiry, now)}</span>}
          </div>
          <span className="limits-detail__value">{view.banked!.available}</span>
        </div>
      )}
      {totals && (
        <>
          {span('24h', totals.day)}
          {span('7d', totals.week)}
          {span('30d', totals.month)}
        </>
      )}
    </div>
  )
}

export function LimitsCard({
  view,
  details,
  banked,
  tokens,
  onDetailsChange,
  flat = false
}: {
  view: LimitsView
  /** Details showing; with onDetailsChange, behind a toggle. */
  details: boolean
  banked: boolean
  tokens: boolean
  onDetailsChange?: (open: boolean) => void
  /** Inside a popover: no card border of its own. */
  flat?: boolean
}): JSX.Element {
  const now = useNow()
  const hasDetails = (tokens && (view.lines.length > 0 || view.tokens !== null)) || (banked && (view.banked?.available ?? 0) > 0)
  return (
    <section className="limits-card" data-flat={flat || undefined}>
      <header className="limits-card__head">
        <span className="limits-card__mark">
          <ProviderMark providerId={view.mark} size={20} />
        </span>
        <span className="limits-card__who">
          <span className="limits-card__name">{view.name}</span>
          <span className="limits-card__account">{view.account ?? 'Default account'}</span>
        </span>
        {view.plan && <span className="limits-card__plan">{view.plan.charAt(0).toUpperCase() + view.plan.slice(1)}</span>}
      </header>

      {view.windows.length > 0 ? (
        <div className="limits-card__limits">
          {view.windows.map((w) => (
            <LimitRow key={w.id} w={w} now={now} />
          ))}
        </div>
      ) : (
        <div className="limits-card__note">
          <span className="limits-detail__label">Limits</span>
          <span>{view.status === 'loading' ? `Asking ${view.name}…` : (view.note ?? 'No limits reported for this plan.')}</span>
        </div>
      )}
      {view.windows.length > 0 && view.note && <p className="limits-card__aside">{view.note}</p>}

      {hasDetails && onDetailsChange && (
        <button className="limits-card__toggle" aria-expanded={details} onClick={() => onDetailsChange(!details)}>
          Details
          <ChevronDown size={13} strokeWidth={2} />
        </button>
      )}
      {details && <Details view={view} banked={banked} tokens={tokens} now={now} />}
    </section>
  )
}
