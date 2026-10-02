import { useState, type JSX } from 'react'
import { CalendarClock, ChevronDown, ChevronRight, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import type { TradingSchedule, TradingScheduleDraft, TradingSession, TradingSnapshot } from '@shared/trading'
import { Modal, Select, Switch } from '../ui'
import { clock, dayAndTime, direction, signedUsd, useTrading } from './tradingStore'

/**
 * When the agent trades: right now until a time the user picks, or in
 * windows that repeat on chosen days ("weekdays 9:30 to 4:00"). Past
 * sessions keep what the agent did and why, and what it made or lost.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS = [1, 2, 3, 4, 5]
const EVERY: { value: string; label: string }[] = [
  { value: '1', label: 'Every minute' },
  { value: '5', label: 'Every 5 min' },
  { value: '15', label: 'Every 15 min' },
  { value: '30', label: 'Every 30 min' },
  { value: '60', label: 'Every hour' }
]

const STRATEGY_HINT =
  'e.g. Swing-trade large-cap tech. Buy on pullbacks to the 20-day average when RSI is under 40, take profit at +4%, cut losses at −2%. Hold at most 4 stocks.'

/** Local "HH:MM" as today's (or tomorrow's) timestamp. */
function atTime(time: string): number {
  const [h, m] = time.split(':').map(Number)
  const at = new Date()
  at.setHours(h, m, 0, 0)
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1)
  return at.getTime()
}

function daysText(days: number[]): string {
  const sorted = [...days].sort()
  if (sorted.join() === WEEKDAYS.join()) return 'Weekdays'
  if (sorted.length === 7) return 'Every day'
  return sorted.map((d) => DAY_NAMES[d]).join(', ')
}

/** "9:30 AM" from "09:30". */
function timeText(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const at = new Date()
  at.setHours(h, m, 0, 0)
  return clock(at.getTime())
}

