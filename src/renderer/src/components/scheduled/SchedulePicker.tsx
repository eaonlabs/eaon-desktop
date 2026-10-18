import type { Dispatch, SetStateAction } from 'react'
import { CalendarClock, TriangleAlert } from 'lucide-react'
import { describeCron } from '@shared/cron'
import {
  DAY_NAMES,
  DAY_SHORT,
  nextRunAfter,
  scheduleError,
  WEEKDAYS,
  WORKDAYS,
  type IntervalUnit,
  type Schedule
} from '@shared/scheduler'
import { Segmented, Select } from '../ui'
import { formatRelative, formatWhen, fromLocalInput, toLocalInput } from './format'

/**
 * The schedule half of the editor. Each kind keeps its own fields in the form
 * so flipping Daily → Once → Daily does not lose the days you had picked.
 */

export interface ScheduleForm {
  kind: Schedule['kind']
  every: string
  unit: IntervalUnit
  time: string
  days: number[]
  day: number
  at: string
  /** Cron expression. */
  expr: string
  /** Cron time zone; empty follows this computer. */
  tz: string
}

/** Monday-first, the way a week is usually laid out. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

/** One click to a common expression, and a way to learn the syntax by example. */
const CRON_PRESETS = [
  { expr: '*/15 * * * *', label: 'Every 15 min' },
  { expr: '0 9-17 * * 1-5', label: 'Work hours' },
  { expr: '0 9 * * 1-5', label: 'Weekdays at 9' },
  { expr: '0 9 1 * *', label: 'Monthly' }
]

/** Every zone this computer knows, for the time zone box's suggestions. */
const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
})()

function tomorrowAtNine(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0).getTime()
}

export function formFromSchedule(schedule: Schedule | null): ScheduleForm {
  const form: ScheduleForm = {
    kind: 'daily',
    every: '30',
    unit: 'minutes',
    time: '09:00',
    days: WEEKDAYS,
    day: 1,
    at: toLocalInput(tomorrowAtNine()),
    expr: '0 9 * * 1-5',
    tz: ''
  }
  if (!schedule) return form
  switch (schedule.kind) {
    case 'interval':
      return { ...form, kind: 'interval', every: String(schedule.every), unit: schedule.unit }
    case 'daily':
      return { ...form, kind: 'daily', time: schedule.time, days: schedule.days }
    case 'weekly':
      return { ...form, kind: 'weekly', time: schedule.time, day: schedule.day }
    case 'once':
      return { ...form, kind: 'once', at: toLocalInput(schedule.at) }
    case 'cron':
      return { ...form, kind: 'cron', expr: schedule.expr, tz: schedule.tz ?? '' }
  }
}

export function scheduleFromForm(form: ScheduleForm, previous?: Schedule): Schedule {
  switch (form.kind) {
    case 'interval': {
      const every = Number(form.every)
      // Carried only while every/unit are unchanged, so the interval keeps its
      // grid. A changed interval starts a new one: the old anchor may still be
      // in the future, and main would take it as a start the user picked.
      const startAt = previous?.kind === 'interval' && previous.every === every && previous.unit === form.unit ? previous.startAt : undefined
      return { kind: 'interval', every, unit: form.unit, ...(startAt ? { startAt } : {}) }
    }
    case 'daily':
      return { kind: 'daily', time: form.time, days: form.days }
    case 'weekly':
      return { kind: 'weekly', time: form.time, day: form.day }
    case 'once':
      return { kind: 'once', at: fromLocalInput(form.at) }
    case 'cron':
      return { kind: 'cron', expr: form.expr, ...(form.tz.trim() ? { tz: form.tz.trim() } : {}) }
  }
}

