import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Bike,
  Bug,
  Bus,
  Calendar,
  Car,
  ChartLine,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Cloud,
  Code,
  Cpu,
  Database,
  DollarSign,
  FlaskConical,
  Footprints,
  GitBranch,
  Globe,
  House,
  Mail,
  Music,
  Package,
  Plane,
  RefreshCw,
  Rocket,
  RotateCw,
  Server,
  Ship,
  SquareTerminal,
  Sun,
  Ticket,
  TrainFront,
  TrendingDown,
  TrendingUp,
  Truck,
  User,
  Utensils,
  Wallet,
  type LucideIcon
} from 'lucide-react'
import type { Bar, BarRange, Quote, StockHeadline } from '@shared/trading'
import type { ChatMessage, ChatToolPart } from '@shared/types'
import {
  cardDeck,
  markChanges,
  normalizeUi,
  STOCK_RANGES,
  type CardDeck,
  type ChartStyle,
  type RouteMode,
  type StockRange,
  type UiBlock,
  type UiField,
  type UiIcon,
  type UiPlace,
  type UiSeries,
  type WorkerUi
} from '@shared/workerUi'
import { Markdown } from '../agent/Markdown'
import { Actions } from './WorkerCards'

/**
 * A card a worker laid out itself (show_ui, shared/workerUi.ts): blocks drawn
 * in the cards' own style. What moves is Eaon's — tabs, a chart's views and
 * its readout under the pointer, a sortable table, a stock's live price and
 * ranges — so a worker gets a small app's worth of card without any of its
 * text ever running.
 */
export function UiCard({ input, previous, call }: { input: Record<string, unknown>; previous?: Record<string, unknown> | null; call?: string }): JSX.Element | null {
  const result = useMemo(() => normalizeUi(input), [input])
  const before = useMemo(() => (previous ? normalizeUi(previous) : null), [previous])
  const card = useRef<HTMLElement>(null)
  useTicketNotches(card)
  if ('error' in result) return null
  // What moved since the version before: its old value struck through.
  const ui = markChanges(result.ui, before && !('error' in before) ? before.ui : null)
  return (
    <article ref={card} className="wcard wui" data-kind="ui" data-card-call={call}>
      <CardHead ui={ui} />
      <Blocks blocks={ui.blocks} slot="b" />
    </article>
  )
}

/**
 * A ticket divider's notches, cut out of the card itself (a mask), so they
 * show whatever is behind it: the thread, a wallpaper. A half circle at each
 * side, level with each tear line, kept in place as the card's size changes.
 */
function useTicketNotches(card: React.RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const node = card.current
    if (!node) return
    const cut = (): void => {
      const top = node.getBoundingClientRect().top
      const lines = [...node.querySelectorAll<HTMLElement>('.wui-ticket')].map((t) => {
        const r = t.getBoundingClientRect()
        return Math.round(r.top - top + r.height / 2)
      })
      const holes = lines.flatMap((y) => [`radial-gradient(circle 9px at 0 ${y}px, transparent 8.5px, #000 9px)`, `radial-gradient(circle 9px at 100% ${y}px, transparent 8.5px, #000 9px)`])
      node.style.maskImage = holes.join(', ')
      node.style.maskComposite = holes.length ? 'intersect' : ''
      node.dataset.notched = holes.length ? 'true' : ''
    }
    cut()
    const watch = new ResizeObserver(cut)
    watch.observe(node)
    return () => watch.disconnect()
  })
}

const ICON: Record<UiIcon, LucideIcon> = {
  plane: Plane, train: TrainFront, car: Car, bus: Bus, ship: Ship, package: Package, truck: Truck, chart: ChartLine, dollar: DollarSign,
  wallet: Wallet, calendar: Calendar, clock: Clock, cloud: Cloud, sun: Sun, home: House, server: Server, git: GitBranch, bug: Bug,
  check: Check, alert: AlertTriangle, rocket: Rocket, user: User, music: Music, food: Utensils, ticket: Ticket, mail: Mail, globe: Globe,
  code: Code, database: Database, cpu: Cpu, terminal: SquareTerminal, test: FlaskConical
}

