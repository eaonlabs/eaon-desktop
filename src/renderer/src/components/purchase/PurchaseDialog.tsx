import { useEffect, useMemo, useState } from 'react'
import { Bot, CalendarDays, CreditCard, PackageSearch, Repeat, ShieldCheck, ShoppingBag } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { formatMoney, type PaymentsStatus } from '@shared/payments'
import type { Worker, WorkerRoutine } from '@shared/workers'
import { useApp } from '../../state/store'
import { useWorkers } from '../workers/workersStore'
import { WorkerFace } from '../workers/WorkerFace'
import { Modal, Segmented, Select, Switch } from '../ui'
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
 * Purchase schedule: which worker buys what, where, for at most how much,
 * how often, and from which day. It is saved as one of that worker's
 * routines, and saving is the user's approval for each of its orders within
 * exactly those bounds. Today as the start day places the first order right
 * away and opens the worker to watch it happen. A maximum of 0 is for free
 * orders, which need no card.
 */

const DAY = 24 * 60 * 60_000
const CADENCES: Cadence[] = ['once', 'daily', 'weekly', 'biweekly', 'monthly']

function cadenceOf(routine: WorkerRoutine): Cadence {
  if (!routine.everyMs) return 'once'
  const hours = routine.everyMs / (60 * 60_000)
  return (Object.keys(CADENCE_HOURS) as Exclude<Cadence, 'once'>[]).find((c) => CADENCE_HOURS[c] === hours) ?? 'weekly'
}

/** A worker that can place orders: one on Eaon's own loop (an agent engine has no Eaon browser or card). */
const canBuy = (w: Worker): boolean => !w.engine || w.engine === 'native'

const pad = (n: number): string => String(n).padStart(2, '0')

