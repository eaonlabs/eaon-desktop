import { useEffect, useId, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronDown, ChevronUp, RotateCw, TrendingDown, TrendingUp } from 'lucide-react'
import type { Bar, BarRange, Quote, StockHeadline } from '@shared/trading'
import { normalizeUi, STOCK_RANGES, type ChartStyle, type StockRange, type UiBlock, type UiSeries } from '@shared/workerUi'
import { Markdown } from '../agent/Markdown'
import { Actions } from './WorkerCards'

/**
 * A card a worker laid out itself (show_ui, shared/workerUi.ts): blocks drawn
 * in the cards' own style. What moves is Eaon's — tabs, a chart's views and
 * its readout under the pointer, a sortable table, a stock's live price and
 * ranges — so a worker gets a small app's worth of card without any of its
 * text ever running.
 */
export function UiCard({ input }: { input: Record<string, unknown> }): JSX.Element | null {
  const result = useMemo(() => normalizeUi(input), [input])
  if ('error' in result) return null
  const { ui } = result
  return (
    <article className="wcard wui" data-kind="ui">
      {(ui.title || ui.subtitle) && (
        <header className="wui__head">
          {ui.title && <span className="wcard__title">{ui.title}</span>}
          {ui.subtitle && <span className="wui__subtitle">{ui.subtitle}</span>}
        </header>
      )}
      <Blocks blocks={ui.blocks} slot="b" />
    </article>
  )
}

function Blocks({ blocks, slot }: { blocks: UiBlock[]; slot: string }): JSX.Element {
  return (
    <>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} slot={`${slot}${i}`} />
      ))}
    </>
  )
}

function BlockView({ block, slot }: { block: UiBlock; slot: string }): JSX.Element {
  switch (block.type) {
    case 'heading':
      return (
        <div className="wui-heading">
          <span className="wui-heading__text">{block.text}</span>
          {block.detail && <span className="wui-heading__detail">{block.detail}</span>}
        </div>
      )
    case 'text':
      return (
        <div className="wui-text">
          <Markdown text={block.text} />
        </div>
      )
    case 'stats':
      return (
        <div className="wstats" style={{ ['--n' as string]: Math.min(block.items.length, 3) }}>
          {block.items.map((item, i) => (
            <div key={i} className="wstat">
              <span className="wstat__label">{item.label}</span>
              <span className="wstat__value">{item.value}</span>
              {item.change && (
                <span className="wui-change" data-tone={item.tone ?? 'neutral'}>
                  {item.tone === 'up' ? <TrendingUp size={12} strokeWidth={2} /> : item.tone === 'down' ? <TrendingDown size={12} strokeWidth={2} /> : null}
                  {item.change}
                </span>
              )}
            </div>
          ))}
        </div>
      )
    case 'chart':
      return <ChartBlock style={block.style} unit={block.unit} views={block.views} />
    case 'stock':
      return <StockBlock symbol={block.symbol} range={block.range} news={block.news} />
    case 'table':
      return <TableBlock columns={block.columns} rows={block.rows} />
    case 'list':
      return (
        <ul className="wui-list">
          {block.items.map((item, i) => (
            <li key={i} className="wui-list__row">
              <span className="wui-list__text">
                <span className="wui-list__title">{item.title}</span>
                {item.detail && <span className="wui-list__detail">{item.detail}</span>}
              </span>
              {item.value && (
                <span className="wui-list__value" data-tone={item.tone}>
                  {item.value}
                </span>
              )}
            </li>
          ))}
        </ul>
      )
    case 'progress': {
      const percent = Math.round((block.value / block.max) * 100)
      return (
        <div className="wmeter wui-progress" data-tone={block.tone}>
          <span className="wmeter__head">
            <span>{block.label}</span>
            <span className="wmeter__value">{block.detail ?? `${percent}%`}</span>
          </span>
          <span className="wmeter__track" role="meter" aria-valuemin={0} aria-valuemax={block.max} aria-valuenow={block.value} aria-label={block.label}>
            <span className="wmeter__fill" style={{ width: `${percent}%` }} />
          </span>
        </div>
      )
    }
    case 'badges':
      return (
        <div className="wui-badges">
          {block.items.map((item, i) => (
            <span key={i} className="wui-badge" data-tone={item.tone ?? 'neutral'}>
              {item.label}
            </span>
          ))}
        </div>
      )
    case 'tabs':
      return <TabsBlock tabs={block.tabs} slot={slot} />
    case 'buttons':
      return <Actions actions={block.actions} slot={slot} />
    case 'divider':
      return <hr className="wui-divider" />
  }
}

