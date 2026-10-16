import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, CreditCard, PackageSearch, Repeat, ShieldCheck, ShoppingBag } from 'lucide-react'
import { formatMoney, type PaymentsStatus } from '@shared/payments'
import type { ScheduledTask } from '@shared/scheduler'
import { revealChat, useApp } from '../../state/store'
import { Modal, Segmented, Switch } from '../ui'
import { DayPicker } from './DayPicker'
import { usePurchaseDialog } from './purchaseStore'
import {
  amountOf,
  atTime,
  buildPurchasePlan,
  CADENCE_HOURS,
  CADENCE_LABEL,
  CADENCE_PHRASE,
  startOfDay,
  storeSite,
  type Cadence,
  type PurchaseForm
} from './plan'
import '../../styles/purchase.css'

/**
 * Purchase schedule: what the agent should buy, where, for at most how much,
 * how often, and from which day. Saving is the user's approval for each of
 * its orders within exactly those bounds; today as the start day places the
 * first order right away and opens its chat to watch it happen.
 */

const DAY = 24 * 60 * 60_000
const CADENCES: Cadence[] = ['once', 'daily', 'weekly', 'biweekly', 'monthly']

function cadenceOf(task: ScheduledTask): Cadence {
  if (task.schedule.kind !== 'interval') return 'once'
  const hours = task.schedule.unit === 'hours' ? task.schedule.every : task.schedule.every / 60
  return (Object.keys(CADENCE_HOURS) as Exclude<Cadence, 'once'>[]).find((c) => CADENCE_HOURS[c] === hours) ?? 'weekly'
}

const pad = (n: number): string => String(n).padStart(2, '0')

function formFor(task: ScheduledTask | null, currency: string): PurchaseForm {
  const now = Date.now()
  if (!task?.purchase) {
    return {
      item: '',
      site: '',
      maxAmount: '',
      currency,
      notes: '',
      cadence: 'weekly',
      startDay: startOfDay(now),
      time: '09:00',
      limited: false,
      orders: '4',
      track: true
    }
  }
  const plan = task.purchase
  const next = task.nextRunAt ?? (task.schedule.kind === 'once' ? task.schedule.at : now)
  const at = new Date(next)
  return {
    item: plan.item,
    site: plan.site,
    maxAmount: plan.maxAmount.toFixed(2),
    currency: plan.currency,
    notes: plan.notes,
    cadence: cadenceOf(task),
    startDay: startOfDay(Math.max(next, now)),
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
    limited: plan.orders !== null && task.schedule.kind === 'interval',
    orders: String(plan.orders ?? 4),
    track: plan.track
  }
}

