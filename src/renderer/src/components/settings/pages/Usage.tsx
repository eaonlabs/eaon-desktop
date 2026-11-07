import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { monthRange, tokenSplit, type UsageBudget, type UsageBudgetState, type UsageDay, type UsageModelRow, type UsageProjectRow, type UsageSource, type UsageSourceRow, type UsageSpan, type UsageSummary, type UsageToolRow } from '@shared/usage'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Segmented, Select, Switch } from '../../ui'
import { notify } from '../../Notice'
import { ProviderMark } from '../../composer/ProviderMark'
import { UsageActivity } from './UsageActivity'
import { listOf, projectLabel, TOOL_LABEL, TOOL_ORDER, toolMark, toolSplit } from './usageTools'
import { ToknMark } from '../../account/ToknAccount'
import { ToknCommand } from './ToknCommand'

/**
 * Settings → Usage: what Eaon's own model requests cost, day by day and model
 * by model, tracked with Tokn. Eaon counts on this computer from the start;
 * the numbers show here, and upload to the user's Tokn profile, once they
 * sign in with Tokn.
 */

const RANGES: { value: string; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'custom', label: 'Custom' }
]
const RANGE_KEY = 'eaon.usage.range'
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The range shown last time: a preset, or the two days picked by hand. Eaon's main process checks it again. */
function savedSpan(): UsageSpan {
  try {
    const raw = localStorage.getItem(RANGE_KEY) ?? ''
    if (raw.startsWith('{')) {
      const saved = JSON.parse(raw) as { from?: unknown; to?: unknown }
      if (typeof saved.from === 'string' && typeof saved.to === 'string' && DAY.test(saved.from) && DAY.test(saved.to)) return { from: saved.from, to: saved.to }
    }
    const value = Number(raw)
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

function useUsage(span: UsageSpan): { summary: UsageSummary | null; error: string | null; retry: () => void } {
  // A custom range is a new object on every render; what it says is the key.
  const key = JSON.stringify(span)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Only the latest request's answer is kept: switching range quickly could
  // otherwise show the older range's figures if that request finished last.
  const latest = useRef(0)
  const load = useCallback(() => {
    const id = ++latest.current
    window.api.usage.summary(JSON.parse(key) as UsageSpan).then(
      (next) => {
        if (id !== latest.current) return
        setSummary(next)
        setError(null)
      },
      (e: unknown) => {
        if (id !== latest.current) return
        setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      }
    )
  }, [key])
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
  return { summary, error, retry: load }
}

export function UsagePage(): JSX.Element {
  const [span, setSpan] = useState<UsageSpan>(savedSpan)
  const { summary, error, retry } = useUsage(span)

  const setRange = (next: UsageSpan): void => {
    setSpan(next)
    try {
      localStorage.setItem(RANGE_KEY, typeof next === 'number' ? String(next) : JSON.stringify(next))
    } catch {
      /* the default is fine */
    }
  }
  const pickRange = (value: string): void => {
    // Custom starts from this month so far, or from the days last picked.
    if (value === 'custom') setRange(typeof span === 'number' ? monthRange('this') : span)
    else setRange(Number(value) as 7 | 30 | 90)
  }

  return (
    <>
      <h1 className="settings__h1">Usage</h1>
      <p className="settings__lede">
        What your AI use in Eaon costs, model by model and day by day, tracked with Tokn. Sign in with your Tokn account to see
        it here and on your Tokn profile.
      </p>
      {!summary && error ? (
        <Card>
          <Row title="Couldn’t load your usage" description={error}>
            <button className="btn" onClick={retry}>
              Try again
            </button>
          </Row>
        </Card>
      ) : !summary ? null : summary.account ? <SignedIn summary={summary} span={span} onRange={pickRange} onSpan={setRange} /> : <SignedOut summary={summary} />}
      {summary && <ToknCommand signedIn={Boolean(summary.account)} />}
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
              Tokn tracks what AI coding costs across your tools, and your Tokn account is your Eaon account. Signing in shows
              your Eaon usage here and keeps your profile on toknhq.com up to date, with Claude Code, Codex and your other coding
              CLIs counted too (turn that off below). Daily totals only, never your prompts or code.
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
                <input aria-label="Address the browser ended on"
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
          Eaon has counted {summary.totals.requests.toLocaleString()} {summary.totals.requests === 1 ? 'request' : 'requests'}{' '}
          {rangeText(summary)}. They show up here once you sign in.
        </p>
      )}

      <BudgetSection />

      <WhatIsSent />
    </>
  )
}

