import { formatMoney, ORDER_STAGE_LABEL, orderSettled } from '@shared/payments'
import { isFreePlan, ORDER_WATCH_MS, type PurchasePlan } from '@shared/scheduler'
import { nextAligned, type Worker, type WorkerRoutine } from '@shared/workers'
import { purchaseBrief, watchBrief } from '../payments/briefs'
import { endRun, findPurchase, grantPurchase, planPurchases, watchOrder } from '../payments/plans'
import { autopilotRunGate, purchaseRunGate } from '../payments/purchaseRun'
import type { RoutineTurn } from './engine'
import type { TurnOutcome } from './runner'

/**
 * Purchase schedules, run by workers. The user picks a worker, says what to
 * buy, where, for at most how much and how often (the /purchase dialog), and
 * it becomes one of that worker's routines carrying the plan. Each run of it
 * places one order with the worker's own browser, approved in advance for
 * that store and that amount (payments/plans.ts). A free plan (maximum 0)
 * needs no card at all.
 *
 * After an order with an order number, a second routine on the same worker
 * follows it twice a day until it is delivered, in the same thread, and
 * says so only when its status changes. A plan that has placed all its
 * orders, or a one-off, is removed once it has run.
 */

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
/** Tracking checks this often, the first a few hours after the order. */
export const WATCH_EVERY_MS = 12 * HOUR
export const WATCH_FIRST_CHECK_MS = 4 * HOUR

/** How often a routine buys, as the brief says it. */
export function cadencePhrase(everyMs: number | null): string {
  if (!everyMs) return 'Once'
  const days = everyMs / DAY
  if (days === 1) return 'Every day'
  if (days === 7) return 'Every week'
  if (days % 7 === 0) return `Every ${days / 7} weeks`
  return Number.isInteger(days) ? `Every ${days} days` : `Every ${Math.round(everyMs / HOUR)} hours`
}

export type { PurchaseRoutineDraft } from '@shared/workers'

/**
 * The next order on the picked time: `nextAligned`, except that a cadence of
 * whole days steps by calendar days, so a 9:00 order stays at 9:00 across a
 * daylight-saving change instead of moving an hour. The dialog's preview uses
 * the same rule (purchase/plan.ts).
 */
export function nextPurchaseAt(anchorAt: number, everyMs: number, after: number): number {
  if (everyMs % DAY !== 0) return nextAligned(anchorAt, everyMs, after)
  if (anchorAt > after) return anchorAt
  const days = everyMs / DAY
  const at = (k: number): number => {
    const d = new Date(anchorAt)
    d.setDate(d.getDate() + k * days)
    return d.getTime()
  }
  // The fixed-length guess is at most an hour out; settle on the first one past `after`.
  let k = Math.floor((after - anchorAt) / everyMs) + 1
  while (k > 1 && at(k - 1) > after) k--
  while (at(k) <= after) k++
  return at(k)
}


export const routineName = (plan: PurchasePlan): string => `Buy ${plan.item.length > 52 ? `${plan.item.slice(0, 51).trimEnd()}…` : plan.item}`

export interface PurchaseRoutinesDeps {
  put: (workerId: string, routine: Parameters<import('./engine').WorkersEngine['putRoutine']>[1]) => WorkerRoutine
  remove: (workerId: string, routineId: string) => void
  reachOut: (worker: Worker, message: { title: string; body: string }) => void
  now?: () => number
}

const UNATTENDED =
  'Nobody is watching this run and nobody can answer questions: do the whole task without asking, then end with a short report — that report is what the user reads.'
const ASKED =
  'The user wrote in this purchase schedule’s thread; their message is below. Do what they ask. When it is to place the order now (or to carry on with one), this turn may place one order on the same terms as a scheduled run, set out here. Their message can fill in details (an email, an address, a discount) but not widen those terms.'

