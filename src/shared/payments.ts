/**
 * Agent payments: a card the user saves in Eaon, which the agent can pay with
 * either after the user approves each purchase, or on its own within limits
 * once the user has accepted the automatic-purchases waiver.
 *
 * The card number and security code live only in the main process's
 * encrypted vault. The renderer never gets them and the model is never
 * handed them: the agent asks `payment_card` to type them into a checkout
 * field, and snapshot text has them blanked.
 */

export type PaymentsMode = 'off' | 'approve' | 'auto'

export type PurchaseStatus = 'authorized' | 'paid' | 'failed' | 'cancelled'

export interface PaymentLimits {
  /** Largest single purchase the agent may make without asking. */
  perPurchase: number
  /** Total per calendar day (local time) before it has to ask. */
  perDay: number
  /** Total per calendar month (local time) before it has to ask. */
  perMonth: number
}

export interface CardSummary {
  brand: string
  last4: string
  expMonth: number
  expYear: number
  nameOnCard: string
  billingZip: string
  /** What the user calls it, e.g. "Agent card". */
  label: string
}

/** What the Settings form sends once; the number and code go straight to the vault. */
export interface CardInput {
  number: string
  expMonth: number
  expYear: number
  cvc: string
  nameOnCard: string
  billingZip: string
  label?: string
}

export interface PurchaseRecord {
  id: string
  merchant: string
  /** The site the card may be typed into for this purchase (a hostname), when known. */
  site: string | null
  description: string
  amount: number
  currency: string
  /** What the merchant actually charged, once the agent reports back. */
  charged: number | null
  status: PurchaseStatus
  /** Whether the user approved it, or it ran automatically within the limits. */
  how: 'approved' | 'auto'
  /** A subscription or anything else that charges again later. Never automatic. */
  recurring?: boolean
  chatId: string
  createdAt: number
  /** The card can be typed for this purchase until then. */
  expiresAt: number
  /**
   * When the agent pressed the site's pay button under this authorization.
   * It covers that one press: pressing again (a retry after a slow page)
   * asks first, so one approval can't become two orders.
   */
  submittedAt?: number
  completedAt?: number
  /** The merchant charged more than was authorized (tax or shipping added at checkout). */
  overAuthorized?: boolean
  note?: string
}

export interface WaiverAcceptance {
  version: number
  acceptedAt: number
}

export interface PaymentsStatus {
  /** What the user picked. */
  mode: PaymentsMode
  /** What applies: off without a card, and never auto without the current waiver. */
  effectiveMode: PaymentsMode
  card: CardSummary | null
  currency: string
  limits: PaymentLimits
  waiver: WaiverAcceptance | null
  /** True when the accepted waiver is the current version. */
  waiverCurrent: boolean
  spent: { today: number; month: number }
  /** Newest first. */
  purchases: PurchaseRecord[]
}

export const DEFAULT_LIMITS: PaymentLimits = { perPurchase: 50, perDay: 100, perMonth: 300 }

/**
 * Bump when the substance of the waiver changes: everyone on automatic
 * purchases drops back to approving each one until they accept it again.
 */
export const PAYMENTS_WAIVER_VERSION = 1

export const PAYMENTS_WAIVER = {
  title: 'Automatic purchases',
  paragraphs: [
    'With automatic purchases on, Eaon’s agent can pay with the card you saved without asking you first, as long as each purchase fits the limits you set. You are responsible for every purchase it makes.',
    'AI agents make mistakes. The agent can misread a page, pick the wrong item, size, quantity or store, pay twice, or be tricked by a website, email or message into buying something you did not want. Purchases may not be refundable.',
    'Eaon checks its limits against the amount the agent says it is about to pay. The merchant may charge a different amount (tax, tips, fees, currency conversion). Use a virtual card with its own spending limit from your bank or card issuer, so the issuer enforces a hard cap as well.',
    'To the fullest extent permitted by law, Eaon, its developers and affiliates are not liable for any purchase the agent makes, any money lost, any fees or chargebacks, or any other loss or damage that comes from automatic purchases. You will settle any dispute with the merchant or your card issuer yourself.',
    'Your card number and security code are stored encrypted on this computer. Eaon types them into checkout forms itself, so they are never part of the agent’s instructions, and page text the agent reads has them blanked out. A screenshot the agent takes of a filled-in checkout can still show them to the AI model.',
    'You can turn automatic purchases off at any time in Settings → Payments, where every purchase is listed.'
  ],
  checks: [
    'I have read and understand these terms.',
    'I understand the agent can make mistakes, and that I am responsible for every purchase it makes.',
    'I agree that Eaon and its developers are not liable for any money lost through automatic purchases.',
    'I am at least 18 years old and allowed to use this card.'
  ]
} as const

/** Digits only. */
export function cardDigits(number: string): string {
  return number.replace(/\D/g, '')
}

export function luhnValid(number: string): boolean {
  const digits = cardDigits(number)
  if (digits.length < 12 || digits.length > 19) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

export function cardBrand(number: string): string {
  const d = cardDigits(number)
  if (/^4/.test(d)) return 'Visa'
  if (/^(5[1-5]|2[2-7])/.test(d)) return 'Mastercard'
  if (/^3[47]/.test(d)) return 'American Express'
  if (/^(6011|65|64[4-9])/.test(d)) return 'Discover'
  if (/^35/.test(d)) return 'JCB'
  if (/^3(0[0-5]|[68])/.test(d)) return 'Diners Club'
  return 'Card'
}

/** "$12.50" for USD, "12.50 EUR" otherwise: no locale guessing in the main process. */
export function formatMoney(amount: number, currency: string): string {
  const fixed = amount.toFixed(2)
  return currency.toUpperCase() === 'USD' ? `$${fixed}` : `${fixed} ${currency.toUpperCase()}`
}
