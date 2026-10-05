import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { UsageDay, UsageModelRow, UsageRange, UsageSource, UsageSourceRow, UsageSummary } from '@shared/usage'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Segmented } from '../../ui'
import { ProviderMark } from '../../composer/ProviderMark'
import { UsageActivity } from './UsageActivity'

/**
 * Settings → Usage: what Eaon's own model requests cost, day by day and model
 * by model, tracked with Tokn. Eaon counts on this computer from the start;
 * the numbers show here, and upload to the user's Tokn profile, once they
 * sign in with Tokn.
 */

const RANGES: { value: string; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' }
]
const RANGE_KEY = 'eaon.usage.range'

function savedRange(): UsageRange {
  try {
    const value = Number(localStorage.getItem(RANGE_KEY))
    return value === 7 || value === 90 ? value : 30
  } catch {
    return 30
  }
}

export const money = (usd: number): string => {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd >= 10_000) return `$${(usd / 1000).toFixed(1)}k`
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export const tokens = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

const dayLabel = (day: string, long = false): string =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' })

function ago(iso: string | null): string {
  if (!iso) return 'not yet'
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Tokn's mark, as on toknhq.com. */
function ToknMark({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg className="tokn-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#ccff33" />
      <path d="M13 7H9a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" stroke="#121214" strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <path d="M19 7h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" stroke="#121214" strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <rect x="13.5" y="13.5" width="5" height="5" rx="1.5" fill="#121214" />
    </svg>
  )
}

function useUsage(range: UsageRange): UsageSummary | null {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const load = useCallback(() => {
    void window.api.usage.summary(range).then(setSummary)
  }, [range])
  useEffect(() => {
    load()
    const stop = window.api.usage.onChanged(load)
    // "Synced 3 min ago" moves on its own.
    const tick = window.setInterval(load, 60_000)
    return () => {
      stop()
      window.clearInterval(tick)
    }
  }, [load])
  return summary
}

export function UsagePage(): JSX.Element {
  const [range, setRange] = useState<UsageRange>(savedRange)
  const summary = useUsage(range)

  const pickRange = (value: string): void => {
    const next = Number(value) as UsageRange
    setRange(next)
    try {
      localStorage.setItem(RANGE_KEY, String(next))
    } catch {
      /* the default is fine */
    }
  }

  return (
    <>
      <h1 className="settings__h1">Usage</h1>
      <p className="settings__lede">
        What your AI use in Eaon costs, model by model and day by day, tracked with Tokn. Sign in with your Tokn account to see
        it here and on your Tokn profile.
      </p>
      {!summary ? null : summary.account ? <SignedIn summary={summary} range={range} onRange={pickRange} /> : <SignedOut summary={summary} />}
    </>
  )
}

function SignedOut({ summary }: { summary: UsageSummary }): JSX.Element {
  const pending = summary.signIn.state === 'pending'
  const [paste, setPaste] = useState('')
  const [showPaste, setShowPaste] = useState(false)

  useEffect(() => {
    if (!pending) {
      setShowPaste(false)
      return
    }
    // Most sign-ins come straight back; the paste box is only for when the browser can't reach Eaon.
    const timer = window.setTimeout(() => setShowPaste(true), 20_000)
    return () => window.clearTimeout(timer)
  }, [pending])

  return (
    <>
      <Section>
        <div className="usage-hero">
          <ToknMark size={44} />
          <div className="usage-hero__text">
            <div className="usage-hero__title">Sign in with Tokn</div>
            <p className="usage-hero__body">
              Tokn tracks what AI coding costs across your tools. Signing in adds Eaon to your Tokn account, shows your Eaon usage
              here, and keeps your Tokn profile up to date.
            </p>
            <div className="usage-hero__actions">
              {pending ? (
                <>
                  <button className="btn" onClick={() => void window.api.usage.cancelSignIn()}>
                    <Loader2 size={14} className="spinner" /> Waiting for Tokn… Cancel
                  </button>
                  {summary.signIn.url && (
                    <button className="btn btn--ghost" onClick={() => void window.api.app.openExternal(summary.signIn.url!)}>
                      Open the page again <ExternalLink size={12} strokeWidth={2} />
                    </button>
                  )}
                </>
              ) : (
                <button className="btn btn--primary usage-hero__signin" onClick={() => void window.api.usage.signIn()}>
                  <ToknMark size={16} /> Sign in with Tokn
                </button>
              )}
              {!pending && (
                <button className="btn btn--ghost" onClick={() => void window.api.app.openExternal('https://toknhq.com')}>
                  What’s Tokn? <ExternalLink size={12} strokeWidth={2} />
                </button>
              )}
            </div>
            {pending && (
              <p className="usage-hero__hint">
                Approve Eaon on toknhq.com in your browser. New to Tokn? Create an account there: Tokn walks you through setup,
                then brings you back to connect Eaon. This page updates by itself.
              </p>
            )}
            {pending && showPaste && (
              <div className="usage-paste">
                <input
                  className="input"
                  placeholder="Browser didn’t come back? Paste the address it ended on"
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && paste.trim() && void window.api.usage.submitCode(paste.trim())}
                  spellCheck={false}
                />
                <button className="btn btn--sm" disabled={!paste.trim()} onClick={() => void window.api.usage.submitCode(paste.trim())}>
                  Continue
                </button>
              </div>
            )}
            {summary.signIn.state === 'error' && <p className="usage-error">{summary.signIn.error}</p>}
          </div>
        </div>
      </Section>

      {summary.totals.requests > 0 && (
        <p className="usage-counted">
          Eaon has counted {summary.totals.requests.toLocaleString()} {summary.totals.requests === 1 ? 'request' : 'requests'} in
          the last {summary.range} days. They show up here once you sign in.
        </p>
      )}

      <WhatIsSent />
    </>
  )
}