export function SchedulePicker({
  form,
  onChange,
  previous
}: {
  form: ScheduleForm
  onChange: Dispatch<SetStateAction<ScheduleForm>>
  previous?: Schedule
}): JSX.Element {
  // Functional updates: two quick clicks must not both start from the same render's form.
  const set = (patch: Partial<ScheduleForm>): void => onChange((current) => ({ ...current, ...patch }))
  const schedule = scheduleFromForm(form, previous)
  const now = Date.now()
  const error = scheduleError(schedule, now)
  // An interval keeps its grid only while every/unit are unchanged (see the engine's save).
  const keepsGrid =
    schedule.kind === 'interval' && previous?.kind === 'interval' && previous.every === schedule.every && previous.unit === schedule.unit
  const forPreview = schedule.kind === 'interval' && !keepsGrid ? { ...schedule, startAt: undefined } : schedule
  const next = error ? null : nextRunAfter(forPreview, now)
  // A cron line is easy to get subtly wrong, so it shows the next few runs, not one.
  const upcoming: number[] = []
  if (schedule.kind === 'cron' && next !== null) {
    for (let at: number | null = next; at !== null && upcoming.length < 3; at = nextRunAfter(schedule, at)) upcoming.push(at)
  }

  const toggleDay = (day: number): void =>
    onChange((current) => ({
      ...current,
      days: current.days.includes(day) ? current.days.filter((d) => d !== day) : [...current.days, day]
    }))

  const timeInput = (
    <input
      className="input sched-input sched-input--time"
      type="time"
      aria-label="Time of day"
      value={form.time}
      onChange={(e) => set({ time: e.target.value })}
    />
  )

  return (
    <div className="sched-picker">
      <Segmented
        value={form.kind}
        onChange={(kind) => set({ kind })}
        options={[
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'interval', label: 'Interval' },
          { value: 'once', label: 'Once' },
          { value: 'cron', label: 'Cron' }
        ]}
      />

      {form.kind === 'interval' && (
        <div className="sched-inline">
          <span>Every</span>
          <input
            className="input sched-input sched-input--num"
            type="number"
            min={1}
            step={1}
            aria-label="Interval"
            value={form.every}
            onChange={(e) => set({ every: e.target.value })}
          />
          <Select
            width={112}
            value={form.unit}
            onChange={(unit) => set({ unit })}
            options={[
              { value: 'minutes', label: Number(form.every) === 1 ? 'minute' : 'minutes' },
              { value: 'hours', label: Number(form.every) === 1 ? 'hour' : 'hours' }
            ]}
          />
        </div>
      )}

      {form.kind === 'daily' && (
        <>
          <div className="sched-inline">
            <span>At</span>
            {timeInput}
          </div>
          <div className="sched-days">
            <div className="sched-days__row" role="group" aria-label="Days">
              {WEEK_ORDER.map((day) => (
                <button
                  key={day}
                  type="button"
                  className="sched-day"
                  aria-pressed={form.days.includes(day)}
                  aria-label={DAY_NAMES[day]}
                  data-on={form.days.includes(day) || undefined}
                  onClick={() => toggleDay(day)}
                >
                  {DAY_SHORT[day].slice(0, 2)}
                </button>
              ))}
            </div>
            <div className="sched-days__presets">
              <button type="button" className="sched-link" onClick={() => set({ days: WEEKDAYS })}>
                Every day
              </button>
              <button type="button" className="sched-link" onClick={() => set({ days: WORKDAYS })}>
                Weekdays
              </button>
            </div>
          </div>
        </>
      )}

      {form.kind === 'weekly' && (
        <div className="sched-inline">
          <span>On</span>
          <Select
            width={136}
            value={String(form.day)}
            onChange={(day) => set({ day: Number(day) })}
            options={WEEK_ORDER.map((day) => ({ value: String(day), label: DAY_NAMES[day] }))}
          />
          <span>at</span>
          {timeInput}
        </div>
      )}

      {form.kind === 'once' && (
        <div className="sched-inline">
          <span>On</span>
          <input
            className="input sched-input sched-input--datetime"
            type="datetime-local"
            aria-label="Date and time"
            value={form.at}
            onChange={(e) => set({ at: e.target.value })}
          />
        </div>
      )}

      {form.kind === 'cron' && (
        <div className="sched-cron">
          <div className="sched-inline">
            <input
              className="input sched-input sched-input--cron"
              aria-label="Cron expression"
              placeholder="minute hour day month weekday"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={form.expr}
              onChange={(e) => set({ expr: e.target.value })}
            />
            <input
              className="input sched-input sched-input--zone"
              aria-label="Time zone"
              placeholder="This computer’s time"
              list="sched-zones"
              spellCheck={false}
              value={form.tz}
              onChange={(e) => set({ tz: e.target.value })}
            />
            <datalist id="sched-zones">
              {ZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </div>
          <div className="sched-days__presets">
            {CRON_PRESETS.map((preset) => (
              <button key={preset.expr} type="button" className="sched-link" onClick={() => set({ expr: preset.expr })}>
                {preset.label}
              </button>
            ))}
          </div>
          {!error && <div className="sched-cron__reads">{describeCron(form.expr, form.tz.trim() || undefined)}</div>}
        </div>
      )}

      <div className="sched-preview" data-error={error ? true : undefined} role={error ? 'alert' : undefined}>
        {error ? <TriangleAlert size={14} strokeWidth={2} /> : <CalendarClock size={14} strokeWidth={2} />}
        <span>
          {error
            ? error
            : next === null
              ? 'This schedule never runs again.'
              : `Next run ${formatWhen(next, now)} · ${formatRelative(next, now)}`}
        </span>
      </div>
      {upcoming.length > 1 && (
        <ul className="sched-upcoming" aria-label="Runs after that">
          {upcoming.slice(1).map((at) => (
            <li key={at}>Then {formatWhen(at, now)}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
