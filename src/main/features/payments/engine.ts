import { randomUUID } from 'node:crypto'
import {
  cardBrand,
  cardDigits,
  DEFAULT_LIMITS,
  formatMoney,
  luhnValid,
  PAYMENTS_WAIVER,
  PAYMENTS_WAIVER_VERSION,
  type CardInput,
  type CardSummary,
  type PaymentLimits,
  type PaymentsMode,
  type PaymentsStatus,
  type PurchaseRecord,
  type PurchaseStatus,
  type WaiverAcceptance
} from '@shared/payments'

/**
 * Every rule about the agent spending money, with no Electron in it so it can
 * be tested directly. The feature module wires it to the store, the vault and
 * IPC; the tool asks it before and after each purchase.
 *
 * The waiver is enforced here, not in the Settings page: the only way to
 * reach `auto` is `acceptWaiver` with the current version and every box
 * ticked. `setMode('auto')` works only once that has happened, and a config
 * that says `auto` without a current waiver is read as `approve`.
 */

/** How long the card stays typeable after a purchase is authorized. */
export const AUTHORIZATION_MS = 20 * 60_000
const MAX_PURCHASES = 500

export interface PaymentsConfig {
  mode: PaymentsMode
  currency: string
  limits: PaymentLimits
  card: CardSummary | null
  waiver: WaiverAcceptance | null
  purchases: PurchaseRecord[]
}

export interface CardSecret {
  number: string
  cvc: string
}

export interface PaymentsDeps {
  load: () => unknown
  save: (config: PaymentsConfig) => void
  getSecret: () => string | undefined
  /** Null removes it. */
  setSecret: (value: string | null) => void
  now?: () => number
}

export interface PurchaseRequest {
  merchant: string
  site: string | null
  description: string
  amount: number
  currency: string
  chatId: string
  /** It signs the user up for charges that repeat (a subscription, auto-renew). */
  recurring?: boolean
}

const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback)
const text = (value: unknown, max = 200): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** A bare hostname from "https://www.starbucks.com/menu", "starbucks.com" or "Starbucks.com.". */
export function normalizeSite(raw: unknown): string | null {
  const value = text(raw, 300).toLowerCase()
  if (!value) return null
  let host = value
  try {
    host = new URL(/^[a-z][\w+.-]*:\/\//.test(value) ? value : `https://${value}`).hostname
  } catch {
    return null
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '')
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null
}

/** True when `url`'s host is `site` or a subdomain of it. */
export function urlMatchesSite(url: string, site: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
    return host === site || host.endsWith(`.${site}`)
  } catch {
    return false
  }
}

function normalizeLimits(raw: unknown): PaymentLimits {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    perPurchase: finite(v.perPurchase, DEFAULT_LIMITS.perPurchase),
    perDay: finite(v.perDay, DEFAULT_LIMITS.perDay),
    perMonth: finite(v.perMonth, DEFAULT_LIMITS.perMonth)
  }
}

function normalizeCard(raw: unknown): CardSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const last4 = text(v.last4, 4)
  if (!/^\d{4}$/.test(last4)) return null
  return {
    brand: text(v.brand, 40) || 'Card',
    last4,
    expMonth: finite(v.expMonth, 0),
    expYear: finite(v.expYear, 0),
    nameOnCard: text(v.nameOnCard, 100),
    billingZip: text(v.billingZip, 20),
    label: text(v.label, 60) || 'Agent card'
  }
}

function normalizeWaiver(raw: unknown): WaiverAcceptance | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  return typeof v.version === 'number' && typeof v.acceptedAt === 'number' ? { version: v.version, acceptedAt: v.acceptedAt } : null
}

const STATUSES: PurchaseStatus[] = ['authorized', 'paid', 'failed', 'cancelled']

function normalizePurchases(raw: unknown): PurchaseRecord[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p): p is PurchaseRecord => !!p && typeof p === 'object' && typeof (p as PurchaseRecord).id === 'string')
    .map((p) => ({ ...p, status: STATUSES.includes(p.status) ? p.status : 'authorized' }))
    .slice(0, MAX_PURCHASES)
}

