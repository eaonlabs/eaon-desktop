import type { ToolGate } from '../../agent/policy'
import { isWebSearchTool } from '../../webSearch'

/**
 * What a purchase schedule's run, or one of its order-tracking runs, may use.
 *
 * Nobody is watching such a run, and a store can't be used without clicking:
 * at the "safe" level every click in the browser is refused (clicks are
 * risky), so the order never got past the product page. The run is let act
 * on its own instead (`autonomous`), held to this: its browser, the card and
 * anything that only reads. Shell commands, files, computer use, messages
 * and plugins that change things stay out of reach. Within the browser the
 * usual lines hold: no passwords, and the press that places an order only
 * under payment_card's authorization for the schedule's own store.
 */

const ALLOWED = new Set(['web_browser', 'payment_card', 'web_fetch'])

export const PURCHASE_RUN_REFUSAL =
  'A purchase schedule’s run only uses its browser, the payment card and tools that look things up. Do this without it, or say in your report what is needed.'

export const purchaseRunGate: ToolGate = (tool) => {
  if (ALLOWED.has(tool.name) || isWebSearchTool(tool.name)) return null
  // A tool that never changes anything (reading mail for an order number, a page, a file).
  if (tool.mutating === false) return null
  return PURCHASE_RUN_REFUSAL
}