/** Two to six labels to choose between, as one quiet pill: tabs, a chart's views, a stock's ranges. */
function Segments({ labels, value, onChange, label }: { labels: string[]; value: number; onChange: (index: number) => void; label: string }): JSX.Element {
  return (
    <div className="wui-segments" role="tablist" aria-label={label}>
      {labels.map((text, i) => (
        <button key={i} type="button" role="tab" aria-selected={i === value} className="wui-segment" data-on={i === value || undefined} onClick={() => onChange(i)}>
          {text}
        </button>
      ))}
    </div>
  )
}

function TabsBlock({ tabs, slot }: { tabs: { label: string; blocks: UiBlock[] }[]; slot: string }): JSX.Element {
  const [at, setAt] = useState(0)
  return (
    <div className="wui-tabs">
      <Segments labels={tabs.map((t) => t.label)} value={at} onChange={setAt} label="Sections" />
      <div className="wui-tabs__panel" role="tabpanel">
        <Blocks blocks={tabs[at]?.blocks ?? []} slot={`${slot}t${at}-`} />
      </div>
    </div>
  )
}

function ChartBlock({ style, unit, views }: { style: ChartStyle; unit?: string; views: { label: string; series: UiSeries[] }[] }): JSX.Element {
  const [at, setAt] = useState(0)
  const view = views[at] ?? views[0]
  return (
    <div className="wui-chart">
      {views.length > 1 && <Segments labels={views.map((v) => v.label)} value={at} onChange={setAt} label="Chart" />}
      <Plot
        style={style}
        labels={view.series[0].points.map((p) => p.x)}
        series={view.series.map((s) => ({ name: s.name, values: s.points.map((p) => p.y) }))}
        format={(n) => `${formatNumber(n)}${unit ? ` ${unit}` : ''}`}
      />
      {view.series.length > 1 && (
        <div className="wui-legend">
          {view.series.map((s, i) => (
            <span key={i} className="wui-legend__item" style={{ ['--c' as string]: PALETTE[i % PALETTE.length] }}>
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

const PALETTE = ['var(--wui-c1)', 'var(--wui-c2)', 'var(--wui-c3)', 'var(--wui-c4)']

/**
 * A chart in SVG, as wide as the card: lines, an area under one, or bars.
 * Under the pointer (or the arrow keys) a readout names the point and every
 * series' value there.
 */
function Plot({
  style,
  labels,
  series,
  format,
  color,
  baseline
}: {
  style: ChartStyle
  labels: string[]
  series: { name: string; values: number[] }[]
  format: (n: number) => string
  /** One colour for every series (a stock's green or red). */
  color?: string
  /** A level to mark with a dashed line (a stock's previous close). */
  baseline?: number
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  // Its own: a second chart on the page with the same gradient id would be filled with the first one's.
  const fill = `wui-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [width, setWidth] = useState(400)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const node = box.current
    if (!node) return
    const measure = (): void => setWidth(Math.max(160, Math.round(node.clientWidth)))
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(node)
    return () => watch.disconnect()
  }, [])
  const height = 150
  const pad = { top: 10, bottom: 18, left: 2, right: 2 }
  const count = Math.max(...series.map((s) => s.values.length))
  const values = series.flatMap((s) => s.values)
  // A previous close far outside the day (a 14% gap) would squash the day into a line at the top: it's left out then.
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const mark = baseline !== undefined && baseline >= lo - (hi - lo) && baseline <= hi + (hi - lo) ? baseline : undefined
  const all = values.concat(mark !== undefined ? [mark] : [])
  let min = Math.min(...all)
  let max = Math.max(...all)
  if (style === 'bar') min = Math.min(0, min)
  if (min === max) {
    min -= 1
    max += 1
  }
  const span = max - min
  min -= style === 'bar' ? 0 : span * 0.08
  max += span * 0.08
  const x = (i: number): number => pad.left + (count <= 1 ? 0 : (i / (count - 1)) * (width - pad.left - pad.right))
  const y = (v: number): number => pad.top + (1 - (v - min) / (max - min)) * (height - pad.top - pad.bottom)
  const slot = (width - pad.left - pad.right) / Math.max(count, 1)

  const pick = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const at = ((event.clientX - rect.left) / rect.width) * width
    const i = style === 'bar' ? Math.floor((at - pad.left) / slot) : Math.round(((at - pad.left) / (width - pad.left - pad.right)) * (count - 1))
    setHover(Math.max(0, Math.min(count - 1, i)))
  }
  const shown = hover ?? count - 1
  const colorOf = (i: number): string => color ?? PALETTE[i % PALETTE.length]

  return (
    <div className="wui-plot" ref={box}>
      <div className="wui-readout" aria-live="polite">
        <span className="wui-readout__x">{labels[shown] ?? ''}</span>
        {series.map((s, i) => (
          <span key={i} className="wui-readout__v" style={{ ['--c' as string]: colorOf(i) }}>
            {series.length > 1 && <span className="wui-readout__dot" />}
            {s.values[shown] !== undefined ? format(s.values[shown]) : '–'}
          </span>
        ))}
      </div>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${series.map((s) => s.name).join(', ')}: from ${format(series[0].values[0])} to ${format(series[0].values[series[0].values.length - 1])}`}
        tabIndex={0}
        onPointerMove={pick}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setHover(Math.max(0, shown - 1))
          else if (e.key === 'ArrowRight') setHover(Math.min(count - 1, shown + 1))
        }}
      >
        <defs>
          {series.map((_, i) => (
            <linearGradient key={i} id={`${fill}-${i}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" style={{ stopColor: colorOf(i), stopOpacity: 0.26 }} />
              <stop offset="100%" style={{ stopColor: colorOf(i), stopOpacity: 0 }} />
            </linearGradient>
          ))}
        </defs>
        {mark !== undefined && <line className="wui-plot__base" x1={pad.left} x2={width - pad.right} y1={y(mark)} y2={y(mark)} />}
        {style === 'bar'
          ? series.map((s, si) =>
              s.values.map((v, i) => {
                const w = Math.max(2, (slot * 0.7) / series.length)
                const left = pad.left + i * slot + slot * 0.15 + si * w
                return (
                  <rect
                    key={`${si}-${i}`}
                    x={left}
                    y={Math.min(y(v), y(0))}
                    width={w}
                    height={Math.max(1, Math.abs(y(0) - y(v)))}
                    rx={Math.min(3, w / 2)}
                    style={{ fill: colorOf(si), opacity: hover === null || hover === i ? 1 : 0.45 }}
                  />
                )
              })
            )
          : series.map((s, si) => {
              const line = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
              return (
                <g key={si}>
                  {style === 'area' && si === 0 && (
                    <path d={`${line}L${x(s.values.length - 1).toFixed(1)},${height - pad.bottom}L${x(0).toFixed(1)},${height - pad.bottom}Z`} style={{ fill: `url(#${fill}-${si})` }} />
                  )}
                  <path d={line} className="wui-plot__line" style={{ stroke: colorOf(si) }} />
                </g>
              )
            })}
        {hover !== null && style !== 'bar' && (
          <g>
            <line className="wui-plot__cursor" x1={x(hover)} x2={x(hover)} y1={pad.top} y2={height - pad.bottom} />
            {series.map((s, si) =>
              s.values[hover] !== undefined ? <circle key={si} cx={x(hover)} cy={y(s.values[hover])} r={3.5} className="wui-plot__dot" style={{ fill: colorOf(si) }} /> : null
            )}
          </g>
        )}
        <text className="wui-plot__label" x={pad.left} y={height - 4}>
          {labels[0]}
        </text>
        <text className="wui-plot__label" x={width - pad.right} y={height - 4} textAnchor="end">
          {labels[count - 1]}
        </text>
      </svg>
    </div>
  )
}

/** A table the user can sort by any column; numbers sort as numbers. */
function TableBlock({ columns, rows }: { columns: string[]; rows: string[][] }): JSX.Element {
  const [sort, setSort] = useState<{ column: number; up: boolean } | null>(null)
  const sorted = useMemo(() => {
    if (!sort) return rows
    const value = (cell: string): number | string => {
      const n = Number(cell.replace(/[,$%\s+]/g, '').replace(/^−/, '-'))
      return cell.trim() && Number.isFinite(n) ? n : cell.toLowerCase()
    }
    return [...rows].sort((a, b) => {
      const [p, q] = [value(a[sort.column] ?? ''), value(b[sort.column] ?? '')]
      const order = typeof p === 'number' && typeof q === 'number' ? p - q : String(p).localeCompare(String(q))
      return sort.up ? order : -order
    })
  }, [rows, sort])
  return (
    <div className="wui-table">
      <table>
        <thead>
          <tr>
            {columns.map((column, i) => (
              <th key={i} aria-sort={sort?.column === i ? (sort.up ? 'ascending' : 'descending') : 'none'}>
                <button type="button" onClick={() => setSort(sort?.column === i ? { column: i, up: !sort.up } : { column: i, up: true })}>
                  {column}
                  {sort?.column === i && (sort.up ? <ChevronUp size={12} strokeWidth={2.2} /> : <ChevronDown size={12} strokeWidth={2.2} />)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ stocks */

/**
 * The stocks a worker looked up (chat/workLog.ts, `stocks`), each live on a
 * card of its own: the price, today's move and a chart over the range it
 * looked at, whatever the worker wrote about them.
 */
export function StockCards({ symbols, range }: { symbols: string[]; range: string }): JSX.Element {
  const first = (STOCK_RANGES as string[]).includes(range) ? (range as StockRange) : '1d'
  return (
    <>
      {symbols.map((symbol) => (
        <article key={symbol} className="wcard wui" data-kind="ui">
          <StockBlock symbol={symbol} range={first} news={symbols.length === 1} />
        </article>
      ))}
    </>
  )
}

const RANGE_LABEL: Record<StockRange, string> = { '1d': '1D', '5d': '5D', '1mo': '1M', '6mo': '6M', '1y': '1Y' }
/** How often a stock card on screen asks again: its price, and its day's bars. */
const QUOTE_EVERY_MS = 30_000
const BARS_EVERY_MS = 60_000

/**
 * A stock, live: its price and today's move, a chart over the range the user
 * picks (fetched as they pick it), the day's range and volume, and with
 * `news`, its latest headlines. Prices come from the same free feed as the
 * Trading tab (main/features/trading/marketData.ts).
 */
function StockBlock({ symbol, range: first, news }: { symbol: string; range: StockRange; news: boolean }): JSX.Element {
  const [range, setRange] = useState<StockRange>(first)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [bars, setBars] = useState<Partial<Record<StockRange, Bar[]>>>({})
  const [headlines, setHeadlines] = useState<StockHeadline[]>([])
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    const load = (): void => {
      if (document.hidden) return
      window.api.trading
        .quote(symbol)
        .then((q) => {
          if (!live) return
          setQuote(q)
          setError(null)
        })
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(e)))
    }
    load()
    const timer = setInterval(load, QUOTE_EVERY_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [symbol, attempt])

  useEffect(() => {
    let live = true
    const load = (): void => {
      if (document.hidden) return
      window.api.trading
        .bars(symbol, range as BarRange)
        .then((b) => live && setBars((all) => ({ ...all, [range]: b })))
        .catch(() => undefined)
    }
    load()
    // Only the day moves while it's watched; longer ranges are as good for the card's life.
    const timer = range === '1d' ? setInterval(load, BARS_EVERY_MS) : null
    return () => {
      live = false
      if (timer) clearInterval(timer)
    }
  }, [symbol, range, attempt])

  useEffect(() => {
    if (!news) return
    let live = true
    window.api.trading
      .news(symbol, 3)
      .then((h) => live && setHeadlines(h))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [symbol, news, attempt])

  const series = bars[range]
  const from = range === '1d' ? quote?.prevClose : series?.[0]?.c
  const last = series?.[series.length - 1]?.c ?? quote?.price
  const move = from !== undefined && last !== undefined ? last - from : quote?.change
  const movePct = from && move !== undefined ? (move / from) * 100 : quote?.changePct
  const up = (move ?? 0) >= 0
  const money = (n: number): string => formatMoney(n, quote?.currency ?? 'USD')

  if (error && !quote) {
    return (
      <div className="wui-stock wui-stock--error">
        <span>
          Couldn’t load {symbol}’s prices just now: {error}
        </span>
        <button type="button" className="wbtn" onClick={() => setAttempt((n) => n + 1)}>
          <RotateCw size={13} strokeWidth={2} />
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="wui-stock" data-trend={up ? 'up' : 'down'}>
      <div className="wui-stock__head">
        <span className="wui-stock__name">
          <span className="wui-stock__symbol">{symbol}</span>
          {quote?.name && <span className="wui-stock__company">{quote.name}</span>}
        </span>
        {quote ? (
          <span className="wui-stock__price">
            <span className="wui-stock__now">{money(quote.price)}</span>
            {move !== undefined && movePct !== undefined && (
              <span className="wui-stock__move">
                {up ? <ArrowUp size={12} strokeWidth={2.4} /> : <ArrowDown size={12} strokeWidth={2.4} />}
                {money(Math.abs(move))} ({Math.abs(movePct).toFixed(2)}%) <span className="wui-stock__span">{range === '1d' ? 'today' : RANGE_LABEL[range]}</span>
              </span>
            )}
          </span>
        ) : (
          <span className="wui-stock__loading" aria-label="Loading">
            <span />
            <span />
          </span>
        )}
      </div>
      <Segments labels={STOCK_RANGES.map((r) => RANGE_LABEL[r])} value={STOCK_RANGES.indexOf(range)} onChange={(i) => setRange(STOCK_RANGES[i])} label={`${symbol} range`} />
      {series && series.length >= 2 ? (
        <Plot
          style="area"
          labels={series.map((b) => barTime(b.t, range))}
          series={[{ name: symbol, values: series.map((b) => b.c) }]}
          format={money}
          color={up ? 'var(--wui-up)' : 'var(--wui-down)'}
          baseline={range === '1d' ? quote?.prevClose : undefined}
        />
      ) : (
        <div className="wui-plot wui-plot--empty" aria-label="Loading the chart" />
      )}
      {quote && (
        <dl className="wfacts wui-stock__facts">
          <div>
            <dt>Previous close</dt>
            <dd>{money(quote.prevClose)}</dd>
          </div>
          {quote.dayLow !== null && quote.dayHigh !== null && (
            <div>
              <dt>Day’s range</dt>
              <dd>
                {money(quote.dayLow)} – {money(quote.dayHigh)}
              </dd>
            </div>
          )}
          {quote.volume !== null && (
            <div>
              <dt>Volume</dt>
              <dd>{new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(quote.volume)}</dd>
            </div>
          )}
        </dl>
      )}
      {headlines.length > 0 && (
        <ul className="wui-news">
          {headlines.map((h, i) => (
            <li key={i}>
              {h.url ? (
                <button type="button" className="wui-news__link" onClick={() => void window.api.app.openExternal(h.url!)}>
                  {h.title}
                  <ArrowUpRight size={12} strokeWidth={2} />
                </button>
              ) : (
                <span>{h.title}</span>
              )}
              <span className="wui-news__meta">{[h.publisher, timeAgo(h.at)].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
      <span className="wui-stock__source">Live from Yahoo Finance; can lag by up to 15 minutes.</span>
    </div>
  )
}

/* ---------------------------------------------------------------- formats */

function formatNumber(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e6) return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(n)
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: abs >= 100 ? 0 : abs >= 1 ? 2 : 4 }).format(n)
}

function formatMoney(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n)
  } catch {
    return formatNumber(n)
  }
}

/** A bar's time as the range reads it: "2:35 PM" for a day, "Tue 2 PM" for five, "Oct 3" beyond. */
function barTime(t: number, range: StockRange): string {
  const d = new Date(t)
  if (range === '1d') return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (range === '5d') return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(range === '1y' ? { year: '2-digit' } : {}) })
}

function timeAgo(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 0) return ''
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`
  return `${Math.round(minutes / 1440)} days ago`
}

