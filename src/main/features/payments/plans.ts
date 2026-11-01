import type { PurchaseRecord } from '@shared/payments'

/**
 * What a scheduled run may do with the card, set by the scheduler for the
 * length of one run and read by `payment_card`. Kept here, with no Electron
 * and no store, so the scheduler can use it without pulling in payments.
 *
 * Keyed by the run's assistant message id rather than its chat: a purchase
 * schedule's runs all write into one chat, and an order-tracking run in that
 * chat must never inherit the purchase run's approval.
 *
 * - A grant is the purchase schedule the user set up and saved: it stands in
 *   for their approval of one order in this run, on the plan's site and up
 *   to its amount. It is used up by the first authorization.
 * - A watch lets a tracking run record the status of one placed order.
 */

export interface PurchaseGrant {
  /** The purchase schedule's task id. */
  planId: string
  item: string
  site: string
  maxAmount: number
  currency: string
  /** Autopilot: presses on the store need nobody once the order is authorized (see payments.ts). */
  autopilot?: boolean
  used: boolean
}

const grants = new Map<string, PurchaseGrant>()
const watches = new Map<string, string>()

export function grantPurchase(messageId: string, grant: Omit<PurchaseGrant, 'used'>): void {
  grants.set(messageId, { ...grant, used: false })
}

export function grantFor(messageId: string): PurchaseGrant | null {
  return grants.get(messageId) ?? null
}

export function watchOrder(messageId: string, purchaseId: string): void {
  watches.set(messageId, purchaseId)
}

export function watchFor(messageId: string): string | null {
  return watches.get(messageId) ?? null
}

/** The run ended: whatever it was allowed ends with it. */
export function endRun(messageId: string): void {
  grants.delete(messageId)
  watches.delete(messageId)
}

/* ------------------------------------------- purchases, for the scheduler */

interface PurchaseLookup {
  all: () => PurchaseRecord[]
}

let lookup: PurchaseLookup | null = null

/** Set by the payments feature once its engine runs; null when it stops. */
export function setPurchaseLookup(next: PurchaseLookup | null): void {
  lookup = next
}

/** Whether the payments engine is running, so purchases can be looked up at all. */
export function purchasesKnown(): boolean {
  return lookup !== null
}

export function findPurchase(id: string): PurchaseRecord | null {
  return lookup?.all().find((p) => p.id === id) ?? null
}

/** A purchase schedule's orders, newest first. */
export function planPurchases(planId: string): PurchaseRecord[] {
  return lookup?.all().filter((p) => p.planId === planId) ?? []
}

/**
 * Slack on "since": a purchase stamped a little before the run started (the
 * clock set back mid-run) still counts as the run's. Too wide only means a
 * cut-off run isn't made again; too narrow could buy twice.
 */
const CLOCK_SLACK_MS = 60 * 60_000

/**
 * Whether a run may have bought something: a purchase of its chat or of its
 * purchase schedule, from when it started on, whose card was typed, whose
 * order button was pressed, or that was paid (engine.ts `mayHaveCharged`).
 * A purchase schedule's runs share one chat, so earlier runs' orders there
 * don't count. Null when the payments engine isn't running, so nobody can tell.
 */
export function mayHaveBoughtSince(chatId: string | null, planId: string, since: number): boolean | null {
  if (!lookup) return null
  return lookup
    .all()
    .some((p) => (p.planId === planId || (chatId !== null && p.chatId === chatId)) && p.createdAt >= since - CLOCK_SLACK_MS && (p.status === 'paid' || Boolean(p.typedAt || p.submittedAt)))
}
