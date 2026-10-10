import { Fragment, useEffect, useMemo, useState, type JSX } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus, OctagonX, Play, RefreshCw, Shield, TriangleAlert } from 'lucide-react'
import { BROKERS, type EquityPoint, type PositionExit, type TradingPosition, type TradingSnapshot } from '@shared/trading'
import { TopBar } from '../TopBar'
import { Segmented } from '../ui'
import { AgentDesk } from './AgentDesk'
import { EquityChart } from './EquityChart'
import { TradingSessions } from './TradingSessions'
import { TradingSetup } from './TradingSetup'
import { TradeTicket } from './TradeTicket'
import { clock, dayAndTime, direction, qty, signedPct, signedUsd, span, usd, useNow, useTrading } from './tradingStore'

/**
 * The trading desk: what the account is worth and how it got there, the
 * agent at work (the user's Claude Code in a pane, or Eaon's own agent) with
 * when it starts and stops and how often it decides, what it holds and has
 * traded and why, and the limits it trades within. Everything here is a view
 * of main's trading engine (features/trading); while a session runs, main
 * refreshes it every few seconds.
 */

type Range = 'live' | '1d' | '1w' | '1m' | 'all'

const RANGES: { value: Range; label: string; ms: number }[] = [
  { value: 'live', label: 'Live', ms: Infinity },
  { value: '1d', label: '1D', ms: 24 * 60 * 60_000 },
  { value: '1w', label: '1W', ms: 7 * 24 * 60 * 60_000 },
  { value: '1m', label: '1M', ms: 31 * 24 * 60 * 60_000 },
  { value: 'all', label: 'All', ms: Infinity }
]