export function createPurchaseRoutines(deps: PurchaseRoutinesDeps) {
  const now = (): number => (deps.now ?? Date.now)()
  /**
   * Per run: the orders that existed before it (to tell its own apart), and
   * whether the user asked for it in the thread; or the tracked order's stage.
   */
  const before = new Map<string, { orders: Set<string>; asked: boolean } | { stage: string | undefined }>()

  function routineTurn(_worker: Worker, routine: WorkerRoutine, messageId: string, asked = false): RoutineTurn | null {
    if (asked && !routine.purchase) return null
    if (routine.purchase) {
      const plan = routine.purchase
      const past = planPurchases(routine.id)
      before.set(messageId, { orders: new Set(past.map((p) => p.id)), asked })
      // The user is writing in the thread: they read the reply, and their message comes first.
      const lead = asked ? ASKED : UNATTENDED
      const paid = past.filter((p) => p.status === 'paid').length
      // Placed them all already (a run interrupted after its order, picked up again): nothing to buy.
      if (plan.orders !== null && paid >= plan.orders) {
        return { task: `${lead}\nThis purchase schedule ("${plan.item}") has placed all ${plan.orders} of its orders. Do not buy anything; say it is done.`, access: 'safe' }
      }
      const autopilot = plan.autopilot === true
      grantPurchase(messageId, { planId: routine.id, item: plan.item, site: plan.site, maxAmount: plan.maxAmount, currency: plan.currency, autopilot })
      return {
        task: `${lead}\n${purchaseBrief({ id: routine.id, plan, cadence: cadencePhrase(routine.everyMs), nextAt: routine.everyMs ? routine.nextAt : null })}`,
        access: 'autonomous',
        toolGate: autopilot ? autopilotRunGate : purchaseRunGate
      }
    }
    if (routine.watch) {
      before.set(messageId, { stage: findPurchase(routine.watch.purchaseId)?.tracking?.stage })
      watchOrder(messageId, routine.watch.purchaseId)
      return { task: `${UNATTENDED}\n${watchBrief(routine.watch)}`, access: 'autonomous', toolGate: routine.watch.autopilot ? autopilotRunGate : purchaseRunGate }
    }
    return null
  }

  function routineEnded(worker: Worker, routine: WorkerRoutine, messageId: string, outcome: TurnOutcome): void {
    const was = before.get(messageId)
    before.delete(messageId)
    endRun(messageId)
    const at = now()

    if (routine.purchase) {
      const plan = routine.purchase
      const known = was && 'orders' in was ? was.orders : new Set<string>()
      // Asked in the thread: the user hears from the reply itself, and the schedule's own times stand unless it ordered.
      const asked = was && 'asked' in was ? was.asked : false
      const orders = planPurchases(routine.id)
      const placed = orders.filter((p) => !known.has(p.id) && p.status === 'paid')
      for (const order of placed) {
        const money = order.amount === 0 && (order.charged ?? 0) === 0 ? 'free' : formatMoney(order.charged ?? order.amount, order.currency)
        if (!asked) {
          deps.reachOut(worker, {
            title: `${worker.name} ordered ${plan.item}`,
            body: [`${money} at ${order.merchant}`, order.orderId ? `order ${order.orderId}` : 'no order number yet'].join(', ')
          })
        }
        const tracked = worker.routines.some((r) => r.watch?.purchaseId === order.id)
        if (plan.track && order.orderId && !tracked) {
          deps.put(worker.id, {
            name: `Track order ${order.orderId}`,
            task: `Check on order ${order.orderId} from ${order.merchant}.`,
            everyMs: WATCH_EVERY_MS,
            daily: null,
            nextAt: at + WATCH_FIRST_CHECK_MS,
            watch: {
              purchaseId: order.id,
              orderId: order.orderId,
              merchant: order.merchant,
              site: order.site,
              item: plan.item,
              placedAt: order.createdAt,
              ...(plan.autopilot ? { autopilot: true } : {})
            },
            ...(routine.threadId ? { threadId: routine.threadId } : {})
          })
        }
      }
      // It ran but bought nothing (sold out, over the limit, not free): the user hears why, not silence.
      if (!placed.length && !asked && !outcome.error && !outcome.cancelled) {
        deps.reachOut(worker, { title: `${worker.name} didn’t buy ${plan.item}`, body: (outcome.text || 'It ended without placing the order.').slice(0, 240) })
      }
      if (asked && !placed.length) return
      const paid = orders.filter((p) => p.status === 'paid').length
      if (!routine.everyMs || (plan.orders !== null && paid >= plan.orders)) {
        deps.remove(worker.id, routine.id)
      } else if (routine.anchorAt !== undefined) {
        // Back to the picked time of day, however long this run took (or however late it started).
        const { runs: _runs, id, ...rest } = routine
        deps.put(worker.id, { ...rest, id, nextAt: nextPurchaseAt(routine.anchorAt, routine.everyMs, at) })
      }
      return
    }

    if (routine.watch) {
      const order = findPurchase(routine.watch.purchaseId)
      const stage = order?.tracking?.stage
      const stageBefore = was && 'stage' in was ? was.stage : undefined
      // Twice a day is too often to hear "still on its way"; a change is worth a banner.
      if (stage && stage !== stageBefore) {
        const tracking = order!.tracking!
        deps.reachOut(worker, {
          title: `Order ${routine.watch.orderId}: ${ORDER_STAGE_LABEL[stage].toLowerCase()}`,
          body: [routine.watch.item, tracking.eta ? `arriving ${tracking.eta}` : null, tracking.note || null].filter(Boolean).join(' · ')
        })
      }
      if (!order || orderSettled(stage) || at - routine.watch.placedAt > ORDER_WATCH_MS) deps.remove(worker.id, routine.id)
    }
  }

  return { routineTurn, routineEnded }
}

/** Why a plan can't be bought by this worker, or null. */
export function purchaseWorkerProblem(worker: Pick<Worker, 'engine' | 'name'>, plan: Pick<PurchasePlan, 'maxAmount'>, cardSaved: boolean): string | null {
  if (worker.engine && worker.engine !== 'native') return `${worker.name} runs on another agent engine, which can’t use Eaon’s browser and card. Pick a worker that runs on Eaon.`
  if (!isFreePlan(plan) && !cardSaved) return 'Add a card in Settings → Payments first, or set the maximum to 0 for free orders.'
  return null
}
