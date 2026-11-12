import { useEffect, useState, type JSX } from 'react'
import { Clock, Timer } from 'lucide-react'
import { useMods, widgetsOf } from '../../state/mods'
import type { ModWidget } from '@shared/mods'
import { notify } from '../Notice'
import { playModSound } from '../../lib/modSounds'
import './mods.css'

/**
 * What the enabled mods put in the ADE's top bar: clocks in a time zone,
 * and countdown timers started with a click. Drawn by the app from the
 * mod's data; nothing here runs a mod's code.
 */
export function ModWidgets(): JSX.Element | null {
  const widgets = widgetsOf(useMods((s) => s.enabled))
  if (widgets.length === 0) return null
  return (
    <div className="mod-widgets">
      {widgets.map((widget) => (widget.kind === 'clock' ? <ClockWidget key={widget.key} widget={widget} /> : <TimerWidget key={widget.key} widget={widget} />))}
    </div>
  )
}

/** Re-renders every `ms`, lined up to the clock. */
function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const next = (): void => {
      timer = setTimeout(() => {
        setNow(Date.now())
        next()
      }, ms - (Date.now() % ms) + 5)
    }
    next()
    return () => clearTimeout(timer)
  }, [ms])
  return now
}

function ClockWidget({ widget }: { widget: Extract<ModWidget, { kind: 'clock' }> }): JSX.Element {
  const now = useTick(15_000)
  let time = ''
  try {
    time = new Intl.DateTimeFormat(undefined, { timeZone: widget.timeZone, hour: '2-digit', minute: '2-digit' }).format(now)
  } catch {
    time = '--:--'
  }
  return (
    <span className="mod-widget" title={`${widget.label} (${widget.timeZone})`}>
      <Clock size={13} strokeWidth={1.9} aria-hidden />
      <span className="mod-widget__label">{widget.label}</span>
      <span className="mod-widget__value">{time}</span>
    </span>
  )
}

const clock = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function TimerWidget({ widget }: { widget: Extract<ModWidget, { kind: 'timer' }> & { key: string } }): JSX.Element {
  const [endsAt, setEndsAt] = useState<number | null>(null)
  const now = useTick(1000)
  const left = endsAt ? endsAt - now : widget.minutes * 60_000
  useEffect(() => {
    if (endsAt && left <= 0) {
      setEndsAt(null)
      notify(`${widget.label}: ${widget.minutes} minutes are up`)
      playModSound('ade')
    }
  }, [endsAt, left, widget.label, widget.minutes])
  return (
    <button
      type="button"
      className="mod-widget mod-widget--button"
      data-running={endsAt ? true : undefined}
      title={endsAt ? 'Stop the timer' : `Start a ${widget.minutes} minute timer`}
      onClick={() => setEndsAt(endsAt ? null : Date.now() + widget.minutes * 60_000)}
    >
      <Timer size={13} strokeWidth={1.9} aria-hidden />
      <span className="mod-widget__label">{widget.label}</span>
      <span className="mod-widget__value">{clock(left)}</span>
    </button>
  )
}