export function normalizeConfig(raw: unknown): PaymentsConfig {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const waiver = normalizeWaiver(v.waiver)
  let mode: PaymentsMode = v.mode === 'approve' || v.mode === 'auto' ? v.mode : 'off'
  // Automatic purchases only ever come from accepting this version of the waiver.
  if (mode === 'auto' && (waiver?.version ?? 0) < PAYMENTS_WAIVER_VERSION) mode = 'approve'
  const currency = /^[A-Z]{3}$/.test(text(v.currency, 3).toUpperCase()) ? text(v.currency, 3).toUpperCase() : 'USD'
  return { mode, currency, limits: normalizeLimits(v.limits), card: normalizeCard(v.card), waiver, purchases: normalizePurchases(v.purchases) }
}

function startOfDay(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfMonth(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  d.setDate(1)
  return d.getTime()
}

/** What a purchase counts toward the limits: what was charged, else what was authorized. Failed and cancelled ones count nothing. */
const counted = (p: PurchaseRecord): number => (p.status === 'failed' || p.status === 'cancelled' ? 0 : (p.charged ?? p.amount))

export class PaymentsEngine {
  private config: PaymentsConfig
  private readonly now: () => number

  constructor(private readonly deps: PaymentsDeps) {
    this.config = normalizeConfig(deps.load())
    this.now = deps.now ?? Date.now
  }

  private persist(): void {
    this.deps.save(this.config)
  }

  waiverCurrent(): boolean {
    return (this.config.waiver?.version ?? 0) >= PAYMENTS_WAIVER_VERSION
  }

  hasCard(): boolean {
    return Boolean(this.config.card && this.secret())
  }

  /** What applies right now: nothing without a card, and never automatic without the current waiver. */
  effectiveMode(): PaymentsMode {
    if (this.config.mode === 'off' || !this.hasCard()) return 'off'
    if (this.config.mode === 'auto' && !this.waiverCurrent()) return 'approve'
    return this.config.mode
  }

  spent(): { today: number; month: number } {
    const now = this.now()
    const day = startOfDay(now)
    const month = startOfMonth(now)
    let today = 0
    let thisMonth = 0
    for (const p of this.config.purchases) {
      if (p.currency !== this.config.currency) continue
      const amount = counted(p)
      if (p.createdAt >= month) thisMonth += amount
      if (p.createdAt >= day) today += amount
    }
    return { today: round(today), month: round(thisMonth) }
  }

  status(): PaymentsStatus {
    return {
      mode: this.config.mode,
      effectiveMode: this.effectiveMode(),
      card: this.config.card,
      currency: this.config.currency,
      limits: { ...this.config.limits },
      waiver: this.config.waiver,
      waiverCurrent: this.waiverCurrent(),
      spent: this.spent(),
      purchases: this.config.purchases.slice(0, 50)
    }
  }

  /* ------------------------------------------------------------------ card */

  setCard(input: CardInput): PaymentsStatus {
    const number = cardDigits(String(input.number ?? ''))
    if (!luhnValid(number)) throw new Error('That card number isn’t valid. Check it and try again.')
    const cvc = String(input.cvc ?? '').replace(/\D/g, '')
    if (!/^\d{3,4}$/.test(cvc)) throw new Error('The security code is 3 or 4 digits.')
    const expMonth = Math.round(Number(input.expMonth))
    let expYear = Math.round(Number(input.expYear))
    if (expYear < 100) expYear += 2000
    if (!(expMonth >= 1 && expMonth <= 12) || !(expYear >= 2000 && expYear <= 2100)) throw new Error('Enter the expiry as month and year.')
    const now = new Date(this.now())
    if (expYear < now.getFullYear() || (expYear === now.getFullYear() && expMonth < now.getMonth() + 1)) throw new Error('That card has expired.')
    const nameOnCard = text(input.nameOnCard, 100)
    if (!nameOnCard) throw new Error('Enter the name on the card.')
    const billingZip = text(input.billingZip, 20)
    const secret: CardSecret = { number, cvc }
    this.deps.setSecret(JSON.stringify(secret))
    this.config.card = { brand: cardBrand(number), last4: number.slice(-4), expMonth, expYear, nameOnCard, billingZip, label: text(input.label, 60) || 'Agent card' }
    if (this.config.mode === 'off') this.config.mode = 'approve'
    this.persist()
    return this.status()
  }

  removeCard(): PaymentsStatus {
    this.deps.setSecret(null)
    this.config.card = null
    this.config.mode = 'off'
    this.persist()
    return this.status()
  }

  private secret(): CardSecret | null {
    try {
      const raw = this.deps.getSecret()
      if (!raw) return null
      const parsed = JSON.parse(raw) as CardSecret
      return typeof parsed.number === 'string' && typeof parsed.cvc === 'string' ? parsed : null
    } catch {
      return null
    }
  }

  /* -------------------------------------------------------- mode and waiver */

  setMode(mode: PaymentsMode): PaymentsStatus {
    if (mode !== 'off' && mode !== 'approve' && mode !== 'auto') throw new Error(`Unknown mode "${String(mode)}".`)
    if (mode !== 'off' && !this.hasCard()) throw new Error('Add a card first.')
    if (mode === 'auto' && !this.waiverCurrent()) {
      throw new Error('Automatic purchases need the waiver accepted first.')
    }
    this.config.mode = mode
    this.persist()
    return this.status()
  }

  /**
   * The user read the waiver and ticked every box. Only this sets the
   * acceptance, and only for the current version with all boxes ticked.
   */
  acceptWaiver(version: number, checks: boolean[]): PaymentsStatus {
    if (version !== PAYMENTS_WAIVER_VERSION) throw new Error('That isn’t the current version of the terms. Read them again.')
    if (!Array.isArray(checks) || checks.length !== PAYMENTS_WAIVER.checks.length || !checks.every((c) => c === true)) {
      throw new Error('Tick every box to turn on automatic purchases.')
    }
    if (!this.hasCard()) throw new Error('Add a card first.')
    this.config.waiver = { version, acceptedAt: this.now() }
    this.config.mode = 'auto'
    this.persist()
    return this.status()
  }

  /** Withdraws the acceptance; automatic purchases stop at once. */
  revokeWaiver(): PaymentsStatus {
    this.config.waiver = null
    if (this.config.mode === 'auto') this.config.mode = 'approve'
    this.persist()
    return this.status()
  }

  setLimits(patch: Partial<PaymentLimits>): PaymentsStatus {
    const next = { ...this.config.limits }
    for (const key of ['perPurchase', 'perDay', 'perMonth'] as const) {
      if (patch[key] === undefined) continue
      const value = Number(patch[key])
      if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new Error('Limits are amounts from 0 up.')
      next[key] = round(value)
    }
    this.config.limits = next
    this.persist()
    return this.status()
  }

  setCurrency(currency: string): PaymentsStatus {
    const code = String(currency ?? '').trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code)) throw new Error('Use a three-letter currency code, like USD.')
    this.config.currency = code
    this.persist()
    return this.status()
  }

  /* -------------------------------------------------------------- purchases */

  /**
   * Whether a purchase needs the user's OK, and why. In approve mode every
   * purchase does. In auto mode one that fits the limits doesn't; one that
   * doesn't fit, or is in another currency, falls back to asking.
   */
  assess(amount: number, currency: string, recurring = false): { needsUser: boolean; reason: string } {
    const mode = this.effectiveMode()
    if (mode !== 'auto') return { needsUser: true, reason: 'You approve every purchase.' }
    // The limits are about one charge; a subscription keeps charging after
    // the run ends, so the user always says yes to one themselves.
    if (recurring) return { needsUser: true, reason: 'It charges again later (a subscription or renewal).' }
    const { limits } = this.config
    const cur = this.config.currency
    if (currency.toUpperCase() !== cur) return { needsUser: true, reason: `It is in ${currency.toUpperCase()}, and your limits are in ${cur}.` }
    if (!(amount > 0)) return { needsUser: true, reason: 'The amount is unclear.' }
    if (amount > limits.perPurchase) return { needsUser: true, reason: `${formatMoney(amount, cur)} is over your ${formatMoney(limits.perPurchase, cur)} per-purchase limit.` }
    const spent = this.spent()
    if (spent.today + amount > limits.perDay) return { needsUser: true, reason: `It would take today past your ${formatMoney(limits.perDay, cur)} daily limit.` }
    if (spent.month + amount > limits.perMonth) return { needsUser: true, reason: `It would take this month past your ${formatMoney(limits.perMonth, cur)} monthly limit.` }
    return { needsUser: false, reason: 'Within your limits.' }
  }

  /**
   * Records a purchase as authorized, so the card can be typed for it. `how`
   * says whether the user approved it; an automatic one must still fit.
   */
  authorize(request: PurchaseRequest, how: 'approved' | 'auto'): PurchaseRecord {
    const mode = this.effectiveMode()
    if (mode === 'off') throw new Error('Payments are off. The user can turn them on in Settings → Payments.')
    const amount = round(Number(request.amount))
    if (!(amount > 0)) throw new Error('"amount" must be the total you are about to pay, more than 0.')
    const currency = text(request.currency, 3).toUpperCase() || this.config.currency
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('"currency" is a three-letter code, like USD.')
    const merchant = text(request.merchant, 100)
    if (!merchant) throw new Error('"merchant" is required: who you are paying.')
    if (how === 'auto' && this.assess(amount, currency, request.recurring === true).needsUser) {
      throw new Error('This purchase needs the user’s approval.')
    }
    const now = this.now()
    const record: PurchaseRecord = {
      id: `pay_${randomUUID().slice(0, 8)}`,
      merchant,
      site: request.site,
      description: text(request.description, 300),
      amount,
      currency,
      charged: null,
      status: 'authorized',
      how,
      ...(request.recurring ? { recurring: true } : {}),
      chatId: request.chatId,
      createdAt: now,
      expiresAt: now + AUTHORIZATION_MS
    }
    this.config.purchases = [record, ...this.config.purchases].slice(0, MAX_PURCHASES)
    this.persist()
    return record
  }

  /** A live authorization this chat may type the card for, or an error that says why not. */
  usable(id: string, chatId: string): PurchaseRecord {
    const record = this.config.purchases.find((p) => p.id === id)
    if (!record) throw new Error(`No purchase "${id}". Call payment_card with action "authorize" first.`)
    if (record.chatId !== chatId) throw new Error('That purchase was authorized in another conversation.')
    if (record.status !== 'authorized') throw new Error(`That purchase is already ${record.status}. Authorize a new one if you still need to pay.`)
    if (this.now() > record.expiresAt) throw new Error('That authorization has expired. Authorize the purchase again.')
    if (this.effectiveMode() === 'off') throw new Error('Payments were turned off.')
    return record
  }

  /**
   * Whether a live authorization in this chat covers pressing a spending
   * button on `url`'s site, so the browser doesn't ask again for the
   * "Place order" of a purchase the user (or the waiver and limits) already
   * allowed. It covers one press: the first claims it, and a second press
   * — a retry after a slow page, a duplicate checkout — asks like any
   * other, so one approval can never become two orders.
   */
  claimSpendingClick(chatId: string, url: string): boolean {
    if (this.effectiveMode() === 'off') return false
    const now = this.now()
    const record = this.config.purchases.find(
      (p) => p.chatId === chatId && p.status === 'authorized' && p.site !== null && !p.submittedAt && now <= p.expiresAt && urlMatchesSite(url, p.site)
    )
    if (!record) return false
    record.submittedAt = now
    this.persist()
    return true
  }

  /** The secret parts of the card, for typing only. Never returned to the model. */
  cardSecret(): CardSecret & { card: CardSummary } {
    const secret = this.secret()
    if (!secret || !this.config.card) throw new Error('There is no card saved. The user can add one in Settings → Payments.')
    return { ...secret, card: this.config.card }
  }

  complete(id: string, chatId: string, status: Exclude<PurchaseStatus, 'authorized'>, charged: number | null, note: string): PurchaseRecord {
    const record = this.config.purchases.find((p) => p.id === id)
    if (!record) throw new Error(`No purchase "${id}".`)
    if (record.chatId !== chatId) throw new Error('That purchase belongs to another conversation.')
    if (record.status !== 'authorized') throw new Error(`That purchase is already ${record.status}.`)
    record.status = status
    record.charged = status === 'paid' ? round(charged ?? record.amount) : null
    // Tax, shipping or a currency mark-up added at checkout: recorded and
    // said, so the user hears about it instead of finding it on a statement.
    if (record.charged !== null && record.charged > record.amount) record.overAuthorized = true
    record.completedAt = this.now()
    if (note) record.note = text(note, 300)
    this.persist()
    return record
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