export function TradingDesk(): JSX.Element {
  const { snapshot, error, init, run } = useTrading()
  const [picked, setPicked] = useState<Range | null>(null)
  const [asTable, setAsTable] = useState(false)
  const hasLive = (snapshot?.live?.length ?? 0) >= 2
  // While a session runs the chart follows it live, unless the user picked a range.
  const range: Range = picked && (picked !== 'live' || hasLive) ? picked : hasLive && snapshot?.activeSession ? 'live' : '1w'

  useEffect(() => {
    void init()
  }, [init])

  // Main refreshes every 30 s while the desk is on screen, every 5 min otherwise.
  useEffect(() => {
    void window.api.trading.setDeskOpen(true)
    return () => void window.api.trading.setDeskOpen(false)
  }, [])

  const points = useMemo(() => {
    if (!snapshot) return []
    if (range === 'live') return snapshot.live ?? []
    const width = RANGES.find((r) => r.value === range)!.ms
    const from = Date.now() - width
    return snapshot.equity.filter((p) => p.at >= from)
  }, [snapshot, range])

  if (!snapshot) {
    return (
      <div className="page">
        <TopBar variant="page__bar" />
        <div className="page__scroll scroll">
          <div className="page__inner page__inner--wide">{error ? <p className="tr-error">{error}</p> : <p className="tr-muted">Loading the desk…</p>}</div>
        </div>
      </div>
    )
  }

  const { config, account, stats } = snapshot
  const broker = BROKERS.find((b) => b.id === config.broker)!

  return (
    <div className="page trading">
      <TopBar
        variant="page__bar"
        right={
          <div className="chat-header__actions">
            <button className="header-btn" onClick={() => void run(() => window.api.trading.refresh())} title="Fetch the latest prices and account">
              <RefreshCw size={14} strokeWidth={1.9} />
              <span>Refresh</span>
            </button>
            <button
              className="header-btn tr-halt"
              data-on={config.halted || undefined}
              onClick={() => void run(() => window.api.trading.setConfig({ halted: !config.halted }))}
              title={config.halted ? 'Let the agent trade again' : 'Stop all trading now: no orders, no sessions, until you switch it back on'}
            >
              {config.halted ? <Play size={14} strokeWidth={1.9} /> : <OctagonX size={14} strokeWidth={1.9} />}
              <span>{config.halted ? 'Resume trading' : 'Stop all trading'}</span>
            </button>
          </div>
        }
      />
      <div className="page__scroll scroll">
        <div className="page__inner page__inner--wide tr-desk">
          {(error || snapshot.error) && (
            <div className="tr-alert" role="alert">
              <TriangleAlert size={15} strokeWidth={2} />
              <span>{error ?? snapshot.error}</span>
            </div>
          )}
          {config.halted && (
            <div className="tr-alert tr-alert--halt" role="status">
              <OctagonX size={15} strokeWidth={2} />
              <span>Trading is stopped. No orders go out and no session starts until you resume it.</span>
            </div>
          )}

          <Hero snapshot={snapshot} />

          <AgentDesk snapshot={snapshot} />

          <section className="tr-panel">
            <div className="tr-panel__head">
              <h2 className="tr-h2">Account value</h2>
              <div className="tr-panel__tools">
                <Segmented value={range} options={RANGES.filter((r) => r.value !== 'live' || hasLive).map(({ value, label }) => ({ value, label }))} onChange={setPicked} />
                <button className="btn btn--sm btn--ghost" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
                  {asTable ? 'Chart' : 'Table'}
                </button>
              </div>
            </div>
            <EquityChart asTable={asTable} points={points} baseline={rangeStart(points, range === 'live' ? (snapshot.activeSession?.startEquity ?? null) : (account?.startingEquity ?? null), range)} />
            <p className="tr-footnote">
              {broker.label} · {snapshot.dataSource}
              {account ? ` · updated ${clock(account.updatedAt)}` : ''}
              {range === 'live' ? ' · a point every few seconds while the session runs' : ''}
            </p>
          </section>

          <section className="tr-kpis" aria-label="Statistics">
            <Kpi label="Total return" value={signedUsd(stats.totalReturn)} delta={stats.totalReturnPct} />
            <Kpi label="Realised P&L" value={signedUsd(stats.realizedPl)} note={`${signedUsd(stats.unrealizedPl)} open`} />
            <Kpi label="Win rate" value={stats.trades ? `${Math.round(stats.winRate * 100)}%` : '—'} note={`${stats.wins} won · ${stats.losses} lost`} />
            <Kpi label="Profit factor" value={stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2)} note="Gains ÷ losses" />
            <Kpi label="Max drawdown" value={stats.maxDrawdownPct ? `−${stats.maxDrawdownPct.toFixed(2)}%` : '0%'} note="Deepest fall from a peak" />
            <Kpi label="Sharpe ratio" value={stats.sharpe === null ? '—' : stats.sharpe.toFixed(2)} note={stats.sharpe === null ? 'Needs 5 days' : 'Annualised'} />
            <Kpi label="Trades" value={String(stats.trades)} note={`${stats.ordersToday} orders today`} />
            <Kpi label="Invested" value={`${Math.round(stats.investedPct)}%`} note={account ? `${usd(account.cash, true)} cash` : undefined} />
          </section>

          <div className="tr-grid">
            <section className="tr-panel">
              <div className="tr-panel__head">
                <h2 className="tr-h2">Holdings</h2>
                <span className="tr-muted">{snapshot.positions.length || 'None'}</span>
              </div>
              <Positions snapshot={snapshot} />
            </section>
            <TradeTicket snapshot={snapshot} />
          </div>

          <section className="tr-panel">
            <div className="tr-panel__head">
              <h2 className="tr-h2">Trades</h2>
              <span className="tr-muted">Newest first, with the reason each was placed</span>
            </div>
            <Orders snapshot={snapshot} />
          </section>

          <TradingSessions snapshot={snapshot} />

          <div id="tr-setup">
            <TradingSetup snapshot={snapshot} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** The baseline for the chart: the value at the start of the range shown (or where tracking began, for All). */
function rangeStart(points: EquityPoint[], starting: number | null, range: Range): number | null {
  if (range === 'all' || range === 'live') return starting ?? points[0]?.equity ?? null
  return points[0]?.equity ?? null
}

function Delta({ value, pct, size = 'md' }: { value: number; pct: number; size?: 'md' | 'lg' }): JSX.Element {
  const dir = direction(value)
  const Icon = dir === 'up' ? ArrowUpRight : dir === 'down' ? ArrowDownRight : Minus
  return (
    <span className="tr-delta" data-dir={dir} data-size={size}>
      <Icon size={size === 'lg' ? 16 : 13} strokeWidth={2.2} aria-hidden="true" />
      {signedUsd(value)} ({signedPct(pct)})
    </span>
  )
}

function Hero({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const { account, stats, config } = snapshot
  const broker = BROKERS.find((b) => b.id === config.broker)!
  const market = account
    ? account.marketOpen
      ? `Market open${account.nextClose ? ` · closes ${clock(account.nextClose)}` : ''}`
      : `Market closed${account.nextOpen ? ` · opens ${dayAndTime(account.nextOpen)}` : ''}`
    : 'Connecting to the broker…'
  return (
    <section className="tr-hero">
      <div className="tr-hero__top">
        <span className="tr-broker" data-real={broker.real || undefined}>
          {broker.real && <TriangleAlert size={12} strokeWidth={2.2} />}
          {broker.real ? 'Real money · ' : ''}
          {broker.label}
        </span>
        <span className="tr-market" data-open={account?.marketOpen || undefined}>
          <span className="tr-market__dot" aria-hidden="true" />
          {market}
        </span>
        {snapshot.activeSession && account && <LiveAge at={account.updatedAt} />}
      </div>
      <div className="tr-hero__value">{account ? usd(account.equity) : '—'}</div>
      <div className="tr-hero__deltas">
        <span>
          <Delta value={stats.todayReturn} pct={stats.todayReturnPct} size="lg" /> <span className="tr-muted">today</span>
        </span>
        <span>
          <Delta value={stats.totalReturn} pct={stats.totalReturnPct} /> <span className="tr-muted">since {account ? usd(account.startingEquity, true) : 'start'}</span>
        </span>
      </div>
    </section>
  )
}

/** "Live · 2s ago": how fresh the numbers are while a session runs (main refreshes every few seconds). */
function LiveAge({ at }: { at: number }): JSX.Element {
  const now = useNow()
  return (
    <span className="tr-liveage" title="Refreshed every few seconds while a session runs">
      <span className="tr-liveage__dot" aria-hidden="true" />
      Live · {span(now - at)} ago
    </span>
  )
}

function Kpi({ label, value, delta, note }: { label: string; value: string; delta?: number; note?: string }): JSX.Element {
  return (
    <div className="tr-kpi">
      <span className="tr-kpi__label">{label}</span>
      <span className="tr-kpi__value">{value}</span>
      {delta !== undefined ? (
        <span className="tr-kpi__note tr-delta" data-dir={direction(delta)}>
          {signedPct(delta)}
        </span>
      ) : (
        note && <span className="tr-kpi__note">{note}</span>
      )}
    </div>
  )
}

function Positions({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const run = useTrading((s) => s.run)
  const [editing, setEditing] = useState<string | null>(null)
  if (snapshot.positions.length === 0) {
    return <p className="tr-empty">No holdings. Start the agent above, ask Eaon from a chat, or place an order yourself.</p>
  }
  return (
    <table className="tr-table">
      <thead>
        <tr>
          <th>Stock</th>
          <th className="num">Shares</th>
          <th className="num">Price</th>
          <th className="num">Value</th>
          <th className="num">Gain</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {snapshot.positions.map((p) => (
          <Fragment key={p.symbol}>
            <tr>
              <td>
                <span className="tr-symbol">{p.symbol}</span>
                <span className="tr-exit" data-none={p.exit ? undefined : true}>
                  {p.exit
                    ? exitParts(p.exit).map((part, i) => (
                        <Fragment key={part}>
                          {i > 0 && ' · '}
                          <span>{part}</span>
                        </Fragment>
                      ))
                    : 'No stop'}
                </span>
              </td>
              <td className="num">{qty(p.qty)}</td>
              <td className="num">{usd(p.price)}</td>
              <td className="num">{usd(p.marketValue)}</td>
              <td className="num">
                <span className="tr-delta" data-dir={direction(p.unrealizedPl)}>
                  {signedUsd(p.unrealizedPl)}
                  <span className="tr-muted"> {signedPct(p.unrealizedPlPct)}</span>
                </span>
              </td>
              <td className="tr-row-action">
                <button
                  className="icon-btn"
                  aria-expanded={editing === p.symbol}
                  aria-label={`${p.exit ? 'Change' : 'Set'} the stop-loss, take-profit or trailing stop on ${p.symbol}`}
                  title={p.exit ? 'Change protection' : 'Protect with a stop'}
                  onClick={() => setEditing(editing === p.symbol ? null : p.symbol)}
                >
                  <Shield size={14} strokeWidth={1.9} />
                </button>
                <button className="btn btn--sm btn--ghost" onClick={() => void run(() => window.api.trading.closePosition(p.symbol))} title={`Sell all ${p.symbol}`}>
                  Sell all
                </button>
              </td>
            </tr>
            {editing === p.symbol && (
              <tr className="tr-exit-row">
                <td colSpan={6}>
                  <ExitEditor position={p} onDone={() => setEditing(null)} />
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}

/**
 * "Stop $310.00", "Trail 5% ($312.00)", "Target $360.00": what Eaon will sell
 * at. Separate parts, so a narrow table wraps between them, not inside one.
 */
function exitParts(exit: PositionExit): string[] {
  const parts: string[] = []
  if (exit.stopPrice !== null) parts.push(`Stop ${usd(exit.stopPrice)}`)
  if (exit.trailPct !== null) parts.push(`Trail ${exit.trailPct}%${exit.activeStop !== null ? ` (${usd(exit.activeStop)})` : ''}`)
  if (exit.targetPrice !== null) parts.push(`Target ${usd(exit.targetPrice)}`)
  return parts
}

/**
 * Sets the exit Eaon watches on a holding. Empty fields clear that part; the
 * engine checks a stop is below the price and a target above it.
 */
function ExitEditor({ position, onDone }: { position: TradingPosition; onDone: () => void }): JSX.Element {
  const run = useTrading((s) => s.run)
  const exit = position.exit
  const [stop, setStop] = useState(exit?.stopPrice?.toString() ?? '')
  const [target, setTarget] = useState(exit?.targetPrice?.toString() ?? '')
  const [trail, setTrail] = useState(exit?.trailPct?.toString() ?? '')
  const value = (text: string): number | null => (text.trim() === '' ? null : Number(text))
  const save = async (clear = false): Promise<void> => {
    const done = await run(() =>
      window.api.trading.setExit(
        clear
          ? { symbol: position.symbol, stopPrice: null, targetPrice: null, trailPct: null }
          : { symbol: position.symbol, stopPrice: value(stop), targetPrice: value(target), trailPct: value(trail) }
      )
    )
    if (done) onDone()
  }
  return (
    <form
      className="tr-exit-editor"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label>
        <span className="tr-muted">Stop-loss</span>
        <input className="input" type="number" min={0} step="any" value={stop} placeholder="$" onChange={(e) => setStop(e.target.value)} />
      </label>
      <label>
        <span className="tr-muted">Take-profit</span>
        <input className="input" type="number" min={0} step="any" value={target} placeholder="$" onChange={(e) => setTarget(e.target.value)} />
      </label>
      <label>
        <span className="tr-muted">Trailing stop</span>
        <input className="input" type="number" min={0} step="any" value={trail} placeholder="%" onChange={(e) => setTrail(e.target.value)} />
      </label>
      <div className="tr-exit-editor__actions">
        <button className="btn btn--sm btn--primary" type="submit">
          Save
        </button>
        {exit && (
          <button className="btn btn--sm btn--ghost" type="button" onClick={() => void save(true)}>
            Remove
          </button>
        )}
        <button className="btn btn--sm btn--ghost" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      <p className="tr-muted tr-exit-editor__note">Eaon sells the whole holding at market when the price reaches one of these, while Eaon is running.</p>
    </form>
  )
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  open: 'Open',
  filled: 'Filled',
  partially_filled: 'Part filled',
  canceled: 'Canceled',
  rejected: 'Refused',
  expired: 'Expired'
}

const SOURCE_LABEL = { user: 'You', agent: 'Eaon', session: 'Session' }

/** Who placed an order: Claude Code's carry its name at the start of the reason. */
function sourceOf(order: { source: keyof typeof SOURCE_LABEL; reason: string }): string {
  return order.reason.startsWith('Claude Code: ') ? 'Claude' : SOURCE_LABEL[order.source]
}

function Orders({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const run = useTrading((s) => s.run)
  const [all, setAll] = useState(false)
  if (snapshot.orders.length === 0) return <p className="tr-empty">No trades yet.</p>
  const shown = all ? snapshot.orders : snapshot.orders.slice(0, 12)
  return (
    <>
      <table className="tr-table tr-orders">
        <thead>
          <tr>
            <th>When</th>
            <th>Order</th>
            <th className="num">Price</th>
            <th className="num">P&amp;L</th>
            <th>Status</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((o) => (
            <tr key={o.id} data-status={o.status}>
              <td className="tr-nowrap">{dayAndTime(o.filledAt ?? o.submittedAt)}</td>
              <td className="tr-nowrap">
                <span className="tr-side" data-side={o.side}>
                  {o.side === 'buy' ? 'Buy' : 'Sell'}
                </span>{' '}
                {qty(o.filledQty || o.qty)} <span className="tr-symbol">{o.symbol}</span>
                {o.type === 'limit' && o.limitPrice !== null && <span className="tr-muted"> @ {usd(o.limitPrice)}</span>}
              </td>
              <td className="num">{o.filledAvgPrice !== null ? usd(o.filledAvgPrice) : '—'}</td>
              <td className="num">
                {o.realizedPl !== null ? (
                  <span className="tr-delta" data-dir={direction(o.realizedPl)}>
                    {signedUsd(o.realizedPl)}
                  </span>
                ) : (
                  <span className="tr-muted">—</span>
                )}
              </td>
              <td className="tr-nowrap">
                <span className="tr-status" data-status={o.status}>
                  {STATUS_LABEL[o.status] ?? o.status}
                </span>
                {(o.status === 'open' || o.status === 'pending') && (
                  <button className="btn btn--sm btn--ghost" onClick={() => void run(() => window.api.trading.cancelOrder(o.id))}>
                    Cancel
                  </button>
                )}
              </td>
              <td className="tr-why">
                <span className="tr-source">{sourceOf(o)}</span> {o.error ? <span className="tr-refused">{o.error}</span> : o.reason.replace(/^Claude Code: /, '')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {snapshot.orders.length > 12 && (
        <button className="btn btn--sm btn--ghost tr-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${snapshot.orders.length}`}
        </button>
      )}
    </>
  )
}
