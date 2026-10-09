import { opensPrivateNetwork } from '../browser/privateTarget'

export { opensPrivateNetwork }

/**
 * What asks the user first in their own browser, carried over from the
 * extension's tool: buttons that buy, send or delete, typing into card,
 * password and one-time-code fields, and pages on this computer or the local
 * network. Judged on the elements of the latest page read (Browser Use's
 * browser_get_state); an element the agent hasn't read is treated as risky.
 */

/** One entry of browser_get_state's `interactive_elements`. */
export interface PageElement {
  index: number
  tag: string
  text?: string
  placeholder?: string
  href?: string
  /** The label just before a field, which Browser Use lists as its own element. */
  label?: string
}

const COMMITTING =
  /\b(buy|purchase|pay|checkout|check out|place (?:your |my |the )?order|order now|complete (?:order|purchase|payment)|confirm (?:order|purchase|payment|booking)|book now|reserve|subscribe|donate|transfer|withdraw|send|post|publish|tweet|reply|comment|delete|remove|erase|destroy|trash|deactivate|close (?:my |your |the )?account|cancel (?:my |your |the )?(?:subscription|account|order|plan|membership)|unsubscribe)\b/i

/** Buttons that spend money: an autonomous worker may post or send, but never pays. */
const SPENDING =
  /\b(buy|purchase|pay|checkout|check out|place (?:your |my |the )?order|order now|complete (?:order|purchase|payment)|confirm (?:order|purchase|payment|booking)|book now|subscribe|donate|transfer|withdraw)\b/i

const SENSITIVE_FIELD =
  /password|passcode|card ?number|credit card|debit card|name on card|\bcvc\b|\bcvv\d?\b|\bcsc\b|security code|expir|\biban\b|routing number|account number|sort code|\bssn\b|social security|\bpin\b|one-time|verification code|\b2fa\b|two-factor/i

const FIELD_TAGS = new Set(['input', 'textarea', 'select'])

/** What the page holds, as of the agent's latest read of it. */
export class PageMemory {
  private elements = new Map<number, PageElement>()

  /** Takes in a browser_get_state answer (its JSON text). */
  remember(stateText: string): void {
    let parsed: { interactive_elements?: PageElement[] }
    try {
      parsed = JSON.parse(stateText) as { interactive_elements?: PageElement[] }
    } catch {
      return
    }
    if (!Array.isArray(parsed.interactive_elements)) return
    this.elements.clear()
    let label: string | undefined
    for (const el of parsed.interactive_elements) {
      if (typeof el?.index !== 'number') continue
      const tag = String(el.tag ?? '').toLowerCase()
      if (tag === 'label') {
        label = el.text?.trim() || undefined
        this.elements.set(el.index, { ...el, tag })
        continue
      }
      this.elements.set(el.index, { ...el, tag, ...(FIELD_TAGS.has(tag) && label ? { label } : {}) })
      label = undefined
    }
  }

  /** The page changed: what was read before no longer describes it. */
  forget(): void {
    this.elements.clear()
  }

  get(index: unknown): PageElement | undefined {
    return typeof index === 'number' ? this.elements.get(index) : undefined
  }
}

const nameOf = (el: PageElement): string => [el.text, el.placeholder, el.label].filter(Boolean).join(' ')

export function isSensitive(el: PageElement): boolean {
  return SENSITIVE_FIELD.test(nameOf(el))
}

/** Asks even in "Approve for me". */
export function browserRisk(tool: string, input: Record<string, unknown>, page: PageMemory): boolean {
  if (tool === 'browser_navigate') return opensPrivateNetwork(input.url)
  if (tool === 'browser_click') {
    // A click by coordinates can't be judged: the user decides.
    if (input.index === undefined) return true
    const el = page.get(input.index)
    return !el || COMMITTING.test(nameOf(el))
  }
  if (tool === 'browser_type') {
    const el = page.get(input.index)
    return !el || isSensitive(el)
  }
  return false
}

/** Never done unattended: secrets typed, money spent. */
export function browserCatastrophic(tool: string, input: Record<string, unknown>, page: PageMemory): boolean {
  if (tool === 'browser_click') {
    if (input.index === undefined) return true
    const el = page.get(input.index)
    return !el || SPENDING.test(nameOf(el))
  }
  if (tool === 'browser_type') {
    const el = page.get(input.index)
    return !el || isSensitive(el)
  }
  return false
}

export function describeElement(el: PageElement | undefined, index: unknown): string {
  if (typeof index !== 'number') return ''
  if (!el) return `[${index}]`
  const name = nameOf(el)
  return `[${index}] ${el.tag}${name ? ` "${name.slice(0, 60)}"` : ''}`
}