function WhatIsSent(): JSX.Element {
  return (
    <Section label="What Tokn gets">
      <Card>
        <Row
          title="Daily totals per model"
          description="Requests, tokens and the estimated cost, one line per model per day. Never your prompts, Eaon’s replies, code or file names."
        />
        <Row
          title="Only Eaon’s own requests"
          description="Requests other apps make through Eaon (Connect apps, the Local API Server) count as those apps, not as Eaon."
        />
        <Row title="Nothing from models on this computer" description="Local models are free, so they stay here and are never uploaded." />
      </Card>
    </Section>
  )
}

function SignedIn({ summary, range, onRange }: { summary: UsageSummary; range: UsageRange; onRange: (value: string) => void }): JSX.Element {
  const account = summary.account!
  const { sync } = summary
  const syncing = sync.state === 'syncing'

  return (
    <>
      <Section>
        <Card>
          <Row
            title={
              <span className="usage-account">
                <ToknMark size={18} /> @{account.handle}
              </span>
            }
            description="Eaon adds your daily totals to your Tokn profile a few minutes after you use it."
          >
            <div className="usage-account__actions">
              <button className="btn" onClick={() => void window.api.usage.openProfile()}>
                View on Tokn <ExternalLink size={12} strokeWidth={2} />
              </button>
              <button className="btn btn--ghost" onClick={() => void window.api.usage.signOut()}>
                Sign out
              </button>
            </div>
          </Row>
          <Row
            title={sync.state === 'error' ? 'Couldn’t sync' : syncing ? 'Syncing…' : `Synced ${ago(sync.at)}`}
            description={
              sync.state === 'error'
                ? sync.error
                : sync.at
                  ? [
                      sync.rank ? `#${sync.rank} on the Tokn board.` : null,
                      sync.rejected ? `${sync.rejected} ${sync.rejected === 1 ? 'day' : 'days'} of a model Tokn has no price for yet were left out.` : null
                    ]
                      .filter(Boolean)
                      .join(' ') || 'Everything counted is on your profile.'
                  : 'Your first sync starts in a moment.'
            }
          >
            <button className="btn" disabled={syncing} onClick={() => void window.api.usage.sync()}>
              {syncing ? <Loader2 size={13} className="spinner" /> : <RefreshCw size={13} strokeWidth={2} />} Sync now
            </button>
          </Row>
        </Card>
      </Section>

      <Section label="Activity">
        <UsageActivity
          days={summary.calendar}
          activity={summary.activity}
          priced={summary.priced}
          range={range}
          money={money}
          tokens={tokens}
        />
      </Section>

      <div className="usage-toolbar">
        <Segmented value={String(range)} options={RANGES} onChange={onRange} />
      </div>

      <div className="usage-tiles">
        <Tile
          label={`Est. spend · ${range} days`}
          value={money(summary.totals.costUsd)}
          sub={summary.totals.planUsd > 0 ? `Plus ≈ ${money(summary.totals.planUsd)} covered by plans` : 'Pay-per-token, at API rates'}
        />
        <Tile
          label="Today"
          value={money(summary.today.costUsd)}
          sub={summary.today.planUsd > 0 ? `Plus ≈ ${money(summary.today.planUsd)} covered by plans` : undefined}
        />
        <Tile label="Tokens" value={tokens(summary.totals.tokens)} />
        <Tile label="Requests" value={summary.totals.requests.toLocaleString()} />
      </div>

      <Section label="Daily spend">
        <DailyChart days={summary.days} />
      </Section>

      <Section label="By model">
        <ModelTable models={summary.models} />
      </Section>

      {summary.sources.some((row) => row.source !== 'chat') && (
        <Section label="By what it was for">
          <SourceTable sources={summary.sources} />
        </Section>
      )}

      <p className="usage-footnote">
        Spend is estimated at Tokn’s published API rates{summary.priced ? '' : ' (loading)'} for providers that bill per token;
        credits and free tiers aren’t reflected, so a real bill can differ. Use through a subscription (ChatGPT, Copilot, coding
        plans) isn’t charged per token, so it shows as ≈ what it would cost at those rates, never as spend.
        {summary.totals.unpricedRequests > 0 &&
          ` ${summary.totals.unpricedRequests.toLocaleString()} ${summary.totals.unpricedRequests === 1 ? 'request was' : 'requests were'} to models Tokn has no price for yet.`}
        {summary.totals.unreportedRequests > 0 &&
          ` ${summary.totals.unreportedRequests.toLocaleString()} ${summary.totals.unreportedRequests === 1 ? 'request' : 'requests'} came back without token counts from the provider, so ${summary.totals.unreportedRequests === 1 ? 'its' : 'their'} cost isn’t included.`}
      </p>
    </>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="usage-tile">
      <div className="usage-tile__label">{label}</div>
      <div className="usage-tile__value">{value}</div>
      {sub && (
        <div className="usage-tile__sub" title={sub}>
          {sub}
        </div>
      )}
    </div>
  )
}

