import { Fragment, useEffect, useState, type JSX } from 'react'
import { OctagonX, Play, RefreshCw, Shield, TriangleAlert } from 'lucide-react'
import type { PositionExit, SessionDriver, TradingPosition, TradingSnapshot } from '@shared/trading'
import { TopBar } from '../TopBar'
import { AccountsModal } from './Accounts'
import { armedPlan, ClaudePane, ExecutionLog, MissionControl } from './AgentDesk'
import { AccountCard, Analytics, MarketPanel, Strip } from './Dashboard'
import { TradingSessions } from './TradingSessions'
import { TradingSetup } from './TradingSetup'
import { TradeTicket } from './TradeTicket'
import { dayAndTime, direction, qty, signedPct, signedUsd, usd, useTrading } from './tradingStore'

/**
 * The Trading tab: a dashboard over main's trading engine. Across the top,
 * whether the agent is trading and how the account and the market are doing;
 * then the account, the chart, and the agent itself — the user's Claude Code
 * in a pane, or Eaon's own agent — with what it is told to do, what it holds
 * and every step it takes, live; below, the trades, schedules and limits.
 * While a session runs, main refreshes the account every few seconds.
 */
export function TradingDesk(): JSX.Element {
  const { snapshot, error, init, run } = useTrading()
  const [accounts, setAccounts] = useState(false)
  const [driverPick, setDriver] = useState<SessionDriver>('claude-code')

  useEffect(() => {
    void init()
  }, [init])

  // Main refreshes every few seconds while the desk is on screen and a session runs.
  useEffect(() => {
    void window.api.trading.setDeskOpen(true)
    return () => void window.api.trading.setDeskOpen(false)
  }, [])

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

  const { config } = snapshot
  const plan = armedPlan(snapshot)
  const driver = snapshot.activeSession?.driver ?? plan?.driver ?? driverPick
  const claude = driver === 'claude-code'

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
          {error && (
            <div className="tr-alert" role="alert">
              <TriangleAlert size={15} strokeWidth={2} />
              <span>{error}</span>
            </div>
          )}
          {config.halted && (
            <div className="tr-alert tr-alert--halt" role="status">
              <OctagonX size={15} strokeWidth={2} />
              <span>Trading is stopped. No orders go out and no session starts until you resume it.</span>
            </div>
          )}

          <div className="tr-dash" data-claude={claude || undefined}>
            <Strip snapshot={snapshot} />
            <div className="tr-dash__account">
              <AccountCard snapshot={snapshot} onAccounts={() => setAccounts(true)} />
            </div>
            <div className="tr-dash__chart">
              <MarketPanel snapshot={snapshot} />
            </div>
            {claude && (
              <div className="tr-dash__claude">
                <ClaudePane snapshot={snapshot} />
              </div>
            )}
            <div className="tr-dash__mission">
              <MissionControl snapshot={snapshot} driver={driver} setDriver={setDriver} plan={plan} />
            </div>
            <div className="tr-dash__positions">
              <section className="tr-panel" aria-label="Holdings">
                <div className="tr-panel__head">
                  <h2 className="tr-label-head">Holdings</h2>
                  <span className="tr-muted tr-num">{snapshot.positions.length || ''}</span>
                </div>
                <Positions snapshot={snapshot} />
              </section>
            </div>
            <div className="tr-dash__log">
              <ExecutionLog snapshot={snapshot} />
            </div>
            <div className="tr-dash__analytics">
              <Analytics snapshot={snapshot} />
            </div>
          </div>

          <section className="tr-panel">
            <div className="tr-panel__head">
              <h2 className="tr-label-head">Trades</h2>
              <span className="tr-muted">Newest first, with the reason each was placed</span>
            </div>
            <Orders snapshot={snapshot} />
          </section>

          <div className="tr-grid">
            <TradingSessions snapshot={snapshot} />
            <TradeTicket snapshot={snapshot} />
          </div>

          <TradingSetup snapshot={snapshot} />
        </div>
      </div>
      <AccountsModal snapshot={snapshot} open={accounts} onClose={() => setAccounts(false)} />
    </div>
  )
}

function Positions({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const run = useTrading((s) => s.run)
  const [editing, setEditing] = useState<string | null>(null)
  if (snapshot.positions.length === 0) {
    return <p className="tr-empty">Nothing held. The agent’s buys show up here with their stops.</p>
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