/** The card's header: its icon in a disc, the title with its code beside it, and its status at the end. */
function CardHead({ ui }: { ui: WorkerUi }): JSX.Element | null {
  if (!ui.title && !ui.subtitle && !ui.icon && !ui.status) return null
  const Icon = ui.icon ? ICON[ui.icon] : null
  return (
    <header className="wui__head">
      {Icon && (
        <span className="wui__icon" aria-hidden="true">
          <Icon size={17} strokeWidth={1.9} />
        </span>
      )}
      <span className="wui__names">
        {ui.title && <span className="wcard__title">{ui.title}</span>}
        {ui.subtitle && <span className="wui__subtitle">{ui.subtitle}</span>}
      </span>
      {ui.status && (
        <span className="wui-pill wui__status" data-tone={ui.status.tone ?? 'neutral'}>
          {ui.status.label}
        </span>
      )}
    </header>
  )
}

/**
 * The cards an agent keeps in this conversation (cardDeck): a card shown
 * again by its id is drawn where it first appeared, as it is now, and the
 * later call is a line saying it changed. Chat and a worker's thread each
 * provide theirs, from their messages (useCardDeck).
 */
export const CardDeckContext = createContext<CardDeck | null>(null)

export function useCardDeck(messages: readonly ChatMessage[] | undefined): CardDeck {
  return useMemo(
    () =>
      cardDeck(
        (messages ?? []).flatMap((m) =>
          m.parts
            .filter((p): p is ChatToolPart => p.type === 'tool' && p.name === 'show_ui' && p.status !== 'error' && p.status !== 'denied')
            .map((p) => ({ id: p.id, input: p.input }))
        )
      ),
    [messages]
  )
}

/** A show_ui call: its card, the latest version of it if the agent changed it since, or a line saying this call changed one above. */
export function KeptUiCard({ part }: { part: ChatToolPart }): JSX.Element | null {
  const deck = useContext(CardDeckContext)
  const id = deck?.byCall.get(part.id)
  const card = id ? deck?.cards.get(id) : undefined
  if (!card) return <UiCard input={part.input} call={part.id} />
  if (card.first !== part.id) return <CardChanged first={card.first} input={part.input} />
  const n = card.versions.length
  return <UiCard input={card.versions[n - 1]} previous={n > 1 ? card.versions[n - 2] : null} call={part.id} />
}

