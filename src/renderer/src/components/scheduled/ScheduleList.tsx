import { Bot, CalendarClock, Repeat, Square, Timer } from 'lucide-react'
import type { ScheduleRow } from '@shared/schedules'
import { Switch } from '../ui'
import { formatRelative, formatWhen, STATUS_LABEL } from './format'

/**
 * Every schedule in one list: automations, the routines workers run on a
 * clock, and the wake-ups a worker set for itself, soonest first. Each row
 * says when it runs next and how its last run went, and can be paused (or, for
 * a wake-up the worker set itself, cancelled).
 */

const ICON = { automation: CalendarClock, routine: Repeat, wakeup: Timer } as const
const KIND = { automation: 'Automation', routine: 'Worker routine', wakeup: 'Worker wake-up' } as const

function nextText(row: ScheduleRow, now: number): string {
  if (row.nextAt !== null) return `${formatWhen(row.nextAt, now)} · ${formatRelative(row.nextAt, now)}`
  return row.nextNote ?? 'Not scheduled'
}

export function ScheduleList({
  rows,
  now,
  onPause,
  onStop
}: {
  rows: ScheduleRow[]
  now: number
  onPause: (row: ScheduleRow, paused: boolean) => void
  onStop: (row: ScheduleRow) => void
}): JSX.Element {
  return (
    <div className="card sched-all" role="list" aria-label="All schedules">
      <div className="sched-all__head" aria-hidden>
        <span>Schedule</span>
        <span>Next run</span>
        <span>Last run</span>
        <span />
      </div>
      {rows.map((row) => {
        const Icon = ICON[row.kind]
        return (
          <div key={row.key} className="sched-all__row" role="listitem" data-paused={row.paused || undefined} data-idle={row.nextAt === null || undefined}>
            <div className="sched-all__what">
              <span className="sched-all__icon" data-kind={row.kind}>
                <Icon size={14} strokeWidth={1.9} />
              </span>
              <div className="sched-all__text">
                <div className="sched-all__name">{row.name}</div>
                <div className="sched-all__meta">
                  <span>{KIND[row.kind]}</span>
                  {row.worker && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="sched-all__worker">
                        <Bot size={11} strokeWidth={2} style={{ color: row.worker.color }} aria-hidden />
                        {row.worker.name}
                      </span>
                    </>
                  )}
                  <span aria-hidden>·</span>
                  <span>{row.cadence}</span>
                </div>
              </div>
            </div>
            <div className="sched-all__next">{nextText(row, now)}</div>
            <div className="sched-all__last">
              {row.last ? (
                <>
                  <span className="sched-status__dot" data-status={row.last.status} aria-hidden />
                  <span className="sched-last__status" data-status={row.last.status}>
                    {STATUS_LABEL[row.last.status]}
                  </span>
                  <span className="sched-last__when">{formatRelative(row.last.at, now)}</span>
                  {row.last.detail && <span className="sched-all__detail">— {row.last.detail}</span>}
                </>
              ) : (
                <span className="sched-muted">Hasn’t run yet</span>
              )}
            </div>
            <div className="sched-all__control">
              {row.control === 'pause' && (
                <Switch label={`${row.paused ? 'Resume' : 'Pause'} ${row.name}`} checked={!row.paused && row.nextNote !== 'Done'} disabled={row.nextNote === 'Done'} onChange={(on) => onPause(row, !on)} />
              )}
              {row.control === 'stop' && (
                <button className="btn btn--sm" title="The worker set this wake-up for itself; this cancels it" onClick={() => onStop(row)}>
                  <Square size={11} strokeWidth={2.4} />
                  Cancel
                </button>
              )}
              {row.control === null && row.controlNote && <span className="sched-muted sched-all__note">{row.controlNote}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