function formFor(routine: WorkerRoutine | null, currency: string): PurchaseForm {
  const now = Date.now()
  if (!routine?.purchase) {
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
  const plan = routine.purchase
  const next = routine.nextAt
  const at = new Date(routine.anchorAt ?? next)
  return {
    item: plan.item,
    site: plan.site,
    maxAmount: plan.maxAmount.toFixed(2),
    currency: plan.currency,
    notes: plan.notes,
    cadence: cadenceOf(routine),
    startDay: startOfDay(Math.max(next, now)),
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
    limited: plan.orders !== null && routine.everyMs !== null,
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
  const { open, workerId: openedFor, routine, close } = usePurchaseDialog()
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  const { workers, select, selectThread } = useWorkers(useShallow((s) => ({ workers: s.workers, select: s.select, selectThread: s.selectThread })))
  const buyers = workers.filter(canBuy)
  const [payments, setPayments] = useState<PaymentsStatus | null>(null)
  const [form, setForm] = useState<PurchaseForm>(() => formFor(null, 'USD'))
  const [workerId, setWorkerId] = useState<string | null>(null)
  // Editing: the timing stays as it is until one of its fields is touched.
  const [timingTouched, setTimingTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    // Reset at once, not when payments answer: until then the dialog would
    // show the last schedule's fields (and never stop, if they didn't answer).
    setError(null)
    setSaving(false)
    setTimingTouched(false)
    setForm(formFor(routine, payments?.currency ?? 'USD'))
    void useWorkers.getState().init()
    let live = true
    window.api.payments
      .status()
      .then((status) => {
        if (!live) return
        setPayments(status)
        // A new schedule is in the user's currency; an edited one keeps its own.
        if (!routine?.purchase) setForm((f) => ({ ...f, currency: status.currency }))
      })
      .catch((e: unknown) => live && setError(`Couldn’t read your payment settings: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)}`))
    const unsubscribe = window.api.payments.onChanged(setPayments)
    return () => {
      live = false
      unsubscribe()
    }
    // The currency is only a starting guess; payments changing must not reset what the user typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, routine])

  // The worker it was opened from, else the one on screen, else the first that can buy.
  useEffect(() => {
    if (!open) return
    const fits = (id: string | null | undefined): boolean => Boolean(id && buyers.some((w) => w.id === id))
    const onScreen = useWorkers.getState().selectedId
    setWorkerId(fits(openedFor) ? openedFor : fits(onScreen) ? onScreen : (buyers[0]?.id ?? null))
    // Only when it opens: picking another worker is the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openedFor, buyers.length])

  const now = Date.now()
  const set = (patch: Partial<PurchaseForm>, timing = false): void => {
    setForm((f) => ({ ...f, ...patch }))
    if (timing) setTimingTouched(true)
  }
  // Editing keeps the routine's own timing until a timing field is touched.
  const keep = routine && !timingTouched ? routine : null
  const built = useMemo(() => buildPurchasePlan(form, Date.now(), routine, timingTouched), [form, routine, timingTouched])
  const cardReady = Boolean(payments?.card) && payments?.effectiveMode !== undefined && payments.effectiveMode !== 'off'
  const site = storeSite(form.site)
  const amount = amountOf(form.maxAmount)
  const free = amount === 0
  // A card only matters for orders that cost something; free ones (a maximum of 0) need none.
  const needsCard = Number.isFinite(amount) && amount > 0 && !cardReady
  const worker = buyers.find((w) => w.id === workerId) ?? null
  const ready = !needsCard && worker !== null
  const money = Number.isFinite(amount) && amount > 0 ? formatMoney(amount, form.currency) : null
  const symbol = form.currency === 'USD' ? '$' : form.currency
  const recurring = form.cadence !== 'once'
  const today = startOfDay(now)
  // Only a new schedule buys on the spot; an edit moves the next order instead.
  const isToday = !routine && form.startDay <= today

  const save = async (): Promise<void> => {
    if (built.error || saving || !ready || !worker) return
    setSaving(true)
    setError(null)
    try {
      const saved = await window.api.workers.savePurchase(worker.id, built.draft)
      if (built.buyNow) {
        // To the worker, and to the schedule's thread once its first run has made it.
        select(worker.id)
        const app = useApp.getState()
        const tab = app.workspaces.find((w) => w.kind === 'workers')
        if (tab && app.settings?.activeWorkspaceId !== tab.id) app.setWorkspace(tab.id)
        if (app.view !== 'chat') app.setView('chat')
        const reveal = (): boolean => {
          const thread = useWorkers.getState().workers.find((w) => w.id === worker.id)?.threads.find((t) => t.routineId === saved.id)
          if (!thread) return false
          selectThread(worker.id, thread.id)
          return true
        }
        if (!reveal()) {
          const stop = useWorkers.subscribe(() => reveal() && stop())
          setTimeout(stop, 15_000)
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
    : routine
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
      title={routine ? 'Edit purchase schedule' : 'Purchase schedule'}
      width={560}
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={Boolean(built.error) || saving || !ready} onClick={() => void save()}>
            {isToday && ready && <ShoppingBag size={14} strokeWidth={2} />}
            {saving ? 'Saving…' : primary}
          </button>
        </>
      }
    >
      <div className="purchase">
        <p className="purchase__lede">A worker buys this for you on a schedule, with its own browser, and keeps an eye on each order until it arrives.</p>

        {workers.length > 0 && buyers.length === 0 && (
          <div className="purchase__notice" role="status">
            <Bot size={15} strokeWidth={1.9} />
            <span>Your workers run on other agent engines, which can’t use Eaon’s browser and card. Make a worker that runs on Eaon to buy for you.</span>
          </div>
        )}
        {workers.length === 0 && (
          <div className="purchase__notice" role="status">
            <Bot size={15} strokeWidth={1.9} />
            <span>Purchases are made by a worker. Make one in Workers first.</span>
          </div>
        )}

        {buyers.length > 0 && (
          <div className="purchase__field">
            <span className="purchase__label">Who buys it</span>
            {routine ? (
              <span className="purchase__worker">
                {worker && <WorkerFace color={worker.color} size={18} />}
                {worker?.name ?? 'Its worker'}
              </span>
            ) : (
              <Select
                value={workerId ?? ''}
                onChange={(id) => setWorkerId(id)}
                options={buyers.map((w) => ({ value: w.id, label: w.name, icon: <WorkerFace color={w.color} size={16} /> }))}
              />
            )}
          </div>
        )}

        {payments && needsCard && (
          <div className="purchase__notice" role="status">
            <CreditCard size={15} strokeWidth={1.9} />
            <span>Orders that cost something are paid with your card, so add one in Payments. Free orders (a maximum of 0) don’t need one.</span>
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
                onBlur={() => Number.isFinite(amount) && set({ maxAmount: amount.toFixed(2) })}
                aria-label={`Most per order, in ${form.currency}`}
                aria-describedby="purchase-free-hint"
              />
            </span>
            <span className="purchase__hint" id="purchase-free-hint">
              {free ? 'Free orders only. No card needed.' : '0 for free orders'}
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
              <span className="purchase__day-name">{routine ? 'Next order' : dayLabel(form.startDay, now)}</span>
              <span className="purchase__day-note">
                {routine
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
              {routine && !keep ? 'Next order' : 'First order'}
            </dt>
            <dd>
              {keep
                ? 'Already started'
                : isToday
                  ? 'Today, right away'
                  : new Date(built.draft.firstAt).toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
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
              {free ? 'Free only, never charged' : money ? `Up to ${money}` : 'Set a maximum'}
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
          {payments?.card && !free && (
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
          Saving approves each order in advance, so {worker?.name ?? 'the worker'} won’t ask you first. It buys only this{site ? `, only on ${site}` : ''},{' '}
          {free ? 'and only when the order is free' : `and never over ${money ?? 'the maximum'} an order`}. Stop it any time from {worker?.name ?? 'the worker'}’s routines. Sign{' '}
          {worker?.name ?? 'the worker'}’s browser in to the store first: it won’t type passwords.
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