/** Where the agent changed a card it showed earlier: a quiet line that takes you to it. */
function CardChanged({ first, input }: { first: string; input: Record<string, unknown> }): JSX.Element {
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'a card'
  return (
    <button
      type="button"
      className="wui-changed"
      onClick={() => document.querySelector(`[data-card-call="${CSS.escape(first)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
      title="Show the card"
    >
      <RefreshCw size={12} strokeWidth={2.2} />
      Updated <strong>{title}</strong>
      {typeof input.subtitle === 'string' && input.subtitle.trim() && <span className="wui-changed__sub">{input.subtitle.trim()}</span>}
    </button>
  )
}

function Blocks({ blocks, slot }: { blocks: UiBlock[]; slot: string }): JSX.Element {
  // A chart under a figure that went up or down draws in that figure's colour, green or red, as its trend.
  const metric = blocks.find((b): b is Extract<UiBlock, { type: 'metric' }> => b.type === 'metric' && Boolean(b.tone))
  const trend = metric?.tone === 'up' || metric?.tone === 'good' ? 'var(--wui-up)' : metric?.tone === 'down' || metric?.tone === 'bad' ? 'var(--wui-down)' : undefined
  return (
    <>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} slot={`${slot}${i}`} trend={trend} />
      ))}
    </>
  )
}

function BlockView({ block, slot, trend }: { block: UiBlock; slot: string; trend?: string }): JSX.Element {
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
    case 'metric':
      return (
        <div className="wui-metric">
          <div className="wui-metric__top">
            <span className="wui-metric__label">{block.label}</span>
            {block.change && (
              <span className="wui-pill" data-tone={block.tone ?? 'neutral'}>
                {block.change}
              </span>
            )}
          </div>
          <span className="wui-metric__value">{block.value}</span>
          {block.detail && <span className="wui-metric__detail">{block.detail}</span>}
        </div>
      )
    case 'fields':
      return <FieldsBlock items={block.items} columns={block.columns} />
    case 'route':
      return <RouteBlock from={block.from} to={block.to} mode={block.mode} detail={block.detail} />
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
      return <ChartBlock style={block.style} unit={block.unit} views={block.views} bottom={block.at === 'bottom'} color={trend} />
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
      return <TabsBlock tabs={block.tabs} slot={slot} bottom={block.at === 'bottom'} />
    case 'buttons':
      return <Actions actions={block.actions} slot={slot} />
    case 'divider':
      return block.style === 'ticket' ? <div className="wui-ticket" role="separator" /> : <hr className="wui-divider" />
  }
}

/** A value that changed: the new one in its tone, the old one struck through under it. */
function Was({ was }: { was?: string }): JSX.Element | null {
  return was ? (
    <s className="wui-was" aria-label={`was ${was}`}>
      {was}
    </s>
  ) : null
}

/** Labelled values in a grid, as on a boarding pass: Gate, Boards, Seat, Group. */
function FieldsBlock({ items, columns }: { items: UiField[]; columns?: number }): JSX.Element {
  return (
    <div className="wui-fields" style={{ ['--n' as string]: columns ?? Math.min(items.length, 4) }}>
      {items.map((item, i) => (
        <div key={i} className="wui-field" data-changed={item.was ? true : undefined}>
          <span className="wui-field__label">{item.label}</span>
          <span className="wui-field__value" data-tone={item.tone}>
            {item.value}
          </span>
          <Was was={item.was} />
          {item.detail && <span className="wui-field__detail">{item.detail}</span>}
        </div>
      ))}
    </div>
  )
}

const MODE: Record<RouteMode, LucideIcon> = { plane: Plane, train: TrainFront, car: Car, bus: Bus, ship: Ship, walk: Footprints, bike: Bike, arrow: ArrowRight }

/** From → to: each end's code large, its name and time under it, the way between them in the middle. */
function RouteBlock({ from, to, mode, detail }: { from: UiPlace; to: UiPlace; mode: RouteMode; detail?: string }): JSX.Element {
  const Mode = MODE[mode]
  const end = (place: UiPlace, side: 'from' | 'to'): JSX.Element => {
    const time = place.time ? (
      <span className="wui-route__time" data-tone={place.tone ?? (place.was ? 'warn' : undefined)}>
        {place.was && <s className="wui-was">{place.was}</s>}
        {place.time}
      </span>
    ) : null
    return (
      <div className="wui-route__end" data-side={side}>
        <span className="wui-route__code">{place.code}</span>
        {(place.name || time) && (
          <span className="wui-route__place">
            {side === 'from' ? (
              <>
                {place.name}
                {place.name && time && <span className="wui-route__dot">·</span>}
                {time}
              </>
            ) : (
              <>
                {time}
                {place.name && time && <span className="wui-route__dot">·</span>}
                {place.name}
              </>
            )}
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="wui-route">
      <div className="wui-route__row">
        {end(from, 'from')}
        <span className="wui-route__mode" aria-label={`by ${mode}`}>
          <Mode size={18} strokeWidth={1.8} />
        </span>
        {end(to, 'to')}
      </div>
      {detail && <span className="wui-route__detail">{detail}</span>}
    </div>
  )
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

/** Views of the card; at the bottom, a full-width segmented control under them (Week · Month · Year), as on a phone. */
function TabsBlock({ tabs, slot, bottom }: { tabs: { label: string; blocks: UiBlock[] }[]; slot: string; bottom?: boolean }): JSX.Element {
  const [at, setAt] = useState(bottom ? Math.min(1, tabs.length - 1) : 0)
  const segments = <Segments labels={tabs.map((t) => t.label)} value={at} onChange={setAt} label="Sections" />
  return (
    <div className="wui-tabs" data-at={bottom ? 'bottom' : undefined}>
      {!bottom && segments}
      <div className="wui-tabs__panel" role="tabpanel">
        <Blocks blocks={tabs[at]?.blocks ?? []} slot={`${slot}t${at}-`} />
      </div>
      {bottom && segments}
    </div>
  )
}

function ChartBlock({ style, unit, views, bottom, color }: { style: ChartStyle; unit?: string; views: { label: string; series: UiSeries[] }[]; bottom?: boolean; color?: string }): JSX.Element {
  const [at, setAt] = useState(0)
  const view = views[at] ?? views[0]
  const segments = views.length > 1 ? <Segments labels={views.map((v) => v.label)} value={at} onChange={setAt} label="Chart" /> : null
  return (
    <div className="wui-chart" data-at={bottom ? 'bottom' : undefined}>
      {!bottom && segments}
      <Plot
        style={style}
        labels={view.series[0].points.map((p) => p.x)}
        series={view.series.map((s) => ({ name: s.name, values: s.points.map((p) => p.y) }))}
        format={(n) => `${formatNumber(n)}${unit ? ` ${unit}` : ''}`}
        quiet
        color={view.series.length === 1 ? color : undefined}
      />
      {bottom && segments}
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
  baseline,
  quiet
}: {
  style: ChartStyle
  labels: string[]
  series: { name: string; values: number[] }[]
  format: (n: number) => string
  /** One colour for every series (a stock's green or red). */
  color?: string
  /** A level to mark with a dashed line (a stock's previous close). */
  baseline?: number
  /** The readout only under the pointer, and the latest point marked: a chart under its own figure. */
  quiet?: boolean
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
    <div className="wui-plot" ref={box} data-quiet={quiet || undefined} data-hover={hover !== null || undefined}>
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
              // A quiet chart's lines are smooth curves through the points; a stock's stay straight, as prices move.
              const line = quiet ? smoothPath(s.values.map((v, i) => [x(i), y(v)])) : s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
              return (
                <g key={si}>
                  {style === 'area' && si === 0 && (
                    <path d={`${line}L${x(s.values.length - 1).toFixed(1)},${height - pad.bottom}L${x(0).toFixed(1)},${height - pad.bottom}Z`} style={{ fill: `url(#${fill}-${si})` }} />
                  )}
                  <path d={line} className="wui-plot__line" style={{ stroke: colorOf(si) }} />
                </g>
              )
            })}
        {quiet && hover === null && style !== 'bar' && series.length === 1 && series[0].values.length > 0 && (
          <circle
            className="wui-plot__end"
            cx={x(series[0].values.length - 1)}
            cy={y(series[0].values[series[0].values.length - 1])}
            r={4.5}
            style={{ fill: colorOf(0), color: colorOf(0) }}
          />
        )}
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

/**
 * A smooth line through the points that never overshoots them (monotone
 * cubic, Fritsch–Carlson): a rising run never dips between two points.
 */
function smoothPath(pts: [number, number][]): string {
  const n = pts.length
  if (n < 3) return pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('')
  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0])
    slope.push(dx[i] === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx[i])
  }
  const m: number[] = [slope[0]]
  for (let i = 1; i < n - 1; i++) m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2)
  m.push(slope[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / slope[i]
    const b = m[i + 1] / slope[i]
    const h = a * a + b * b
    if (h > 9) {
      const t = 3 / Math.sqrt(h)
      m[i] = t * a * slope[i]
      m[i + 1] = t * b * slope[i]
    }
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    const h = dx[i] / 3
    d += `C${(x0 + h).toFixed(1)},${(y0 + m[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - m[i + 1] * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`
  }
  return d
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