/** "in the last 30 days", or "from Oct 9 to Nov 7" for a range picked by hand. */
function rangeText(summary: UsageSummary): string {
  return summary.span.custom ? `from ${dayLabel(summary.span.from)} to ${dayLabel(summary.span.to)}` : `in the last ${summary.range} days`
}

function WhatIsSent(): JSX.Element {
  const clis = useApp((s) => s.settings?.toknCli.sync ?? false)
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
        <Row
          title="Daily agent counts"
          description="How many agent runs Eaon made each day, how long they worked and the longest one. Never what they worked on."
        />
        {clis && (
          <Row
            title="The coding CLIs’ daily totals"
            description="From Claude Code, Claude Desktop, Codex, Copilot CLI and opencode’s own logs, through the tokn command: tokens and cost per model per day. Never prompts, code, file or project names."
          />
        )}
        <Row title="Nothing from models on this computer" description="Local models are free, so their requests and tokens stay here and are never uploaded." />
      </Card>
    </Section>
  )
}

function SignedIn({
  summary,
  span,
  onRange,
  onSpan
}: {
  summary: UsageSummary
  span: UsageSpan
  onRange: (value: string) => void
  onSpan: (span: UsageSpan) => void
}): JSX.Element {
  const account = summary.account!
  const range = summary.range
  const custom = summary.span.custom
  const label = custom ? `${dayLabel(summary.span.from)} – ${dayLabel(summary.span.to)}` : `${range} days`
  const { sync } = summary
  const syncing = sync.state === 'syncing'
  const tracksClis = useApp((s) => s.settings?.toknCli.sync ?? false)

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
            description={
              tracksClis
                ? 'Eaon adds its own use to your Tokn profile a few minutes after you use it, and the tokn command adds what the coding CLIs use.'
                : 'Eaon adds your daily totals to your Tokn profile a few minutes after you use it.'
            }
          >
            <div className="usage-account__actions">
              <button className="btn" onClick={() => void window.api.usage.openProfile('profile')}>
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
          agents={summary.agents}
          priced={summary.priced}
          range={range}
          rangeText={custom ? label : undefined}
          money={money}
          tokens={tokens}
          fromTokn={summary.activityFrom.source === 'tokn'}
        />
      </Section>

      <div className="usage-toolbar">
        <Segmented value={typeof span === 'number' ? String(span) : 'custom'} options={RANGES} onChange={onRange} />
        <ExportCsv span={span} />
      </div>
      {typeof span !== 'number' && <CustomRange span={span} onChange={onSpan} />}

      <div className="usage-tiles">
        <Tile
          label={`Est. spend · ${label}`}
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

      <BudgetSection />

      <Section label="Daily use">
        <DailyChart days={summary.chart} reading={summary.cliLogs.reading} />
      </Section>

      {summary.tools.some((row) => row.tool !== 'eaon') && (
        <Section label="By tool">
          <ToolTable tools={summary.tools} />
        </Section>
      )}

      {summary.totals.tokens > 0 && (
        <Section label="Token split">
          <TokenSplitBar models={summary.models} />
        </Section>
      )}

      <Section label="By model">
        <ModelTable models={summary.models} />
      </Section>

      {summary.sources.some((row) => row.source !== 'chat') && (
        <Section label="By what it was for">
          <SourceTable sources={summary.sources} />
        </Section>
      )}

      {summary.projects.some((row) => row.kind !== 'unattributed') && (
        <Section label="By project">
          <ProjectTable projects={summary.projects} />
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
      {summary.cliLogs.found.length > 0 && (
        <p className="usage-footnote">
          {listOf(summary.cliLogs.found.map((tool) => TOOL_LABEL[tool]))} {summary.cliLogs.found.length === 1 ? 'is' : 'are'} read from{' '}
          {summary.cliLogs.found.length === 1 ? 'its' : 'their'} own records on this computer for the daily chart
          {summary.activityFrom.source === 'tokn' ? '' : ', the activity calendar and your streaks'}, as ≈ what the use would cost at API
          rates. The spend and token tiles, the models and what Eaon uploads stay Eaon’s own: the tokn command counts these tools on
          your Tokn profile itself{summary.activityFrom.source === 'tokn' ? ', and the activity calendar and streaks above are that profile’s' : ''}.
        </p>
      )}
      <CursorImportNote imported={summary.cliLogs.cursorImported} />
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
 * One bar a day: what the day's use stands for in dollars (spend, plus plan
 * use at API rates), stacked by tool when Claude Code or Codex were used
 * too, with the day's split, tokens and requests on hover.
 */
function DailyChart({ days, reading }: { days: UsageDay[]; reading: boolean }): JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...days.map(dayTotal), 0)
  const shown = hover !== null ? days[hover] : null
  const busiest = days.reduce<UsageDay | null>((best, d) => (!best || dayTotal(d) > dayTotal(best) ? d : best), null)
  const tools = TOOL_ORDER.filter((tool) => days.some((d) => (d.tools?.[tool]?.usd ?? 0) > 0))
  const stacked = tools.length > 1 || (tools.length === 1 && tools[0] !== 'eaon')
  const ticks = useMemo(() => {
    if (days.length === 0) return []
    const at = [0, Math.floor((days.length - 1) / 2), days.length - 1]
    return [...new Set(at)].map((i) => ({ i, label: dayLabel(days[i].day) }))
  }, [days])

  if (max === 0)
    return (
      <div className="usage-chart usage-chart--empty">
        {reading ? 'Reading Claude Code’s and Codex’s logs…' : 'No spend or plan use in this range yet.'}
      </div>
    )

  const split = shown && toolSplit(shown, money, tokens)
  return (
    <div className="usage-chart" onPointerLeave={() => setHover(null)}>
      <div className="usage-chart__readout" aria-live="polite" title={split || undefined}>
        {shown ? (
          <>
            <strong>{money(dayTotal(shown))}</strong>
            {dayLabel(shown.day, true)} · {split ?? `${tokens(shown.tokens)} tokens`} · {shown.requests.toLocaleString()}{' '}
            {shown.requests === 1 ? 'request' : 'requests'}
          </>
        ) : (
          <>
            <strong>{money(busiest ? dayTotal(busiest) : 0)}</strong>
            busiest day{(busiest?.planUsd ?? 0) > 0 ? ' · plan use counted at API rates' : ''}
          </>
        )}
      </div>
      <div className="usage-chart__plot" role="img" aria-label={`Daily use over ${days.length} days, up to ${money(max)} a day`}>
        {days.map((day, i) => {
          const total = dayTotal(day)
          const height = total > 0 ? Math.max(2, (total / max) * 100) : 0
          return (
            <div key={day.day} className="usage-chart__slot" data-hover={hover === i || undefined} onPointerEnter={() => setHover(i)}>
              <div className="usage-chart__bar" data-stacked={stacked || undefined} style={{ height: `${height}%` }}>
                {stacked &&
                  tools.map((tool) => {
                    const usd = day.tools?.[tool]?.usd ?? 0
                    return usd > 0 ? <div key={tool} className="usage-chart__seg" data-tool={tool} style={{ height: `${(usd / total) * 100}%` }} /> : null
                  })}
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
      {stacked && (
        <div className="usage-chart__legend">
          {tools.map((tool) => (
            <span key={tool}>
              <i data-tool={tool} />
              {TOOL_LABEL[tool]}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Cursor keeps no token counts on this computer, so its usage comes from the
 * CSV its dashboard exports. Importing a newer export adds only what's new.
 */
function CursorImportNote({ imported }: { imported: number }): JSX.Element {
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pick = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.usage.importCursor()
      if (result) {
        setNote(
          result.error ??
            (result.added > 0
              ? `Added ${result.added.toLocaleString()} ${result.added === 1 ? 'request' : 'requests'}.`
              : 'Nothing new: every request in it was already imported.')
        )
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <p className="usage-footnote usage-cursor">
      <ProviderMark providerId="cli:cursor" name="Cursor" size={14} />
      <span>
        {imported > 0
          ? `${imported.toLocaleString()} Cursor ${imported === 1 ? 'request' : 'requests'} imported.`
          : 'Cursor keeps no usage on this computer: export it from cursor.com/dashboard → Usage → Export CSV.'}
        {note ? ` ${note}` : ''}
      </span>
      <button type="button" className="btn btn--ghost usage-cursor__import" disabled={busy} onClick={() => void pick()}>
        {busy ? 'Importing…' : imported > 0 ? 'Import a newer export…' : 'Import CSV…'}
      </button>
    </p>
  )
}

/** The range by tool: Eaon itself, and the coding CLIs from their own records. */
function ToolTable({ tools: rows }: { tools: UsageToolRow[] }): JSX.Element {
  return (
    <div className="usage-table" role="table" aria-label="Usage by tool">
      <div className="usage-table__row usage-table__row--head" role="row">
        <span role="columnheader">Tool</span>
        <span role="columnheader">Requests</span>
        <span role="columnheader">Tokens</span>
        <span role="columnheader">Cost</span>
      </div>
      {rows.map((row) => (
        <div key={row.tool} className="usage-table__row" role="row">
          <span role="cell" className="usage-table__model">
            <i className="usage-tool-dot" data-tool={row.tool} aria-hidden="true" />
            <ProviderMark providerId={toolMark(row.tool)} name={TOOL_LABEL[row.tool]} size={14} />
            <span className="usage-table__name">{TOOL_LABEL[row.tool]}</span>
          </span>
          <span role="cell">{row.requests.toLocaleString()}</span>
          <span role="cell">{tokens(row.tokens)}</span>
          <span
            role="cell"
            className="usage-table__cost"
            title={row.planUsd > 0 ? `≈ ${money(row.planUsd)} at API rates, covered by a plan or not billed per token` : undefined}
          >
            {row.costUsd > 0 || row.planUsd === 0 ? money(row.costUsd) : null}
            {row.planUsd > 0 && <span className="usage-table__via">{row.costUsd > 0 ? ' + ' : ''}≈ {money(row.planUsd)}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

const SOURCE_LABEL: Record<UsageSource, string> = {
  chat: 'Chats',
  schedule: 'Scheduled tasks',
  worker: 'Workers',
  trading: 'Trading',
  gateway: 'Other apps through Eaon'
}

/** The range split by what the requests were for: chats, scheduled tasks, workers, trading. */
function SourceTable({ sources }: { sources: UsageSourceRow[] }): JSX.Element {
  const [own, other] = [sources.filter((row) => row.source !== 'gateway'), sources.filter((row) => row.source === 'gateway')]
  return (
    <>
      <SourceRows rows={own} />
      {other.length > 0 && (
        <>
          <SourceRows rows={other} muted />
          <p className="usage-footnote">
            Requests the Local API Server and Connect apps make on other apps’ behalf use your keys, so they are shown here, but
            they aren’t in the totals above and aren’t uploaded to Tokn: Tokn counts them as those apps’ own use.
          </p>
        </>
      )}
    </>
  )
}

function SourceRows({ rows: sources, muted = false }: { rows: UsageSourceRow[]; muted?: boolean }): JSX.Element | null {
  if (sources.length === 0) return null
  return (
    <div className="usage-table" role="table" aria-label={muted ? 'Usage by other apps' : 'Usage by what it was for'} style={muted ? { marginTop: 10 } : undefined}>
      {!muted && (
        <div className="usage-table__row usage-table__row--head" role="row">
          <span role="columnheader">Used by</span>
          <span role="columnheader">Requests</span>
          <span role="columnheader">Tokens</span>
          <span role="columnheader">Cost</span>
        </div>
      )}
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
  const nameOf = (id: string): string => providers.find((p) => p.id === id)?.name ?? (id.startsWith('codex') ? 'Codex' : id)
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
          <span role="cell" title={splitText(model)}>
            {tokens(model.input + model.output + model.cacheRead + model.cacheWrite)}
          </span>
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

/** "Input 1.2M · Output 300k · Cache read 10M · Cache write 500k", leaving out what is zero. */
function splitText(counts: Pick<UsageModelRow, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h'>): string {
  const split = tokenSplit([counts])
  return [
    ['Input', split.input],
    ['Output', split.output],
    ['Cache read', split.cacheRead],
    ['Cache write', split.cacheWrite]
  ]
    .filter(([, n]) => (n as number) > 0)
    .map(([name, n]) => `${name} ${tokens(n as number)}`)
    .join(' · ')
}

const SPLIT_PARTS: { key: 'input' | 'output' | 'cacheRead' | 'cacheWrite'; label: string }[] = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheWrite', label: 'Cache write' }
]

/**
 * The range's tokens as uncached input, output, cache reads and cache writes,
 * with how much of the prompt came from the cache. From the counts the
 * ledger already keeps for the models above, so it adds up to the Tokens tile.
 */
function TokenSplitBar({ models }: { models: UsageModelRow[] }): JSX.Element {
  const split = useMemo(() => tokenSplit(models), [models])
  return (
    <div className="usage-split">
      <div className="usage-split__bar" role="img" aria-label={`Tokens: ${SPLIT_PARTS.map((part) => `${part.label} ${tokens(split[part.key])}`).join(', ')}`}>
        {SPLIT_PARTS.map((part) =>
          split[part.key] > 0 ? <div key={part.key} className="usage-split__seg" data-part={part.key} style={{ flexGrow: split[part.key] }} /> : null
        )}
      </div>
      <div className="usage-split__legend">
        {SPLIT_PARTS.map((part) => (
          <span key={part.key} title={`${split[part.key].toLocaleString()} tokens`}>
            <i data-part={part.key} />
            {part.label} <strong>{tokens(split[part.key])}</strong>
            {split.total > 0 && <em>{Math.round((split[part.key] / split.total) * 100)}%</em>}
          </span>
        ))}
      </div>
      <p className="usage-footnote">
        {split.cacheHitRate === null
          ? 'No prompts in this range.'
          : `${Math.round(split.cacheHitRate * 100)}% of prompt tokens were cache reads (cache reads out of uncached input, cache reads and cache writes). A model that doesn’t report its cache shows none.`}
      </p>
    </div>
  )
}

/** Saves what is on the page for this range as a CSV, where the person chooses. */
function ExportCsv({ span }: { span: UsageSpan }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await window.api.usage.exportCsv(span)
      if (saved) notify(`Saved usage to ${saved.path}`)
    } catch (e) {
      notify(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      className="btn btn--ghost"
      disabled={busy}
      title="Daily use and the tool, model, source and project tables for this range, as one CSV"
      onClick={() => void save()}
    >
      <Download size={13} strokeWidth={2} /> Export CSV
    </button>
  )
}

const todayDay = (): string => {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The two days of a custom range, and this month and last month in one click. Eaon keeps about 400 days. */
function CustomRange({ span, onChange }: { span: { from: string; to: string }; onChange: (span: UsageSpan) => void }): JSX.Element {
  const max = todayDay()
  const oldest = (() => {
    const at = new Date()
    at.setDate(at.getDate() - 399)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  })()
  const change = (edge: 'from' | 'to', value: string): void => {
    // A cleared or half-typed date reads as empty: keep the last good one.
    if (!DAY.test(value)) return
    const next = { ...span, [edge]: value }
    // The other end follows rather than leaving an empty range.
    if (next.from > next.to) next[edge === 'from' ? 'to' : 'from'] = value
    onChange(next)
  }
  return (
    <div className="usage-range">
      <label>
        From
        <input type="date" className="input" value={span.from} min={oldest} max={max} onChange={(e) => change('from', e.target.value)} />
      </label>
      <label>
        To
        <input type="date" className="input" value={span.to} min={oldest} max={max} onChange={(e) => change('to', e.target.value)} />
      </label>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(monthRange('this'))}>
        This month
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(monthRange('last'))}>
        Last month
      </button>
    </div>
  )
}

/** The range split by project folder. Eaon began noting folders in this version; see the footnote. */
function ProjectTable({ projects }: { projects: UsageProjectRow[] }): JSX.Element {
  return (
    <>
      <div className="usage-table" role="table" aria-label="Usage by project">
        <div className="usage-table__row usage-table__row--head" role="row">
          <span role="columnheader">Project</span>
          <span role="columnheader">Requests</span>
          <span role="columnheader">Tokens</span>
          <span role="columnheader">Cost</span>
        </div>
        {projects.map((row) => {
          const { name, title } = projectLabel(row)
          return (
            <div key={`${row.kind} ${row.path}`} className="usage-table__row" role="row">
              <span role="cell" className="usage-table__name" title={title} data-muted={row.kind !== 'folder' || undefined}>
                {name}
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
          )
        })}
      </div>
      <p className="usage-footnote">
        A project is the folder a chat or task worked in. Eaon began noting it in this version, so older requests, and ones made
        outside a chat or a task (a chat’s title), show as Unattributed. Claude Code’s and Codex’s own logs aren’t split by project here.
      </p>
    </>
  )
}

const UNIT_DEFAULT: Record<UsageBudget['unit'], number> = { usd: 50, tokens: 10_000_000 }
const WARN_OPTIONS = [50, 70, 80, 90, 95].map((n) => ({ value: String(n), label: `${n}%` }))

/**
 * A monthly budget for pay-per-token models: Eaon warns at a percent of it
 * and, if asked, stops sending pay-per-token requests at the limit, saying so
 * in the chat or app that asked. Estimates at Tokn’s rates, never a provider’s
 * own limit.
 */
function BudgetSection(): JSX.Element | null {
  const [state, setState] = useState<UsageBudgetState | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => void window.api.usage.budget().then((next) => alive && setState(next), () => {})
    load()
    const stop = window.api.usage.onChanged(load)
    return () => {
      alive = false
      stop()
    }
  }, [])
  const { unit, limit } = state?.budget ?? { unit: 'usd' as const, limit: 0 }
  // The saved limit is what the field shows; typing is a draft until Enter or leaving it.
  useEffect(() => setDraft(unit === 'usd' ? String(limit) : String(limit / 1e6)), [unit, limit])
  if (!state) return null

  const { budget } = state
  const save = (patch: Partial<UsageBudget>): void => {
    void window.api.usage.setBudget(patch).then(setState, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const commit = (): void => {
    const value = Number(draft.trim())
    if (!Number.isFinite(value) || value <= 0) {
      setError(budget.unit === 'usd' ? 'Enter a dollar amount above zero.' : 'Enter a number of million tokens above zero.')
      setDraft(budget.unit === 'usd' ? String(budget.limit) : String(budget.limit / 1e6))
      return
    }
    setError(null)
    const next = budget.unit === 'usd' ? Math.round(value * 100) / 100 : Math.round(value * 1e6)
    if (next !== budget.limit) save({ limit: next })
  }
  const amount = (n: number): string => (budget.unit === 'usd' ? money(n) : `${tokens(n)} tokens`)
  const month = new Date(`${state.month}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <Section label="Monthly budget">
      <Card>
        <Row
          title="Budget for pay-per-token models"
          description="Counts what you spend through your own API keys each calendar month. Plans, models on this computer and Eaon Lite never count."
        >
          <Switch label="Budget for pay-per-token models" checked={budget.enabled} onChange={(on) => save({ enabled: on })} />
        </Row>
        {budget.enabled && (
          <>
            <div className="usage-meter" data-level={state.level}>
              <div className="usage-meter__bar" role="progressbar" aria-label="Budget used this month" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(state.percent))}>
                <div style={{ width: `${Math.min(100, state.percent)}%` }} />
              </div>
              <div className="usage-meter__text">
                <strong>{amount(state.spent)}</strong> of {amount(budget.limit)} in {month} · {Math.floor(state.percent)}%
                {state.blocked && ' · pay-per-token requests are stopped'}
                {state.level === 'over' && !state.blocked && ' · over the limit, requests still go through'}
                {state.level === 'warn' && ' · past the warning'}
              </div>
            </div>
            <Row title="Count in" description={budget.unit === 'usd' ? 'Dollars, at Tokn’s published API rates.' : 'Every token sent or received on a pay-per-token model.'}>
              <Segmented
                value={budget.unit}
                options={[
                  { value: 'usd', label: 'Dollars' },
                  { value: 'tokens', label: 'Tokens' }
                ]}
                onChange={(next) => next !== budget.unit && save({ unit: next, limit: UNIT_DEFAULT[next] })}
              />
            </Row>
            <Row
              title="Monthly limit"
              description={
                error ? (
                  <span className="field-error" role="alert">
                    {error}
                  </span>
                ) : budget.unit === 'usd' ? (
                  'In dollars. It starts over on the first of each month.'
                ) : (
                  'In millions of tokens. It starts over on the first of each month.'
                )
              }
            >
              <input
                className="input"
                style={{ width: 120 }}
                type="number"
                min={0}
                step={budget.unit === 'usd' ? 1 : 1}
                aria-label="Monthly limit"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => e.key === 'Enter' && commit()}
              />
            </Row>
            <Row title="Warn at" description="A notification when this month’s use reaches this share of the limit, and another at the limit. Once each.">
              <Select
                value={String(budget.warnAt)}
                options={WARN_OPTIONS.some((o) => o.value === String(budget.warnAt)) ? WARN_OPTIONS : [...WARN_OPTIONS, { value: String(budget.warnAt), label: `${budget.warnAt}%` }]}
                width={96}
                onChange={(value) => save({ warnAt: Number(value) })}
              />
            </Row>
            <Row
              title="At the limit"
              description={
                budget.hardCap
                  ? 'Eaon stops sending requests to models you pay per token and says why, in the chat or the app that asked. Models on a plan or on this computer keep working.'
                  : 'Only warn: requests keep going.'
              }
            >
              <Segmented
                value={budget.hardCap ? 'stop' : 'warn'}
                options={[
                  { value: 'warn', label: 'Only warn' },
                  { value: 'stop', label: 'Stop requests' }
                ]}
                onChange={(next) => save({ hardCap: next === 'stop' })}
              />
            </Row>
          </>
        )}
      </Card>
      {budget.enabled && (
        <p className="usage-footnote">
          An estimate from what Eaon counted, at Tokn’s published rates: a provider’s own bill can differ, and a request already
          running when the limit is reached finishes, so use can pass it a little. It includes other apps that use your keys
          through the Local API Server. Runs on Codex or Claude with an API key are counted but can’t be stopped here.
          {!state.priced && budget.unit === 'usd' && ' Tokn’s prices haven’t loaded yet, so the dollar figure reads low until they do.'}
          {state.uncounted > 0 &&
            ` ${state.uncounted.toLocaleString()} ${state.uncounted === 1 ? 'request' : 'requests'} this month had no price or no token counts and ${state.uncounted === 1 ? 'isn’t' : 'aren’t'} in the figure.`}
        </p>
      )}
    </Section>
  )
}