const dayLabel = (day: number, now: number): string => {
  const today = startOfDay(now)
  if (day === today) return 'Today'
  // Midday tomorrow, so a daylight-saving day of 23 or 25 hours still lands on it.
  if (day === startOfDay(today + 36 * 60 * 60_000)) return 'Tomorrow'
  return new Date(day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

const clock = (time: string): string => new Date(atTime(startOfDay(Date.now()), time)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function PurchaseDialog(): JSX.Element | null {
  const { open, task, close } = usePurchaseDialog()
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  const [payments, setPayments] = useState<PaymentsStatus | null>(null)
  const [form, setForm] = useState<PurchaseForm>(() => formFor(null, 'USD'))
  // Editing: the timing stays as it is until one of its fields is touched.
  const [timingTouched, setTimingTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A new schedule gets its own thread each time the dialog opens; the dialog itself stays mounted.
  const [threadId, setThreadId] = useState(() => crypto.randomUUID())

  useEffect(() => {
    if (!open) return
    setError(null)
    setSaving(false)
    setTimingTouched(false)
    setThreadId(crypto.randomUUID())
    void window.api.payments.status().then((status) => {
      setPayments(status)
      setForm(formFor(task, status.currency))
    })
    return window.api.payments.onChanged(setPayments)
  }, [open, task])

  const now = Date.now()
  const set = (patch: Partial<PurchaseForm>, timing = false): void => {
    setForm((f) => ({ ...f, ...patch }))
    if (timing) setTimingTouched(true)
  }
  const keep = task && !timingTouched ? task.schedule : null
  const built = useMemo(() => buildPurchasePlan(form, Date.now(), threadId, task, keep), [form, threadId, task, keep])
  const ready = payments?.effectiveMode !== undefined && payments.effectiveMode !== 'off'
  const site = storeSite(form.site)
  const amount = amountOf(form.maxAmount)
  const money = Number.isFinite(amount) && amount > 0 ? formatMoney(amount, form.currency) : null
  const symbol = form.currency === 'USD' ? '$' : form.currency
  const recurring = form.cadence !== 'once'
  const today = startOfDay(now)
  const isToday = !keep && form.startDay <= today

  const save = async (): Promise<void> => {
    if (built.error || saving || !ready) return
    setSaving(true)
    setError(null)
    try {
      const saved = await window.api.scheduler.save(built.draft)
      if (built.buyNow) {
        await window.api.scheduler.runNow(saved.id)
        // The run's chat arrives from main a moment later: open it once it's here.
        const thread = saved.thread
        if (thread) {
          const reveal = (): boolean => {
            if (!useApp.getState().chats.some((c) => c.id === thread)) return false
            revealChat(thread)
            return true
          }
          if (!reveal()) {
            const stop = useApp.subscribe(() => reveal() && stop())
            setTimeout(stop, 10_000)
          }
        }
      }
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
      setSaving(false)
    }
  }

  const lastOrder =
    recurring && form.limited && Number(form.orders) > 1
      ? atTime(form.startDay, form.time) + (Number(form.orders) - 1) * CADENCE_HOURS[form.cadence as Exclude<Cadence, 'once'>] * 60 * 60_000
      : null

  const primary = !ready
    ? 'Schedule'
    : keep
      ? 'Save changes'
      : isToday
        ? recurring
          ? 'Buy now and schedule'
          : 'Buy now'
        : 'Schedule purchases'

  return (
    <Modal
      open={open}
      onClose={close}
      title={task ? 'Edit purchase schedule' : 'Purchase schedule'}
      width={560}
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={Boolean(built.error) || saving || !ready} onClick={() => void save()}>
            {isToday && ready && !keep && <ShoppingBag size={14} strokeWidth={2} />}
            {saving ? 'Saving…' : primary}
          </button>
        </>
      }
    >
      <div className="purchase">
        <p className="purchase__lede">The agent buys this for you on a schedule, with your saved card, and keeps an eye on each order until it arrives.</p>

        {payments && !ready && (
          <div className="purchase__notice" role="status">
            <CreditCard size={15} strokeWidth={1.9} />
            <span>Add a card in Payments first. Scheduled orders are paid with it.</span>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                close()
                setSettingsPage('payments')
              }}
            >
              Set up payments
            </button>
          </div>
        )}

        <label className="purchase__field">
          <span className="purchase__label">What to buy</span>
          <input
            className="input"
            autoFocus
            placeholder="2 bags of Lavazza Super Crema, 2.2 lb"
            value={form.item}
            onChange={(e) => set({ item: e.target.value })}
          />
        </label>

        <div className="purchase__pair">
          <label className="purchase__field">
            <span className="purchase__label">Store website</span>
            <input
              className="input"
              placeholder="amazon.com"
              spellCheck={false}
              value={form.site}
              onChange={(e) => set({ site: e.target.value })}
              onBlur={() => site && site !== form.site && set({ site })}
              aria-invalid={Boolean(form.site.trim()) && !site}
            />
          </label>
          <label className="purchase__field">
            <span className="purchase__label">Most per order</span>
            <span className="purchase__money">
              <span className="purchase__currency" aria-hidden>
                {symbol}
              </span>
              <input
                className="input"
                inputMode="decimal"
                placeholder="45.00"
                value={form.maxAmount}
                onChange={(e) => set({ maxAmount: e.target.value.replace(/[^0-9.]/g, '') })}
                onBlur={() => Number.isFinite(amount) && amount > 0 && set({ maxAmount: amount.toFixed(2) })}
                aria-label={`Most per order, in ${form.currency}`}
              />
            </span>
          </label>
        </div>

        <label className="purchase__field">
          <span className="purchase__label">
            Notes <span className="purchase__optional">optional</span>
          </span>
          <input
            className="input"
            placeholder="Subscribe & Save if offered. No substitutions."
            value={form.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </label>

        <div className="purchase__field">
          <span className="purchase__label">How often</span>
          <Segmented value={form.cadence} onChange={(cadence) => set({ cadence }, true)} options={CADENCES.map((c) => ({ value: c, label: CADENCE_LABEL[c] }))} />
        </div>

        <div className="purchase__when">
          <div className="purchase__field">
            <span className="purchase__label">{recurring ? 'Start the cycle on' : 'Buy on'}</span>
            <DayPicker value={form.startDay} min={today} max={today + 365 * DAY} onChange={(startDay) => set({ startDay }, true)} />
          </div>

          <div className="purchase__side">
            <div className="purchase__day" data-today={isToday || undefined}>
              <span className="purchase__day-name">{keep ? 'Next order' : dayLabel(form.startDay, now)}</span>
              <span className="purchase__day-note">
                {keep
                  ? built.nextAt
                    ? new Date(built.nextAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                    : 'None scheduled'
                  : isToday
                    ? 'Orders right away'
                    : `Orders at ${clock(form.time)}`}
              </span>
            </div>

            {(recurring || !isToday) && (
              <label className="purchase__inline">
                <span>{isToday ? 'Later orders at' : 'Order at'}</span>
                <input className="input purchase__time" type="time" value={form.time} onChange={(e) => set({ time: e.target.value || '09:00' }, true)} />
              </label>
            )}

            {recurring && (
              <div className="purchase__inline purchase__inline--stack">
                <Segmented
                  value={form.limited ? 'limited' : 'open'}
                  onChange={(v) => set({ limited: v === 'limited' })}
                  options={[
                    { value: 'open', label: 'Until I stop' },
                    { value: 'limited', label: 'Set number' }
                  ]}
                />
                {form.limited && (
                  <label className="purchase__count">
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={520}
                      value={form.orders}
                      onChange={(e) => set({ orders: e.target.value })}
                      aria-label="Number of orders"
                    />
                    <span>orders in all</span>
                  </label>
                )}
              </div>
            )}

            <label className="purchase__track">
              <span className="purchase__track-text">
                <span>Track each order</span>
                <span className="purchase__hint">Follows the order number until it’s delivered</span>
              </span>
              <Switch checked={form.track} onChange={(track) => set({ track })} label="Track each order" />
            </label>
          </div>
        </div>

        <dl className="purchase__receipt" aria-label="Summary">
          <div>
            <dt>
              <CalendarDays size={14} strokeWidth={1.9} />
              First order
            </dt>
            <dd>
              {keep
                ? 'Already started'
                : isToday
                  ? 'Today, right away'
                  : new Date(atTime(form.startDay, form.time)).toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </dd>
          </div>
          {recurring && (
            <div>
              <dt>
                <Repeat size={14} strokeWidth={1.9} />
                Then
              </dt>
              <dd>
                {CADENCE_PHRASE[form.cadence as Exclude<Cadence, 'once'>]}
                {form.limited && lastOrder
                  ? `, last on ${new Date(lastOrder).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
                  : form.limited
                    ? ''
                    : ', until you stop it'}
              </dd>
            </div>
          )}
          <div>
            <dt>
              <ShieldCheck size={14} strokeWidth={1.9} />
              Each order
            </dt>
            <dd>
              {money ? `Up to ${money}` : 'Set a maximum'}
              {site ? ` on ${site}` : ''}
            </dd>
          </div>
          {form.track && (
            <div>
              <dt>
                <PackageSearch size={14} strokeWidth={1.9} />
                After
              </dt>
              <dd>Tracks the order number twice a day and tells you when it ships and arrives</dd>
            </div>
          )}
          {payments?.card && (
            <div>
              <dt>
                <CreditCard size={14} strokeWidth={1.9} />
                Paid with
              </dt>
              <dd>
                {payments.card.brand} •••• {payments.card.last4}
              </dd>
            </div>
          )}
        </dl>

        <p className="purchase__fine">
          Saving approves each order in advance, so the agent won’t ask you first. It buys only this{site ? `, only on ${site}` : ''}, and never over{' '}
          {money ?? 'the maximum'} an order. Pause or delete it any time in Scheduled.
        </p>

        {(error || (built.error && (form.item || form.site || form.maxAmount))) && (
          <p className="purchase__error" role="alert">
            {error ?? built.error}
          </p>
        )}
      </div>
    </Modal>
  )
}
