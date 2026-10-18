import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { startOfDay } from './plan'

/**
 * A month of days to pick one from: the start of a purchase schedule. Days
 * before `min` can't be picked, and neither can anything past `max`. Today
 * carries a ring; the picked day is filled. Arrow keys move the pick by a
 * day or a week, the way a calendar grid is expected to.
 */

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

const addDays = (day: number, n: number): number => {
  const d = new Date(day)
  d.setDate(d.getDate() + n)
  return startOfDay(d.getTime())
}

const monthOf = (day: number): number => {
  const d = new Date(day)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

const addMonths = (month: number, n: number): number => {
  const d = new Date(month)
  return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime()
}

export function DayPicker({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (day: number) => void }): JSX.Element {
  const [month, setMonth] = useState(() => monthOf(value))
  // A day set from outside (the dialog opening on another schedule) brings its month into view.
  useEffect(() => setMonth(monthOf(value)), [value])
  const first = new Date(month)
  const lead = first.getDay()
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const today = startOfDay(Date.now())
  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(first.getFullYear(), first.getMonth(), i + 1).getTime())
  ]
  const canBack = month > monthOf(min)
  const canForward = addMonths(month, 1) <= max

  const pick = (day: number): void => {
    if (day < min || day > max) return
    onChange(day)
    if (monthOf(day) !== month) setMonth(monthOf(day))
  }

  const onKey = (event: React.KeyboardEvent): void => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]
    if (!step) return
    event.preventDefault()
    pick(Math.min(max, Math.max(min, addDays(value, step))))
    // Keep focus on the picked day as it moves, including into another month.
    requestAnimationFrame(() => (document.querySelector('.daypick__day[data-picked]') as HTMLElement | null)?.focus())
  }

  return (
    <div className="daypick">
      <div className="daypick__head">
        <span className="daypick__month">{first.toLocaleDateString([], { month: 'long', year: 'numeric' })}</span>
        <button type="button" className="icon-btn" aria-label="Previous month" disabled={!canBack} onClick={() => setMonth(addMonths(month, -1))}>
          <ChevronLeft size={15} strokeWidth={2} />
        </button>
        <button type="button" className="icon-btn" aria-label="Next month" disabled={!canForward} onClick={() => setMonth(addMonths(month, 1))}>
          <ChevronRight size={15} strokeWidth={2} />
        </button>
      </div>
      <div className="daypick__grid" role="grid" aria-label="Start day" onKeyDown={onKey}>
        {WEEKDAYS.map((d, i) => (
          <span key={i} className="daypick__weekday" aria-hidden>
            {d}
          </span>
        ))}
        {cells.map((day, i) =>
          day === null ? (
            <span key={`pad${i}`} />
          ) : (
            <button
              key={day}
              type="button"
              role="gridcell"
              className="daypick__day"
              disabled={day < min || day > max}
              data-today={day === today || undefined}
              data-picked={day === value || undefined}
              aria-selected={day === value}
              aria-label={new Date(day).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + (day === today ? ', today' : '')}
              tabIndex={day === value ? 0 : -1}
              onClick={() => pick(day)}
            >
              {new Date(day).getDate()}
            </button>
          )
        )}
      </div>
    </div>
  )
}
