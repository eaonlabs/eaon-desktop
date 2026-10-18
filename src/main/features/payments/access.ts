import type { CardSecret } from './engine'

/**
 * What other tools need to know about payments, without importing the
 * payments feature (which would pull Electron and the store into them):
 *
 * - whether a live purchase covers a spending click on a page, so the
 *   browser doesn't ask a second time for the "Place order" button of a
 *   purchase the user (or the waiver and limits) already allowed;
 * - the card's digits, so page snapshots the model reads have them blanked.
 */

/**
 * The steps on the way to a checkout ("Checkout | $30", "Proceed to
 * checkout", "Continue to payment"), as opposed to the press that places
 * the order. They open a page and spend nothing, so they never wait for
 * anyone: a run that can't reach the checkout can't read the total it is
 * meant to judge, or see a discount that only applies there. Express
 * buttons that pay in one go ("Checkout with Shop Pay") aren't steps.
 */
const CHECKOUT_STEP = /\b(check ?out|proceed to (?:check ?out|payment|shipping|delivery)|continue to (?:check ?out|payment|shipping|delivery)|go to check ?out)\b/i
const ORDER_PRESS = /\b(place|buy now|pay now|pay \$|complete|confirm|submit|subscribe|donate|transfer|withdraw|book|express|1-click|one-click|shop ?pay|paypal|apple pay|google pay|amazon pay|g ?pay|venmo|klarna|afterpay|affirm)\b/i

export const isCheckoutStep = (name: string): boolean => CHECKOUT_STEP.test(name) && !ORDER_PRESS.test(name)

/** The click being judged: whose run it is (a purchase schedule's run may go through checkout) and what the button says. */
export interface SpendingClick {
  messageId?: string
  name?: string
  /** A click by position, on nothing the page names: only an autopilot run's live order covers it. */
  unnamed?: boolean
}

type Covers = (chatId: string, url: string, click?: SpendingClick) => boolean

let covers: Covers | null = null
let secret: (() => CardSecret | null) | null = null
let cached: { number: string; pattern: RegExp } | null = null

export function setPaymentAccess(access: { covers: Covers; secret: () => CardSecret | null } | null): void {
  covers = access?.covers ?? null
  secret = access?.secret ?? null
  cached = null
}

/**
 * True while this chat holds a live purchase authorized for the page's site
 * that hasn't been used yet. Asking spends it: an authorization covers one
 * press of the pay button, so the browser asks before a second one. The
 * permission policy asks each call's `catastrophic` once (agent/policy.ts),
 * which is where this is called from.
 */
export function purchaseCovers(chatId: string, url: string, click?: SpendingClick): boolean {
  try {
    return covers?.(chatId, url, click) ?? false
  } catch {
    return false
  }
}

const SHORT_FIELD = /\b(textbox|spinbutton|input)\b[^\n]*(cvc|cvv|cvn|csc|cid|security (code|number)|card code|verification (code|number|value))/i

/**
 * Blanks the saved card's number wherever it appears (spaced, dashed or
 * plain) and its security code where a security-code field shows it. A
 * checkout snapshot shows what was typed into each field.
 */
export function redactPaymentSecrets(text: string): string {
  let card: CardSecret | null = null
  try {
    card = secret?.() ?? null
  } catch {
    card = null
  }
  if (!card || !text) return text
  if (cached?.number !== card.number) {
    const digits = card.number.split('').join('[\\s-]?')
    cached = { number: card.number, pattern: new RegExp(digits, 'g') }
  }
  let out = text.replace(cached.pattern, `•••• ${card.number.slice(-4)}`)
  if (card.cvc && out.includes(card.cvc)) {
    out = out
      .split('\n')
      .map((line) => (SHORT_FIELD.test(line) ? line.split(card!.cvc).join('•••') : line))
      .join('\n')
  }
  return out
}