export function TradingSessions({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const [editing, setEditing] = useState<TradingSchedule | 'new' | null>(null)
  const past = snapshot.sessions.filter((s) => s.status !== 'running')
  return (
    <section className="tr-panel">
      <div className="tr-panel__head">
        <h2 className="tr-h2">Agent trading</h2>
        <button className="btn btn--sm" onClick={() => setEditing('new')}>
          <Plus size={13} strokeWidth={2} />
          New schedule
        </button>
      </div>

      {!snapshot.activeSession && <StartNow snapshot={snapshot} />}

      <div className="tr-sub">Schedules</div>
      {snapshot.schedules.length === 0 ? (
        <p className="tr-empty">No schedules. A schedule has Eaon trade on its own in a window you choose, such as weekdays from market open to close.</p>
      ) : (
        <ul className="tr-list">
          {snapshot.schedules.map((schedule) => (
            <ScheduleRow key={schedule.id} schedule={schedule} onEdit={() => setEditing(schedule)} />
          ))}
        </ul>
      )}

      {past.length > 0 && (
        <>
          <div className="tr-sub">Past sessions</div>
          <ul className="tr-list">
            {past.slice(0, 12).map((session) => (
              <PastSession key={session.id} session={session} />
            ))}
          </ul>
        </>
      )}

      {snapshot.activeSession && <SessionLog session={snapshot.activeSession} open />}

      {editing && <ScheduleEditor schedule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  )
}

function StartNow({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const run = useTrading((s) => s.run)
  const [strategy, setStrategy] = useState('')
  const [until, setUntil] = useState(() => (new Date().getHours() < 13 ? '16:00' : '23:00'))
  const [every, setEvery] = useState('5')
  const [flatten, setFlatten] = useState(false)
  return (
    <div className="tr-start">
      <label className="tr-field">
        <span>Strategy</span>
        <textarea className="input" rows={3} value={strategy} placeholder={STRATEGY_HINT} onChange={(e) => setStrategy(e.target.value)} />
      </label>
      <div className="tr-start__row">
        <label className="tr-field tr-field--inline">
          <span>Trade until</span>
          <input className="input tr-time" type="time" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        <Select value={every} options={EVERY} onChange={setEvery} width={150} />
        <label className="tr-field tr-field--inline tr-switch-field">
          <Switch label="Sell everything at the end" checked={flatten} onChange={setFlatten} />
          <span>Sell all at the end</span>
        </label>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn--primary"
          disabled={!strategy.trim() || !/^\d{2}:\d{2}$/.test(until) || snapshot.config.halted}
          onClick={() =>
            void run(() => window.api.trading.startSession({ strategy: strategy.trim(), until: atTime(until), everyMinutes: Number(every), flattenAtEnd: flatten })).then(
              (session) => session && setStrategy('')
            )
          }
        >
          <Play size={13} strokeWidth={2} />
          Start trading
        </button>
      </div>
    </div>
  )
}

function ScheduleRow({ schedule, onEdit }: { schedule: TradingSchedule; onEdit: () => void }): JSX.Element {
  const run = useTrading((s) => s.run)
  return (
    <li className="tr-row">
      <CalendarClock size={16} strokeWidth={1.8} className="tr-row__icon" />
      <div className="tr-row__body">
        <div className="tr-row__title">{schedule.name}</div>
        <div className="tr-row__desc">
          {daysText(schedule.days)} · {timeText(schedule.start)} – {timeText(schedule.end)} · every {schedule.everyMinutes} min
          {schedule.flattenAtEnd ? ' · sells all at the end' : ''}
        </div>
        <div className="tr-row__strategy">{schedule.strategy}</div>
      </div>
      <Switch
        label={`${schedule.name} on`}
        checked={schedule.enabled}
        onChange={(enabled) => void run(() => window.api.trading.saveSchedule({ ...schedule, enabled }))}
      />
      <button className="icon-btn" aria-label={`Edit ${schedule.name}`} onClick={onEdit}>
        <Pencil size={14} strokeWidth={1.9} />
      </button>
      <button className="icon-btn" aria-label={`Remove ${schedule.name}`} onClick={() => void run(() => window.api.trading.removeSchedule(schedule.id))}>
        <Trash2 size={14} strokeWidth={1.9} />
      </button>
    </li>
  )
}

function ScheduleEditor({ schedule, onClose }: { schedule: TradingSchedule | null; onClose: () => void }): JSX.Element {
  const run = useTrading((s) => s.run)
  const [draft, setDraft] = useState<TradingScheduleDraft>(
    schedule ?? { name: 'Market hours', days: WEEKDAYS, start: '09:30', end: '16:00', strategy: '', everyMinutes: 5, flattenAtEnd: false, enabled: true }
  )
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<TradingScheduleDraft>): void => setDraft((d) => ({ ...d, ...patch }))
  const valid = draft.name.trim() && draft.strategy.trim() && draft.days.length > 0 && draft.start < draft.end
  return (
    <Modal
      open
      onClose={onClose}
      title={schedule ? 'Edit schedule' : 'New trading schedule'}
      width={520}
      actions={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!valid}
            onClick={async () => {
              setError(null)
              try {
                await window.api.trading.saveSchedule(draft)
                void run(() => window.api.trading.snapshot())
                onClose()
              } catch (e) {
                setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
              }
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="tr-editor">
        <label className="tr-field">
          <span>Name</span>
          <input className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <div className="tr-field">
          <span>Days</span>
          <div className="tr-days" role="group" aria-label="Days">
            {DAY_NAMES.map((name, day) => (
              <button
                key={name}
                type="button"
                className="tr-day"
                aria-pressed={draft.days.includes(day)}
                onClick={() => set({ days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day].sort() })}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        <div className="tr-editor__row">
          <label className="tr-field">
            <span>From</span>
            <input className="input tr-time" type="time" value={draft.start} onChange={(e) => set({ start: e.target.value })} />
          </label>
          <label className="tr-field">
            <span>Until</span>
            <input className="input tr-time" type="time" value={draft.end} onChange={(e) => set({ end: e.target.value })} />
          </label>
          <div className="tr-field">
            <span>Check</span>
            <Select value={String(draft.everyMinutes)} options={EVERY} onChange={(v) => set({ everyMinutes: Number(v) })} width={150} />
          </div>
        </div>
        <p className="tr-muted tr-hint">Times are your computer’s clock. US stock markets trade 9:30 AM – 4:00 PM New York time, weekdays.</p>
        <label className="tr-field">
          <span>Strategy</span>
          <textarea className="input" rows={4} value={draft.strategy} placeholder={STRATEGY_HINT} onChange={(e) => set({ strategy: e.target.value })} />
        </label>
        <label className="tr-switch-field">
          <Switch label="Sell everything when the window closes" checked={draft.flattenAtEnd} onChange={(flattenAtEnd) => set({ flattenAtEnd })} />
          <span>Sell everything when the window closes</span>
        </label>
        {error && <p className="tr-error">{error}</p>}
      </div>
    </Modal>
  )
}

function PastSession({ session }: { session: TradingSession }): JSX.Element {
  const [open, setOpen] = useState(false)
  const change = (session.endEquity ?? session.startEquity) - session.startEquity
  return (
    <li className="tr-past">
      <button className="tr-row tr-row--button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
        <div className="tr-row__body">
          <div className="tr-row__title">{session.name}</div>
          <div className="tr-row__desc">
            {dayAndTime(session.startedAt)} – {clock(session.endedAt ?? session.endsAt)} · {session.orders} order{session.orders === 1 ? '' : 's'} ·{' '}
            {session.status === 'failed' ? 'stopped by an error' : session.status === 'stopped' ? 'stopped' : 'finished'}
          </div>
        </div>
        <span className="tr-delta" data-dir={direction(change)}>
          {signedUsd(change)}
        </span>
      </button>
      {open && <SessionLog session={session} />}
    </li>
  )
}

function SessionLog({ session, open = false }: { session: TradingSession; open?: boolean }): JSX.Element {
  const entries = [...session.log].reverse()
  return (
    <div className="tr-log" data-open={open || undefined}>
      {open && <div className="tr-sub">What Eaon is doing</div>}
      {session.summary && <p className="tr-log__summary">{session.summary}</p>}
      {session.error && <p className="tr-error">{session.error}</p>}
      {entries.length === 0 ? (
        <p className="tr-empty">Nothing yet — the first check runs within a minute of the start.</p>
      ) : (
        <ol className="tr-log__list">
          {entries.slice(0, 60).map((entry, i) => (
            <li key={`${entry.at}-${i}`} data-kind={entry.kind}>
              <span className="tr-log__time">{clock(entry.at)}</span>
              <span className="tr-log__text">{entry.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
