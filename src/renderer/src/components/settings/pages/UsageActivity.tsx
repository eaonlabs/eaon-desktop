import { useMemo, useState, type CSSProperties, type JSX } from 'react'
import type { UsageActivity as Activity, UsageDay } from '@shared/usage'
import { Segmented } from '../../ui'

/**
 * Settings → Usage's activity section: a year of days as a calendar, one
 * column per week with Sunday at the top, and the numbers that go with it
 * (active days, streaks, the busiest day, everything so far).
 *
 * Shading is ranked rather than linear, as on Tokn's profile: one huge day
 * would otherwise fade every other day to the faintest shade, so the four
 * shades are quartiles of the days that had any use at all.
 */

type Metric = 'cost' | 'tokens' | 'requests'

const METRICS: { value: Metric; label: string }[] = [
  { value: 'cost', label: 'Spend' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'requests', label: 'Requests' }
]
const METRIC_KEY = 'eaon.usage.heatMetric'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['', 'Mon', '', 'Wed', '', 'Fri', '']

const valueOf = (day: UsageDay, metric: Metric): number =>
  metric === 'cost' ? day.costUsd : metric === 'tokens' ? day.tokens : day.requests

function quartiles(values: number[]): [number, number, number] {
  if (values.length === 0) return [0, 0, 0]
  const sorted = [...values].sort((a, b) => a - b)
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
  return [at(0.25), at(0.5), at(0.75)]
}

function levelOf(value: number, [q1, q2, q3]: [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0
  if (value > q3) return 4
  if (value > q2) return 3
  if (value > q1) return 2
  return 1
}

const dateOf = (day: string): Date => new Date(`${day}T12:00:00`)
const longDay = (day: string): string => dateOf(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const shortDay = (day: string): string => dateOf(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

function savedMetric(priced: boolean): Metric {
  try {
    const saved = localStorage.getItem(METRIC_KEY)
    if (saved === 'cost' || saved === 'tokens' || saved === 'requests') return saved
  } catch {
    /* the default is fine */
  }
  return priced ? 'cost' : 'tokens'
}

export function UsageActivity({
  days,
  activity,
  priced,
  range,
  money,
  tokens
}: {
  days: UsageDay[]
  activity: Activity
  priced: boolean
  range: number
  money: (usd: number) => string
  tokens: (n: number) => string
}): JSX.Element {
  const [metric, setMetric] = useState<Metric>(() => savedMetric(priced))
  const [hover, setHover] = useState<number | null>(null)

  const pick = (value: string): void => {
    setMetric(value as Metric)
    try {
      localStorage.setItem(METRIC_KEY, value)
    } catch {
      /* not remembered, that's all */
    }
  }

  const weeks = Math.ceil(days.length / 7)
  const thresholds = useMemo(() => quartiles(days.map((d) => valueOf(d, metric)).filter((v) => v > 0)), [days, metric])

  // A month's name goes over the first week that starts in it.
  const months = useMemo(() => {
    const labels: { week: number; label: string }[] = []
    let last = -1
    for (let w = 0; w < weeks; w++) {
      const first = days[w * 7]
      if (!first) continue
      const month = dateOf(first.day).getMonth()
      if (month !== last) {
        // Skip a label squeezed into the first column by a month that ends there.
        if (!(w === 0 && dateOf(first.day).getDate() > 24)) labels.push({ week: w, label: MONTHS[month] })
        last = month
      }
    }
    return labels
  }, [days, weeks])

  const shown = hover !== null ? days[hover] : null
  const format = (day: UsageDay): string =>
    day.requests === 0
      ? 'No activity'
      : `${money(day.costUsd)} · ${tokens(day.tokens)} tokens · ${day.requests.toLocaleString()} ${day.requests === 1 ? 'request' : 'requests'}`

  const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
  const yearActive = days.filter((d) => d.requests > 0).length

  return (
    <>
      <div className="usage-heat" onPointerLeave={() => setHover(null)}>
        <div className="usage-heat__top">
          <div className="usage-chart__readout" aria-live="polite">
            {shown ? (
              <>
                <strong>{longDay(shown.day)}</strong> {format(shown)}
              </>
            ) : (
              <>
                <strong>{plural(yearActive, 'active day')}</strong> in the last year
              </>
            )}
          </div>
          <Segmented value={metric} options={METRICS} onChange={pick} />
        </div>

        <div className="usage-heat__body" style={{ '--weeks': weeks } as CSSProperties}>
          <span />
          <div className="usage-heat__months" aria-hidden="true">
            {months.map((m) => (
              <span key={`${m.week}-${m.label}`} style={{ gridColumn: m.week + 1 }}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="usage-heat__weekdays" aria-hidden="true">
            {WEEKDAYS.map((label, i) => (
              <span key={i}>{label}</span>
            ))}
          </div>
          <div
            className="usage-heat__grid"
            role="img"
            aria-label={`Activity over the last year: ${plural(yearActive, 'active day')}, current streak ${plural(activity.currentStreak, 'day')}`}
          >
            {days.map((day, i) => (
              <span
                key={day.day}
                className="usage-heat__cell"
                data-level={levelOf(valueOf(day, metric), thresholds)}
                data-hover={hover === i || undefined}
                style={{ '--w': Math.floor(i / 7) } as CSSProperties}
                onPointerEnter={() => setHover(i)}
              />
            ))}
          </div>
        </div>

        <div className="usage-heat__foot">
          <span>{activity.firstDay ? `Counting since ${shortDay(activity.firstDay)}` : 'Nothing counted yet'}</span>
          <span className="usage-heat__legend" aria-hidden="true">
            Less
            {[0, 1, 2, 3, 4].map((level) => (
              <i key={level} className="usage-heat__cell" data-level={level} />
            ))}
            More
          </span>
        </div>
      </div>

      <div className="usage-tiles usage-tiles--activity">
        <StatTile
          label="Active days"
          value={activity.activeDays.toLocaleString()}
          sub={`${activity.activeInRange} in the last ${range} days`}
        />
        <StatTile
          label="Current streak"
          value={plural(activity.currentStreak, 'day')}
          sub={`Longest: ${plural(activity.longestStreak, 'day')}`}
        />
        <StatTile
          label="Busiest day"
          value={activity.busiest ? (activity.busiest.costUsd > 0 ? money(activity.busiest.costUsd) : tokens(activity.busiest.tokens)) : '—'}
          sub={activity.busiest ? shortDay(activity.busiest.day) : 'No activity yet'}
        />
        <StatTile
          label="All time"
          value={money(activity.allTime.costUsd)}
          sub={`${tokens(activity.allTime.tokens)} tokens`}
        />
      </div>
    </>
  )
}

function StatTile({ label, value, sub }: { label: string; value: string; sub: string }): JSX.Element {
  return (
    <div className="usage-tile">
      <div className="usage-tile__label">{label}</div>
      <div className="usage-tile__value">{value}</div>
      <div className="usage-tile__sub">{sub}</div>
    </div>
  )
}
