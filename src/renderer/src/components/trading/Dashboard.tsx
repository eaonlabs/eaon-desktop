import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type PointerEvent } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { brokerInfo, type Bar, type EquityPoint, type Quote, type TradingSnapshot } from '@shared/trading'
import { Segmented } from '../ui'
import { EquityChart } from './EquityChart'
import { clock, dayAndTime, direction, signedPct, signedUsd, span, usd, usdCompact, useNow } from './tradingStore'

/**
 * The trading dashboard's own panels: the status strip across the top, the
 * account card, the market chart (the account's value, or a stock's candles)
 * and the analytics. Quiet by design — Eaon's surfaces and type, figures in
 * the monospace face, and red and green only where something went up or
 * down, always with a sign or an arrow.
 */

/* --------------------------------------------------------------- the strip */

const INDEXES = ['SPY', 'QQQ']

/** Quotes for a few symbols, refreshed every 15 s while on screen. */
function useQuotes(symbols: string[]): Record<string, Quote> {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const key = symbols.join(',')
  useEffect(() => {
    let alive = true
    const load = (): void => {
      for (const symbol of key.split(',').filter(Boolean))
        window.api.trading.quote(symbol).then(
          (q) => alive && setQuotes((all) => ({ ...all, [symbol]: q })),
          () => {}
        )
    }
    load()
    const timer = window.setInterval(load, 15_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [key])
  return quotes
}

function Change({ value, pct }: { value?: number; pct: number }): JSX.Element {
  const dir = direction(pct)
  const Icon = dir === 'up' ? ArrowUpRight : dir === 'down' ? ArrowDownRight : Minus
  return (
    <span className="tr-delta" data-dir={dir}>
      <Icon size={12} strokeWidth={2.4} aria-hidden="true" />
      {value !== undefined ? `${signedUsd(value)} ` : ''}
      {signedPct(pct)}
    </span>
  )
}

/** One line across the desk: whether the agent is trading, the account, the session, the market. */
export function Strip({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const now = useNow()
  const quotes = useQuotes(INDEXES)
  const { account, stats, activeSession: session, agent, config } = snapshot
  const broker = brokerInfo(config.broker)
  const state = config.halted ? 'halted' : session ? 'live' : 'idle'
  const sessionChange = session && account ? account.equity - session.startEquity : null
  return (
    <div className="tr-strip" role="status" aria-label="Trading status">
      <span className="tr-strip__state" data-state={state}>
        <span className="tr-strip__dot" aria-hidden="true" />
        {state === 'halted' ? 'Stopped' : state === 'live' ? 'Live' : 'Idle'}
      </span>
      <span className="tr-strip__item">
        <span className="tr-strip__key">{broker.label}</span>
        <span className="tr-num">{account ? usd(account.equity) : '—'}</span>
        <Change value={stats.todayReturn} pct={stats.todayReturnPct} />
      </span>
      {session && (
        <span className="tr-strip__item">
          <span className="tr-strip__key">Session</span>
          {sessionChange !== null && <Change value={sessionChange} pct={session.startEquity ? (sessionChange / session.startEquity) * 100 : 0} />}
          <span className="tr-muted tr-num">
            {session.checks} checks · {agent?.checking ? 'deciding' : agent?.nextCheckAt ? `next ${span(Math.max(0, agent.nextCheckAt - now))}` : 'waiting'} · {span(session.endsAt - now)} left
          </span>
        </span>
      )}
      <span className="tr-strip__spacer" />
      {INDEXES.map((symbol) =>
        quotes[symbol] ? (
          <span key={symbol} className="tr-strip__item">
            <span className="tr-strip__key">{symbol}</span>
            <span className="tr-num">{quotes[symbol].price.toFixed(2)}</span>
            <Change pct={quotes[symbol].changePct} />
          </span>
        ) : null
      )}
      <span className="tr-strip__item tr-muted">
        {account ? (account.marketOpen ? `Open · closes ${clock(account.nextClose ?? now)}` : `Closed · opens ${account.nextOpen ? dayAndTime(account.nextOpen) : '—'}`) : 'Connecting…'}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------ account card */

export function AccountCard({ snapshot, onAccounts }: { snapshot: TradingSnapshot; onAccounts: () => void }): JSX.Element {
  const { account, stats, config } = snapshot
  const broker = brokerInfo(config.broker)
  const badge = broker.real ? 'Live' : broker.id === 'simulator' ? 'Sim' : 'Paper'
  return (
    <section className="tr-panel tr-acct" aria-label="Account">
      <div className="tr-panel__head">
        <h2 className="tr-label-head">Account</h2>
        <button className="btn btn--sm btn--ghost" onClick={onAccounts}>
          Accounts
        </button>
      </div>
      <div className="tr-acct__name">
        {broker.label}
        <span className="tr-acct__badge" data-real={broker.real || undefined}>
          {badge}
        </span>
      </div>
      <div className="tr-acct__value tr-num">{account ? usd(account.equity) : '—'}</div>
      <div className="tr-acct__sub">
        <Change value={stats.todayReturn} pct={stats.todayReturnPct} />
        <span className="tr-muted">today</span>
      </div>
      {snapshot.error && !account && <p className="tr-error">{snapshot.error}</p>}
      <dl className="tr-acct__stats">
        <div>
          <dt>Total</dt>
          <dd>
            <span className="tr-delta" data-dir={direction(stats.totalReturn)}>
              {signedPct(stats.totalReturnPct)}
            </span>
          </dd>
        </div>
        <div>
          <dt>Trades</dt>
          <dd>{stats.trades}</dd>
        </div>
        <div>
          <dt>Win rate</dt>
          <dd>{stats.trades ? `${Math.round(stats.winRate * 100)}%` : '—'}</dd>
        </div>
        <div>
          <dt>Profit factor</dt>
          <dd>{stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Drawdown</dt>
          <dd>{stats.maxDrawdownPct ? `−${stats.maxDrawdownPct.toFixed(2)}%` : '0%'}</dd>
        </div>
        <div>
          <dt>Invested</dt>
          <dd>{Math.round(stats.investedPct)}%</dd>
        </div>
        <div>
          <dt>Cash</dt>
          <dd>{account ? usdCompact(account.cash) : '—'}</dd>
        </div>
        <div>
          <dt>Buying power</dt>
          <dd>{account ? usdCompact(account.buyingPower) : '—'}</dd>
        </div>
      </dl>
    </section>
  )
}

/* ------------------------------------------------------------- market chart */

type Range = 'live' | '1d' | '1w' | '1m' | 'all'
const RANGES: { value: Range; label: string; ms: number }[] = [
  { value: 'live', label: 'Live', ms: Infinity },
  { value: '1d', label: '1D', ms: 24 * 60 * 60_000 },
  { value: '1w', label: '1W', ms: 7 * 24 * 60 * 60_000 },
  { value: '1m', label: '1M', ms: 31 * 24 * 60 * 60_000 },
  { value: 'all', label: 'All', ms: Infinity }
]

/**
 * The account's value, or one stock's candles: the stocks it holds and the
 * ones the session watches each get a tab.
 */
export function MarketPanel({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const [tab, setTab] = useState<string>('account')
  const [picked, setPicked] = useState<Range | null>(null)
  const [asTable, setAsTable] = useState(false)
  const symbols = useMemo(
    () => [...new Set([...snapshot.positions.map((p) => p.symbol), ...(snapshot.agent?.watching ?? []).filter((s) => !INDEXES.includes(s)), 'SPY'])].slice(0, 8),
    [snapshot.positions, snapshot.agent?.watching]
  )
  const symbol = tab !== 'account' && symbols.includes(tab) ? tab : null
  const hasLive = (snapshot.live?.length ?? 0) >= 2
  const range: Range = picked && (picked !== 'live' || hasLive) ? picked : hasLive && snapshot.activeSession ? 'live' : '1w'
  const points: EquityPoint[] = useMemo(() => {
    if (range === 'live') return snapshot.live ?? []
    const from = Date.now() - RANGES.find((r) => r.value === range)!.ms
    return snapshot.equity.filter((p) => p.at >= from)
  }, [snapshot.equity, snapshot.live, range])
  const baseline = range === 'live' ? (snapshot.activeSession?.startEquity ?? points[0]?.equity ?? null) : range === 'all' ? (snapshot.account?.startingEquity ?? points[0]?.equity ?? null) : (points[0]?.equity ?? null)

  return (
    <section className="tr-panel tr-chartpanel" aria-label="Chart">
      <div className="tr-panel__head">
        <div className="tr-tabs" role="tablist" aria-label="What to chart">
          {['account', ...symbols].map((t) => (
            <button key={t} role="tab" aria-selected={(symbol ?? 'account') === t} className="tr-tab" onClick={() => setTab(t)}>
              {t === 'account' ? 'Account' : t}
            </button>
          ))}
        </div>
        {!symbol && (
          <div className="tr-panel__tools">
            <Segmented value={range} options={RANGES.filter((r) => r.value !== 'live' || hasLive).map(({ value, label }) => ({ value, label }))} onChange={setPicked} />
            <button className="btn btn--sm btn--ghost" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
              {asTable ? 'Chart' : 'Table'}
            </button>
          </div>
        )}
      </div>
      {symbol ? <Candles symbol={symbol} snapshot={snapshot} /> : <EquityChart points={points} baseline={baseline} asTable={asTable} />}
    </section>
  )
}

/** A stock's day in five-minute candles, refreshed every 15 s, with its last price tagged. */
function Candles({ symbol, snapshot }: { symbol: string; snapshot: TradingSnapshot }): JSX.Element {
  const [bars, setBars] = useState<Bar[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setBars(null)
    const load = (): void => {
      window.api.trading.bars(symbol, '1d').then(
        (b) => {
          if (!alive) return
          setBars(b)
          setError(null)
        },
        (e) => alive && setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
      )
    }
    load()
    const timer = window.setInterval(load, 15_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [symbol])
  const held = snapshot.positions.find((p) => p.symbol === symbol)
  const last = bars?.[bars.length - 1]
  const first = bars?.[0]
  return (
    <div className="tr-candles">
      <div className="tr-candles__head">
        <span className="tr-candles__symbol">{symbol}</span>
        {last && <span className="tr-candles__price tr-num">{usd(last.c)}</span>}
        {last && first && <Change value={last.c - first.o} pct={((last.c - first.o) / first.o) * 100} />}
        {held && (
          <span className="tr-muted tr-num">
            holding {held.qty} @ {usd(held.avgPrice)}
            {held.exit?.activeStop ? ` · stop ${usd(held.exit.activeStop)}` : ''}
          </span>
        )}
      </div>
      {error ? (
        <p className="tr-error">{error}</p>
      ) : !bars ? (
        <p className="tr-empty">Loading {symbol}…</p>
      ) : bars.length < 2 ? (
        <p className="tr-empty">No trading in {symbol} today yet.</p>
      ) : (
        <CandleChart bars={bars} stop={held?.exit?.activeStop ?? null} entry={held?.avgPrice ?? null} />
      )}
    </div>
  )
}

const CANDLE_H = 240
const CPAD = { top: 12, right: 72, bottom: 22, left: 4 }

function CandleChart({ bars, stop, entry }: { bars: Bar[]; stop: number | null; entry: number | null }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState<number | null>(null)
  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    const observer = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const shown = bars.slice(-Math.max(20, Math.floor((width - CPAD.left - CPAD.right) / 5)))
  const lows = shown.map((b) => b.l).concat(stop ?? [], entry ?? [])
  const highs = shown.map((b) => b.h).concat(stop ?? [], entry ?? [])
  let lo = Math.min(...lows)
  let hi = Math.max(...highs)
  const pad = (hi - lo || hi * 0.01) * 0.06
  lo -= pad
  hi += pad
  const plotW = width - CPAD.left - CPAD.right
  const plotH = CANDLE_H - CPAD.top - CPAD.bottom
  const step = plotW / shown.length
  const x = (i: number): number => CPAD.left + step * (i + 0.5)
  const y = (v: number): number => CPAD.top + (1 - (v - lo) / (hi - lo)) * plotH
  const body = Math.max(1, Math.min(9, step * 0.62))
  const last = shown[shown.length - 1]
  const point = hover !== null ? shown[hover] : null
  const ticks = [lo + (hi - lo) * 0.15, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.85]
  const onMove = (e: PointerEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    setHover(Math.min(shown.length - 1, Math.max(0, Math.floor((e.clientX - rect.left - CPAD.left) / step))))
  }
  return (
    <div ref={box} className="tr-candles__chart">
      <svg width={width} height={CANDLE_H} role="img" aria-label={`Five-minute candles, last ${usd(last.c)}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="eq-chart__grid" x1={CPAD.left} x2={width - CPAD.right} y1={y(t)} y2={y(t)} />
            <text className="eq-chart__tick" x={width - CPAD.right + 8} y={y(t)} dy="0.32em">
              {t.toFixed(2)}
            </text>
          </g>
        ))}
        {entry !== null && <Level y={y(entry)} x1={CPAD.left} x2={width - CPAD.right} label={`entry ${entry.toFixed(2)}`} kind="entry" />}
        {stop !== null && <Level y={y(stop)} x1={CPAD.left} x2={width - CPAD.right} label={`stop ${stop.toFixed(2)}`} kind="stop" />}
        {shown.map((b, i) => {
          const up = b.c >= b.o
          return (
            <g key={b.t} className="tr-candle" data-dir={up ? 'up' : 'down'} opacity={hover !== null && hover !== i ? 0.55 : 1}>
              <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} />
              <rect x={x(i) - body / 2} width={body} y={y(Math.max(b.o, b.c))} height={Math.max(1, Math.abs(y(b.o) - y(b.c)))} rx={0.5} />
            </g>
          )
        })}
        <line className="tr-candles__last" x1={CPAD.left} x2={width - CPAD.right} y1={y(last.c)} y2={y(last.c)} />
        <g transform={`translate(${width - CPAD.right + 2}, ${y(last.c)})`}>
          <rect className="tr-candles__tag" x={0} y={-9} width={CPAD.right - 4} height={18} rx={4} />
          <text className="tr-candles__tag-text" x={(CPAD.right - 4) / 2} y={0} dy="0.34em" textAnchor="middle">
            {last.c.toFixed(2)}
          </text>
        </g>
        <text className="eq-chart__tick" x={CPAD.left} y={CANDLE_H - 6}>
          {clock(shown[0].t)}
        </text>
        <text className="eq-chart__tick" x={width - CPAD.right} y={CANDLE_H - 6} textAnchor="end">
          {clock(last.t)}
        </text>
      </svg>
      {point && (
        <div className="tr-candles__readout tr-num">
          {clock(point.t)} · O {point.o.toFixed(2)} · H {point.h.toFixed(2)} · L {point.l.toFixed(2)} · C {point.c.toFixed(2)}
        </div>
      )}
    </div>
  )
}

function Level({ y, x1, x2, label, kind }: { y: number; x1: number; x2: number; label: string; kind: 'stop' | 'entry' }): JSX.Element {
  return (
    <g className="tr-level" data-kind={kind}>
      <line x1={x1} x2={x2} y1={y} y2={y} />
      <text x={x1 + 4} y={y - 4}>
        {label}
      </text>
    </g>
  )
}

/* --------------------------------------------------------------- analytics */

/** Small bar charts of what the account has done: each trade's result, each day's change, where the money sits. */
export function Analytics({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const trades = useMemo(
    () =>
      snapshot.orders
        .filter((o) => o.realizedPl !== null)
        .slice(0, 40)
        .reverse()
        .map((o) => ({ label: `${o.symbol} ${dayAndTime(o.filledAt ?? o.submittedAt)}`, value: o.realizedPl! })),
    [snapshot.orders]
  )
  const days = useMemo(() => dailyChanges(snapshot.equity).slice(-30), [snapshot.equity])
  const exposure = snapshot.positions.map((p) => ({ label: p.symbol, value: p.marketValue }))
  const sum = (list: { value: number }[]): number => list.reduce((s, v) => s + v.value, 0)
  return (
    <section className="tr-panel tr-analytics" aria-label="Analytics">
      <div className="tr-panel__head">
        <h2 className="tr-label-head">Analytics</h2>
      </div>
      <div className="tr-analytics__grid">
        <MiniBars title="P&L per trade" bars={trades} total={trades.length ? signedUsd(sum(trades)) : '—'} signed empty="No closed trades yet" />
        <MiniBars title="Daily change" bars={days} total={days.length ? signedUsd(sum(days)) : '—'} signed empty="Needs a day of history" />
        <MiniBars title="Holdings" bars={exposure} total={exposure.length ? usdCompact(sum(exposure)) : '—'} labels empty="Nothing held" />
      </div>
    </section>
  )
}

/** The change in equity from each day's last point to the next day's. */
function dailyChanges(points: EquityPoint[]): { label: string; value: number }[] {
  const closes = new Map<string, EquityPoint>()
  for (const p of points) closes.set(new Date(p.at).toDateString(), p)
  const list = [...closes.values()]
  const out: { label: string; value: number }[] = []
  for (let i = 1; i < list.length; i++) out.push({ label: new Date(list[i].at).toLocaleDateString([], { month: 'short', day: 'numeric' }), value: list[i].equity - list[i - 1].equity })
  return out
}

function MiniBars({ title, bars, total, signed = false, labels = false, empty }: { title: string; bars: { label: string; value: number }[]; total: string; signed?: boolean; labels?: boolean; empty: string }): JSX.Element {
  const max = Math.max(1e-9, ...bars.map((b) => Math.abs(b.value)))
  const H = 56
  const zero = signed ? H / 2 : H
  // A fixed number of slots, newest on the right, so a few bars stay bars rather than stretching across.
  const slots = Math.max(bars.length, 24)
  const offset = slots - bars.length
  return (
    <figure className="tr-mini">
      <figcaption>
        <span className="tr-mini__title">{title}</span>
        <span className="tr-mini__total tr-num">{total}</span>
      </figcaption>
      {bars.length === 0 ? (
        <p className="tr-mini__empty">{empty}</p>
      ) : (
        <svg viewBox={`0 0 ${slots * 6} ${H}`} preserveAspectRatio="none" className="tr-mini__svg" role="img" aria-label={`${title}: ${bars.map((b) => `${b.label} ${signed ? signedUsd(b.value) : usd(b.value)}`).join(', ')}`}>
          {signed && <line x1={0} x2={slots * 6} y1={zero} y2={zero} className="tr-mini__zero" />}
          {bars.map((b, i) => {
            const h = (Math.abs(b.value) / max) * (signed ? H / 2 - 1 : H - 1)
            return (
              <rect key={i} x={(offset + i) * 6 + 1} width={4} y={b.value >= 0 ? zero - h : zero} height={Math.max(0.5, h)} data-dir={signed ? direction(b.value) : 'flat'}>
                <title>{`${b.label}: ${signed ? signedUsd(b.value) : usd(b.value)}`}</title>
              </rect>
            )
          })}
        </svg>
      )}
      {labels && bars.length > 0 && (
        <div className="tr-mini__labels">
          {bars.map((b) => (
            <span key={b.label}>
              {b.label} <span className="tr-num">{usdCompact(b.value)}</span>
            </span>
          ))}
        </div>
      )}
    </figure>
  )
}

export { Change }
