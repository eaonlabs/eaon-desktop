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

export function findPurchase(id: string): PurchaseRecord | null {
  return lookup?.all().find((p) => p.id === id) ?? null
}

/** A purchase schedule's orders, newest first. */
export function planPurchases(planId: string): PurchaseRecord[] {
  return lookup?.all().filter((p) => p.planId === planId) ?? []
}