const dayTotal = (day: UsageDay): number => day.costUsd + (day.planUsd ?? 0)

/**
 * One bar a day: spend, with plan use at API rates stacked on top in a
 * lighter shade (what it would have cost, not a charge), and the day's
 * tokens and requests on hover.
 */
function DailyChart({ days }: { days: UsageDay[] }): JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...days.map(dayTotal), 0)
  const shown = hover !== null ? days[hover] : null
  const busiest = days.reduce<UsageDay | null>((best, d) => (!best || dayTotal(d) > dayTotal(best) ? d : best), null)
  const anyPlan = days.some((d) => (d.planUsd ?? 0) > 0)
  const ticks = useMemo(() => {
    if (days.length === 0) return []
    const at = [0, Math.floor((days.length - 1) / 2), days.length - 1]
    return [...new Set(at)].map((i) => ({ i, label: dayLabel(days[i].day) }))
  }, [days])

  if (max === 0) return <div className="usage-chart usage-chart--empty">No spend or plan use in this range yet.</div>

  return (
    <div className="usage-chart" onPointerLeave={() => setHover(null)}>
      <div className="usage-chart__readout" aria-live="polite">
        {shown ? (
          <>
            <strong>{money(shown.costUsd)}</strong>
            {(shown.planUsd ?? 0) > 0 && <>+ ≈ {money(shown.planUsd!)} on plans </>}
            {dayLabel(shown.day, true)} · {tokens(shown.tokens)} tokens · {shown.requests.toLocaleString()} {shown.requests === 1 ? 'request' : 'requests'}
          </>
        ) : (
          <>
            <strong>{money(busiest?.costUsd ?? 0)}</strong>
            {(busiest?.planUsd ?? 0) > 0 && <>+ ≈ {money(busiest!.planUsd!)} on plans </>}
            busiest day{anyPlan ? ' · lighter: plan use at API rates' : ''}
          </>
        )}
      </div>
      <div className="usage-chart__plot" role="img" aria-label={`Daily spend over ${days.length} days, up to ${money(max)} a day`}>
        {days.map((day, i) => {
          const total = dayTotal(day)
          const height = total > 0 ? Math.max(2, (total / max) * 100) : 0
          return (
            <div key={day.day} className="usage-chart__slot" data-hover={hover === i || undefined} onPointerEnter={() => setHover(i)}>
              <div className="usage-chart__bar" style={{ height: `${height}%` }}>
                {(day.planUsd ?? 0) > 0 && <div className="usage-chart__plan" style={{ height: `${((day.planUsd ?? 0) / total) * 100}%` }} />}
              </div>
            </div>
          )
        })}
      </div>
      <div className="usage-chart__axis">
        {ticks.map((tick) => (
          <span key={tick.i} style={{ left: `${((tick.i + 0.5) / days.length) * 100}%` }}>
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  )
}

const SOURCE_LABEL: Record<UsageSource, string> = {
  chat: 'Chats',
  schedule: 'Scheduled tasks',
  worker: 'Workers',
  trading: 'Trading'
}

/** The range split by what the requests were for: chats, scheduled tasks, workers, trading. */
function SourceTable({ sources }: { sources: UsageSourceRow[] }): JSX.Element {
  return (
    <div className="usage-table" role="table" aria-label="Usage by what it was for">
      <div className="usage-table__row usage-table__row--head" role="row">
        <span role="columnheader">Used by</span>
        <span role="columnheader">Requests</span>
        <span role="columnheader">Tokens</span>
        <span role="columnheader">Cost</span>
      </div>
      {sources.map((row) => (
        <div key={row.source} className="usage-table__row" role="row">
          <span role="cell" className="usage-table__name">
            {SOURCE_LABEL[row.source] ?? row.source}
          </span>
          <span role="cell">{row.requests.toLocaleString()}</span>
          <span role="cell">{tokens(row.tokens)}</span>
          <span
            role="cell"
            className="usage-table__cost"
            title={row.planUsd > 0 ? `Plus ≈ ${money(row.planUsd)} covered by plans, at API rates` : undefined}
          >
            {money(row.costUsd)}
            {row.planUsd > 0 && <span className="usage-table__via"> + ≈ {money(row.planUsd)}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

/** A model's cost cell: what was billed, what a plan covered, or why there is no figure. */
function costText(model: UsageModelRow): string {
  if (model.billing === 'local') return 'Free · local'
  if (model.unreported && model.unreported >= model.requests) return 'Not reported'
  if (model.costUsd === null) return 'No price'
  return model.billing === 'plan' ? `≈ ${money(model.costUsd)} · plan` : money(model.costUsd)
}

function costTitle(model: UsageModelRow): string | undefined {
  const unreported = model.unreported ? ` ${model.unreported} of its requests came back without token counts and aren’t priced.` : ''
  if (model.billing === 'plan') return `Covered by your plan. This is what it would cost at API rates, not a charge.${unreported}`
  if (model.billing === 'local') return 'Runs on this computer: free, and never uploaded.'
  if (model.costUsd === null) return 'Tokn has no price for this model yet.'
  return unreported ? `Estimated at API rates.${unreported}` : 'Estimated at Tokn’s API rates.'
}

function ModelTable({ models }: { models: UsageModelRow[] }): JSX.Element {
  const providers = useApp((s) => s.providers)
  const nameOf = (id: string): string => providers.find((p) => p.id === id)?.name ?? id
  if (models.length === 0) return <div className="usage-chart usage-chart--empty">No requests in this range yet.</div>
  return (
    <div className="usage-table" role="table" aria-label="Usage by model">
      <div className="usage-table__row usage-table__row--head" role="row">
        <span role="columnheader">Model</span>
        <span role="columnheader">Requests</span>
        <span role="columnheader">Tokens</span>
        <span role="columnheader">Cost</span>
      </div>
      {models.map((model) => (
        <div key={`${model.providerId} ${model.modelId}`} className="usage-table__row" role="row">
          <span role="cell" className="usage-table__model">
            <ProviderMark providerId={model.providerId} name={nameOf(model.providerId)} size={14} />
            <span className="usage-table__name" title={model.modelId}>
              {model.modelId}
            </span>
            <span className="usage-table__via">{nameOf(model.providerId)}</span>
          </span>
          <span role="cell">{model.requests.toLocaleString()}</span>
          <span role="cell">{tokens(model.input + model.output + model.cacheRead + model.cacheWrite)}</span>
          <span
            role="cell"
            className="usage-table__cost"
            data-muted={model.costUsd === null || model.billing !== 'api' || undefined}
            title={costTitle(model)}
          >
            {costText(model)}
          </span>
        </div>
      ))}
    </div>
  )
}
