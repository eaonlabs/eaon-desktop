/**
 * Reading a checkout page, for the browser tools' "does this click spend
 * money?" check. A button's words say it pays ("Pay", "Place order"); the
 * page says how much. When a discount code, a pass or a membership has
 * brought the total due to nothing, pressing that button spends nothing, so
 * an agent may press it on its own — no card, no approval.
 *
 * Kept free of Electron and the store so tests can load it as is.
 */

/**
 * Buttons that spend money. Not "Checkout" or "Proceed to checkout": those
 * only open the checkout page, where the total — and any code that makes it
 * free — is shown before anything is paid.
 */
export const SPENDING =
  /\b(buy|purchase|pay|place (?:your |my |the )?order|order now|complete (?:checkout|order|purchase|payment)|confirm (?:order|purchase|payment|booking)|book now|subscribe|start (?:my |your )?(?:free )?trial|donate|transfer|withdraw)\b/i

/** An amount of money: "$30.00", "-$30", "US$ 12", "30,00 €", "1,299 USD". */
const CODES = 'USD|EUR|GBP|CAD|AUD|NZD|INR|JPY|CHF|SEK|NOK|DKK'
const MONEY = new RegExp(
  `(?:(?:US|CA|AU|NZ|HK|S|R)?[$€£¥₹₩]|\\b(?:${CODES})\\b)\\s*[-−–]?\\s*\\d[\\d.,]*|[-−–]?\\d[\\d.,]*\\s*(?:[€£₹]|\\b(?:${CODES}|kr|zł)\\b)`,
  'gi'
)

/** A line that states what will be charged. */
const TOTAL = /\b(total|amount due|due today|due now|to pay|you pay|you'll pay|you will pay|balance due|order total|grand total|charged today)\b/i
/** Totals that are not the charge: the sum before discounts, or a line that only adds the tax. */
const NOT_THE_CHARGE = /\b(sub-?\s?total|total savings|total discount|you save|you saved|items? total)\b/i
/** "Total: Free". */
const FREE_WORD = /\bfree\b/i
/** A charge that comes later: a renewal, the price after a trial, a monthly amount. */
const LATER =
  /\b(then|thereafter|per (?:month|year|week|day)|a (?:month|year|week)|monthly|yearly|annually|weekly|after (?:your |the )?(?:free )?trial|renews?|recurring|starting (?:on|from)|billed (?:monthly|yearly|annually|every))\b|\/\s?(?:mo|month|yr|year|wk|week)\b/i

/** Whether an amount is zero, whatever its separators ("$0.00", "0,00 €"). */
const isZero = (amount: string): boolean => !/[1-9]/.test(amount.replace(/[^\d]/g, ''))

/**
 * What the page says will be charged, line by line: the amount on each line
 * that states a total, or on the line or two after it (checkouts often put
 * "Total due" and "$0.00" in separate elements). "Free" counts as zero.
 */
export function chargedAmounts(text: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const found: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!TOTAL.test(line) || NOT_THE_CHARGE.test(line)) continue
    for (const candidate of [line, lines[i + 1], lines[i + 2]]) {
      if (candidate === undefined) break
      // The next total's own line belongs to that total.
      if (candidate !== line && TOTAL.test(candidate)) break
      const amount = candidate.match(MONEY)?.[0]
      if (amount) {
        found.push(amount)
        break
      }
      const rest = candidate === line ? candidate.replace(TOTAL, '') : candidate
      if (FREE_WORD.test(rest) && rest.length < 40) {
        found.push('0')
        break
      }
    }
  }
  return found
}

/**
 * True when the checkout on this page charges nothing: it states a total,
 * every total it states is zero, and nothing is to be charged later (a
 * trial that turns into a subscription is not free). Anything unclear —
 * no total found, any amount above zero — is false, and the click waits for
 * the user as before.
 */
export function nothingDue(text: string): boolean {
  const amounts = chargedAmounts(text)
  if (amounts.length === 0 || !amounts.every(isZero)) return false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!LATER.test(lines[i])) continue
    const near = [lines[i], lines[i + 1] ?? ''].join(' ')
    if ((near.match(MONEY) ?? []).some((amount) => !isZero(amount))) return false
  }
  return true
}
