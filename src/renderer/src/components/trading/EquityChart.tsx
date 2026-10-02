import { useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from 'react'
import type { EquityPoint } from '@shared/trading'
import { usd, usdCompact } from './tradingStore'

/**
 * The account's value over time: one series, so one line in the accent hue
 * over a faint wash of it, with the range's starting value as a hairline
 * baseline — above it is a gain, below a loss, without leaning on red and
 * green. The latest value is labelled at the end of the line; everything else
 * is on hover (a crosshair that snaps to the nearest point) or from the
 * keyboard with ← and →. The same numbers are in the table view.
 */

const HEIGHT = 220
const PAD = { top: 14, right: 64, bottom: 24, left: 8 }

/** Clean tick values: 1, 2 or 5 × a power of ten, covering [min, max]. */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (max - min < 1e-9) {
    const pad = Math.max(1, Math.abs(max) * 0.01)
    min -= pad
    max += pad
  }
  const raw = (max - min) / count
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw
  const ticks: number[] = []
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)))
  return ticks
}

/** At most `max` points, keeping the first, the last, and each bucket's extremes so peaks and dips survive. */
function thin(points: EquityPoint[], max: number): EquityPoint[] {
  if (points.length <= max) return points
  const bucket = Math.ceil(points.length / (max / 2))
  const out: EquityPoint[] = [points[0]]
  for (let i = 1; i < points.length - 1; i += bucket) {
    const slice = points.slice(i, Math.min(i + bucket, points.length - 1))
    let lo = slice[0]
    let hi = slice[0]
    for (const p of slice) {
      if (p.equity < lo.equity) lo = p
      if (p.equity > hi.equity) hi = p
    }
    out.push(...(lo.at < hi.at ? [lo, hi] : [hi, lo]))
  }
  out.push(points[points.length - 1])
  return out
}

function timeLabel(at: number, span: number): string {
  const date = new Date(at)
  if (span <= 36 * 60 * 60_000) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function EquityChart({ points, baseline }: { points: EquityPoint[]; baseline: number | null }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)

  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const data = useMemo(() => thin(points, Math.max(60, Math.floor(width / 2))), [points, width])
  const geometry = useMemo(() => {
    if (data.length === 0) return null
    const values = data.map((p) => p.equity).concat(baseline ?? [])
    const ticks = niceTicks(Math.min(...values), Math.max(...values))
    const lo = ticks[0]
    const hi = ticks[ticks.length - 1]
    const t0 = data[0].at
    const t1 = data[data.length - 1].at
    const plotW = width - PAD.left - PAD.right
    const plotH = HEIGHT - PAD.top - PAD.bottom
    const x = (at: number): number => PAD.left + (t1 === t0 ? plotW : ((at - t0) / (t1 - t0)) * plotW)
    const y = (v: number): number => PAD.top + (1 - (v - lo) / (hi - lo || 1)) * plotH
    const line = data.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.equity).toFixed(1)}`).join('')
    const area = `${line}L${x(t1).toFixed(1)},${PAD.top + plotH}L${x(t0).toFixed(1)},${PAD.top + plotH}Z`
    const span = t1 - t0
    const xTicks = data.length > 1 ? [t0, t0 + span / 2, t1] : [t0]
    return { ticks, x, y, line, area, plotW, plotH, span, xTicks }
  }, [data, baseline, width])

  if (!geometry || data.length < 2) {
    return (
      <div ref={box} className="eq-chart eq-chart--empty">
        <p>The chart fills in as the account’s value is recorded — every few minutes while Eaon is open, and after every trade.</p>
      </div>
    )
  }

  const { ticks, x, y, line, area, span, xTicks } = geometry
  const last = data[data.length - 1]
  const point = hover !== null ? data[hover] : null

  const nearest = (clientX: number, rect: DOMRect): number => {
    const px = clientX - rect.left
    let best = 0
    for (let i = 1; i < data.length; i++) if (Math.abs(x(data[i].at) - px) < Math.abs(x(data[best].at) - px)) best = i
    return best
  }
  const onMove = (event: PointerEvent<SVGSVGElement>): void => setHover(nearest(event.clientX, event.currentTarget.getBoundingClientRect()))
  const onKey = (event: KeyboardEvent<SVGSVGElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const from = hover ?? data.length - 1
    setHover(Math.min(data.length - 1, Math.max(0, from + (event.key === 'ArrowRight' ? 1 : -1))))
  }

  return (
    <div ref={box} className="eq-chart">
      <button className="eq-chart__table-toggle btn btn--sm btn--ghost" onClick={() => setAsTable((v) => !v)}>
        {asTable ? 'Chart' : 'Table'}
      </button>
      {asTable ? (
        <div className="eq-table scroll">
          <table className="tr-table">
            <thead>
              <tr>
                <th>Time</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().slice(0, 60).map((p) => (
                <tr key={p.at}>
                  <td>{new Date(p.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                  <td className="num">{usd(p.equity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Account value from ${usd(data[0].equity)} to ${usd(last.equity)}`}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(data.length - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={onKey}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="eq-chart__grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
              <text className="eq-chart__tick" x={width - PAD.right + 8} y={y(tick)} dy="0.32em">
                {usdCompact(tick)}
              </text>
            </g>
          ))}
          {xTicks.map((at, i) => (
            <text
              key={at}
              className="eq-chart__tick"
              x={x(at)}
              y={HEIGHT - 6}
              textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            >
              {timeLabel(at, span)}
            </text>
          ))}
          <path className="eq-chart__area" d={area} />
          {baseline !== null && <line className="eq-chart__baseline" x1={PAD.left} x2={width - PAD.right} y1={y(baseline)} y2={y(baseline)} />}
          <path className="eq-chart__line" d={line} />
          <circle className="eq-chart__end" cx={x(last.at)} cy={y(last.equity)} r={4} />
          {!point && (
            <text className="eq-chart__end-label" x={x(last.at) - 8} y={y(last.equity) - 10} textAnchor="end">
              {usd(last.equity)}
            </text>
          )}
          {point && (
            <g className="eq-chart__cross" pointerEvents="none">
              <line x1={x(point.at)} x2={x(point.at)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
              <circle cx={x(point.at)} cy={y(point.equity)} r={4} />
            </g>
          )}
        </svg>
      )}
      {point && !asTable && (
        <div
          className="eq-chart__tip"
          style={{ left: Math.min(Math.max(x(point.at), 70), width - 130), top: Math.max(0, y(point.equity) - 58) }}
          role="status"
        >
          <strong>{usd(point.equity)}</strong>
          <span>{new Date(point.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        </div>
      )}
    </div>
  )
}
