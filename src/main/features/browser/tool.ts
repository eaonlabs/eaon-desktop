import { BROWSER_ACTIONS, CHROME_WEB_STORE_URL, type BrowserAction, type SnapshotElement } from '@shared/browserBridge'
import { capOutput, type AgentTool, type ToolResult, type ToolSource } from '../../agent/tools'
import { opensPrivateNetwork } from './privateTarget'
import { NotConnectedError, type BrowserBridge } from './server'

/**
 * The agent's one `browser` tool.
 *
 * One tool with an `action` enum rather than seventeen tools: every schema
 * offered is paid for on every request of every Work turn, and the actions
 * share most of their parameters anyway. The model reads the page through
 * `snapshot` — a numbered list of interactive elements plus the page text —
 * and acts on elements by number, which is far cheaper per step than steering
 * by screenshots and coordinates.
 */

/**
 * Actions that cannot change anything a user would care about: reading the
 * page, moving the viewport, pointing at things. They skip approval. Scroll
 * and hover are here too — asking the user to approve a scroll in "Ask for
 * approval" mode would make the tool unusable for no safety gain.
 */
const READ_ONLY = new Set<BrowserAction>(['snapshot', 'screenshot', 'list_tabs', 'get_url', 'wait', 'scroll', 'hover', 'switch_tab', 'read', 'find'])

/** Element actions that must name a ref. */
const NEEDS_REF = new Set<BrowserAction>(['click', 'type', 'select', 'hover'])

/**
 * Button and link names that commit money, send something on the user's
 * behalf, or destroy data. Deliberately broad: a false positive costs one
 * extra approval in "Approve for me" mode; a false negative could be a
 * purchase.
 */
const COMMITTING =
  /\b(buy|purchase|pay|checkout|check out|place (?:your |my |the )?order|order now|complete (?:order|purchase|payment)|confirm (?:order|purchase|payment|booking)|book now|reserve|subscribe|donate|transfer|withdraw|send|post|publish|tweet|reply|comment|delete|remove|erase|destroy|trash|deactivate|close (?:my |your |the )?account|cancel (?:my |your |the )?(?:subscription|account|order|plan|membership)|unsubscribe)\b/i

/** Generic confirmations, risky only when the dialog around them is about one of the above. */
const CONFIRMING = /^(yes|ok|okay|confirm|continue|proceed|i understand|i'm sure|agree)\b/i

const SENSITIVE_FIELD =
  /card ?number|credit card|debit card|name on card|\bcvc\b|\bcvv\d?\b|\bcsc\b|security code|expir|\biban\b|routing number|account number|sort code|\bssn\b|social security|passcode|\bpin\b|one-time|verification code|\b2fa\b|two-factor/i

/** Fields whose Enter sends something to other people. */
const MESSAGE_FIELD = /\b(message|reply|comment|tweet|chat|compose)\b/i

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...BROWSER_ACTIONS] },
    url: { type: 'string', description: 'navigate, new_tab: the address to open' },
    ref: { type: 'integer', description: 'Element number from the latest snapshot' },
    text: { type: 'string', description: 'type: text to enter (replaces the field). wait: text to wait for' },
    submit: { type: 'boolean', description: 'type: press Enter afterwards' },
    key: { type: 'string', description: 'press: e.g. Enter, Escape, Tab, ArrowDown, Backspace, Control+A' },
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'scroll: default down' },
    amount: { type: 'integer', description: 'scroll: pixels (default: most of a screen)' },
    option: { type: 'string', description: 'select: the option\'s visible label or value' },
    tabId: { type: 'integer', description: 'switch_tab, close_tab: id from list_tabs' },
    selector: { type: 'string', description: 'wait: CSS selector to wait for' },
    timeout: { type: 'number', description: 'wait: seconds, default 10, max 30' },
    offset: { type: 'integer', description: 'read: where to continue from (the offset the previous read gave)' },
    all: { type: 'boolean', description: 'read: the whole page, navigation included, not just the main content' },
    fields: {
      type: 'array',
      description: 'fill: the fields to fill, in order',
      items: {
        type: 'object',
        properties: { ref: { type: 'integer' }, text: { type: 'string', description: 'Text to enter, or the option to choose in a select' } },
        required: ['ref', 'text']
      }
    }
  },
  required: ['action']
}

const DESCRIPTION = `Use the user's Chrome browser through the Eaon extension. You work in your own "Eaon" tab group; the user's other tabs are off-limits unless they share one.
Actions:
- navigate {url} / new_tab {url?} / back / forward — open pages in your current tab (a new one if you have none yet)
- snapshot — the page as numbered interactive elements ([n] role "name" state) plus its text. Call it before acting and again after the page changes
- read {offset?, all?} — the page's content as Markdown, top to bottom, in pages; for reading articles and docs. No refs
- find {text} — where text appears on the page, with refs for any controls among the matches
- click {ref} / hover {ref} / type {ref, text, submit?} / select {ref, option} / press {key, ref?}
- fill {fields: [{ref, text}]} — several form fields (text or select) in one step
- scroll {direction?, amount?, ref?} — ref alone scrolls that element into view
- wait {text? | selector? | timeout?} — for text or an element to appear; with neither, for the page to finish loading
- screenshot — an image of the visible part of the page, for when layout or visuals matter
- get_url — current tab's URL, title and loading state / reload
- list_tabs / switch_tab {tabId} / close_tab {tabId?} — tabs you may use`

const GUIDANCE = `Browser: read a page with browser {action:"snapshot"}, act on elements by their [n] ref (click, type, select, fill), then snapshot again — refs from before a navigation or a big page change are rejected. To read a long article or docs page use read (and read again with the offset it gives); to locate something on a long page use find. Prefer these to screenshots; they are cheaper. Your tabs live in the "Eaon" tab group; use the user's other tabs only if list_tabs shows them as shared. Confirm with the user before buying, paying, sending or posting anything, or deleting data, unless that is exactly what they asked for, and never enter passwords or card numbers they did not give you for this task. Input is simulated, so a few sites ignore it — if an action has no effect twice, say so instead of looping.`

interface PageMemory {
  /** Tab the extension last reported acting on. */
  currentTabId: number | null
  /** The latest snapshot's elements, per tab, so a bare ref can be described and risk-checked. */
  elements: Map<number, Map<number, SnapshotElement>>
  /** The field most recently typed into, for judging a bare `press Enter`. */
  lastTyped: { tabId: number; ref: number } | null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined
}

function label(el: SnapshotElement | undefined, ref: number | undefined): string {
  if (ref === undefined) return ''
  if (!el) return `[${ref}]`
  return `[${ref}] ${el.role}${el.name ? ` "${el.name.slice(0, 60)}"` : ''}`
}

function isSensitive(el: SnapshotElement): boolean {
  return el.inputType === 'password' || /^cc-|one-time-code/.test(el.autocomplete ?? '') || SENSITIVE_FIELD.test(el.name)
}

/** Would pressing Enter in this field send, pay for, or delete something? */
function submitIsRisky(el: SnapshotElement): boolean {
  if (isSensitive(el)) return true
  if (el.form && COMMITTING.test(el.form)) return true
  return MESSAGE_FIELD.test(el.name) && !/search|find|filter/i.test(el.name)
}

/** Buttons that spend money: an autonomous worker may post or send, but never pays. */
const SPENDING =
  /\b(buy|purchase|pay|checkout|check out|place (?:your |my |the )?order|order now|complete (?:order|purchase|payment)|confirm (?:order|purchase|payment|booking)|book now|subscribe|donate|transfer|withdraw)\b/i

function clickIsRisky(el: SnapshotElement): boolean {
  if (COMMITTING.test(el.name)) return true
  // "OK" in a "Delete 3 files?" dialog.
  return Boolean(el.context && CONFIRMING.test(el.name) && COMMITTING.test(el.context))
}

export function createBrowserTool(bridge: BrowserBridge): { tool: AgentTool; source: ToolSource } {
  const memory: PageMemory = { currentTabId: null, elements: new Map(), lastTyped: null }

  const elementFor = (ref: number | undefined): SnapshotElement | undefined => {
    if (ref === undefined || memory.currentTabId === null) return undefined
    return memory.elements.get(memory.currentTabId)?.get(ref)
  }

  const risky = (input: Record<string, unknown>): boolean => {
    const action = input.action as BrowserAction
    const ref = asInt(input.ref)
    const el = elementFor(ref)
    switch (action) {
      // This computer or the local network, from the user's own Chrome (with
      // their logins): a dev server's admin route, the router. Asked about.
      case 'navigate':
      case 'new_tab':
        return opensPrivateNetwork(asString(input.url))
      case 'fill':
        // Any field that cannot be judged, or that holds a card number or code, is asked about.
        return fieldsOf(input).some((field) => {
          const known = elementFor(field.ref)
          return !known || isSensitive(known)
        })
      case 'click':
        // A ref with no snapshot behind it cannot be judged, so it is asked about.
        return !el || clickIsRisky(el)
      case 'type':
        return !el || isSensitive(el) || (input.submit === true && submitIsRisky(el))
      case 'select':
        return !el
      case 'press': {
        if (!/enter/i.test(String(input.key ?? ''))) return false
        if (ref !== undefined) return !el || submitIsRisky(el)
        const last = memory.lastTyped
        const typed = last && last.tabId === memory.currentTabId ? elementFor(last.ref) : undefined
        return typed ? submitIsRisky(typed) : false
      }
      default:
        return false
    }
  }

  const describe = (input: Record<string, unknown>): string => {
    const action = String(input.action ?? '')
    const ref = asInt(input.ref)
    const target = label(elementFor(ref), ref)
    switch (action) {
      case 'navigate':
      case 'new_tab':
        return `${action} ${asString(input.url) ?? ''}`.trim()
      case 'type':
        return `type into ${target}${input.submit === true ? ' and submit' : ''}`
      case 'select':
        return `select "${asString(input.option) ?? ''}" in ${target}`
      case 'press':
        return `press ${asString(input.key) ?? ''}${target ? ` in ${target}` : ''}`
      case 'switch_tab':
      case 'close_tab':
        return `${action}${input.tabId !== undefined ? ` ${String(input.tabId)}` : ''}`
      case 'fill': {
        const fields = fieldsOf(input)
        return `fill ${fields.length} field${fields.length === 1 ? '' : 's'}: ${fields.map((f) => label(elementFor(f.ref), f.ref)).join(', ')}`
      }
      case 'find':
        return `find "${asString(input.text) ?? ''}"`
      default:
        return `${action} ${target}`.trim()
    }
  }

  /** The fields of a fill, keeping only well-formed ones. */
  const fieldsOf = (input: Record<string, unknown>): { ref: number; text: string }[] =>
    (Array.isArray(input.fields) ? input.fields : [])
      .map((raw) => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}))
      .map((raw) => ({ ref: asInt(raw.ref), text: typeof raw.text === 'string' ? raw.text : typeof raw.value === 'string' ? raw.value : undefined }))
      .filter((field): field is { ref: number; text: string } => field.ref !== undefined && field.text !== undefined)
      .slice(0, 50)

  const setupHelp = (): string => {
    const status = bridge.status()
    if (!status.listening) {
      return `Browser control is unavailable: ${status.error ?? 'Eaon is not listening for the extension.'} Tell the user to check Eaon → Settings → Browser extension.`
    }
    if (status.paired) {
      return 'The Eaon browser extension is paired but not connected right now. Ask the user to open Chrome (the extension reconnects within about 30 seconds) and check that the Eaon icon in the toolbar says "Connected". Do not retry until they confirm.'
    }
    return [
      'The Eaon browser extension is not connected, so the browser tool cannot run yet. Tell the user how to set it up:',
      CHROME_WEB_STORE_URL
        ? '1. Install the Eaon extension in Chrome — Eaon → Settings → Browser extension shows where to get it (Chrome Web Store, or "Load unpacked").'
        : '1. Install the Eaon extension in Chrome — Eaon → Settings → Browser extension walks through loading it with "Load unpacked" (it is not on the Chrome Web Store yet).',
      '2. In that same settings page, copy the pairing code.',
      '3. Click the Eaon icon in Chrome\'s toolbar, enter the code and press Pair.',
      'Do not retry until they say it is connected.'
    ].join('\n')
  }

  /** Builds the parameters the extension receives, or explains what is missing. */
  const paramsFor = (action: BrowserAction, input: Record<string, unknown>): Record<string, unknown> | string => {
    const ref = asInt(input.ref)
    if (NEEDS_REF.has(action) && ref === undefined) return `${action} needs "ref": an element number from the latest snapshot.`
    const params: Record<string, unknown> = {}
    if (ref !== undefined) {
      params.ref = ref
      // The extension refuses the action if the element's name has changed
      // since the snapshot: what was approved is what gets clicked, even on
      // checkout flows that relabel one button from "Next" to "Place order".
      const known = elementFor(ref)
      if (known) params.expectName = known.name
    }
    switch (action) {
      case 'navigate': {
        const url = asString(input.url)
        if (!url) return 'navigate needs "url".'
        params.url = url
        break
      }
      case 'new_tab':
        if (asString(input.url)) params.url = asString(input.url)
        break
      case 'type':
        if (typeof input.text !== 'string') return 'type needs "text".'
        params.text = input.text
        params.submit = input.submit === true
        break
      case 'select': {
        const option = asString(input.option) ?? asString(input.text)
        if (!option) return 'select needs "option": the label or value to choose.'
        params.option = option
        break
      }
      case 'press': {
        const key = asString(input.key)
        if (!key) return 'press needs "key", e.g. Enter or Escape.'
        params.key = key
        break
      }
      case 'scroll':
        params.direction = ['up', 'down', 'left', 'right'].includes(String(input.direction)) ? input.direction : 'down'
        if (asInt(input.amount) !== undefined) params.amount = asInt(input.amount)
        params.intoView = ref !== undefined && input.direction === undefined
        break
      case 'switch_tab':
      case 'close_tab': {
        const tabId = asInt(input.tabId)
        if (action === 'switch_tab' && tabId === undefined) return 'switch_tab needs "tabId" from list_tabs.'
        if (tabId !== undefined) params.tabId = tabId
        break
      }
      case 'wait': {
        if (asString(input.text)) params.text = asString(input.text)
        if (asString(input.selector)) params.selector = asString(input.selector)
        const seconds = typeof input.timeout === 'number' ? input.timeout : 10
        params.timeoutMs = Math.round(Math.min(30, Math.max(0.5, seconds)) * 1000)
        break
      }
      case 'snapshot':
        params.maxChars = 8000
        break
      case 'read': {
        const offset = asInt(input.offset)
        if (offset !== undefined && offset > 0) params.offset = offset
        if (input.all === true) params.all = true
        params.maxChars = 12000
        break
      }
      case 'find': {
        const text = asString(input.text)
        if (!text) return 'find needs "text": the words to look for on the page.'
        params.text = text
        break
      }
      case 'fill': {
        const fields = fieldsOf(input)
        if (!fields.length) return 'fill needs "fields": a list of {ref, text} from the latest snapshot.'
        // Each field carries its expected name, like a single type does.
        params.fields = fields.map((field) => {
          const known = elementFor(field.ref)
          return known ? { ...field, expectName: known.name } : field
        })
        break
      }
      default:
        break
    }
    return params
  }

  const timeoutFor = (action: BrowserAction, params: Record<string, unknown>): number => {
    if (action === 'wait') return Number(params.timeoutMs ?? 10_000) + 10_000
    if (action === 'navigate' || action === 'new_tab' || action === 'back' || action === 'forward' || action === 'reload') return 45_000
    return 30_000
  }

  const remember = (action: BrowserAction, input: Record<string, unknown>, result: Record<string, unknown>): void => {
    const tabId = asInt(result.tabId)
    if ('currentTabId' in result) memory.currentTabId = asInt(result.currentTabId) ?? null
    else if (tabId !== undefined) memory.currentTabId = tabId
    if ((action === 'snapshot' || action === 'find') && tabId !== undefined && Array.isArray(result.elements)) {
      // A snapshot describes the whole page; find adds to what is known.
      const elements = action === 'find' ? (memory.elements.get(tabId) ?? new Map<number, SnapshotElement>()) : new Map<number, SnapshotElement>()
      for (const raw of result.elements as SnapshotElement[]) {
        if (raw && typeof raw.ref === 'number') elements.set(raw.ref, { ...raw, name: String(raw.name ?? '') })
      }
      memory.elements.set(tabId, elements)
    }
    if (action === 'type' && tabId !== undefined) {
      const ref = asInt(input.ref)
      if (ref !== undefined) memory.lastTyped = { tabId, ref }
    }
    if (action === 'fill' && tabId !== undefined) {
      const last = fieldsOf(input).at(-1)
      if (last) memory.lastTyped = { tabId, ref: last.ref }
    }
    if (action === 'close_tab' && tabId !== undefined) memory.elements.delete(tabId)
  }

  const format = (action: BrowserAction, result: Record<string, unknown>): ToolResult => {
    if (action === 'screenshot' && typeof result.data === 'string') {
      const size = result.width && result.height ? ` (${String(result.width)}×${String(result.height)})` : ''
      return {
        text: `Screenshot of "${String(result.title ?? '')}" — ${String(result.url ?? '')}${size}.`,
        images: [{ mime: typeof result.mime === 'string' ? result.mime : 'image/jpeg', data: result.data }]
      }
    }
    const text = typeof result.text === 'string' ? result.text : typeof result.message === 'string' ? result.message : 'Done.'
    // The extension already budgets snapshots to ~8k characters; this is the backstop.
    return { text: capOutput(text, 9_000) }
  }

  const tool: AgentTool = {
    name: 'browser',
    description: DESCRIPTION,
    inputSchema: SCHEMA,
    mutating: (input) => !READ_ONLY.has(input.action as BrowserAction),
    risky,
    // Never unattended: card numbers, passwords and one-time codes, and any
    // button that spends money.
    catastrophic: (input) => {
      const action = input.action as BrowserAction
      if (action === 'fill') return fieldsOf(input).some((field) => { const el = elementFor(field.ref); return !el || isSensitive(el) })
      const el = elementFor(asInt(input.ref))
      if (action === 'type') return !el || isSensitive(el)
      if (action === 'click') return !el || SPENDING.test(el.name) || Boolean(el.context && CONFIRMING.test(el.name) && SPENDING.test(el.context))
      if (action === 'press' && /enter/i.test(String(input.key ?? ''))) return Boolean(el && (isSensitive(el) || (el.form && SPENDING.test(el.form))))
      return false
    },
    describe,
    run: async (input, ctx) => {
      const action = input.action as BrowserAction
      if (!BROWSER_ACTIONS.includes(action)) {
        return { text: `Unknown action "${String(input.action)}". Use one of: ${BROWSER_ACTIONS.join(', ')}.`, isError: true }
      }
      if (!bridge.connected) return { text: setupHelp(), isError: true }
      if (!bridge.supports(action)) {
        const updating = bridge.requestUpdate()
        return {
          text: `The Eaon extension in the browser (version ${bridge.extensionVersion ?? 'unknown'}) is too old for "${action}". ${
            updating
              ? 'Eaon has asked it to update, which takes a few seconds; try again shortly.'
              : 'Ask the user to update it from Eaon → Settings → Browser extension.'
          } Until then, use snapshot to read the page and type for each field.`,
          isError: true
        }
      }
      if (bridge.paused) {
        return {
          text: 'The user pressed "Stop agent control" in the Eaon extension. Do not use the browser again unless they ask you to; they can resume from the extension popup.',
          isError: true
        }
      }
      const params = paramsFor(action, input)
      if (typeof params === 'string') return { text: params, isError: true }
      try {
        const raw = await bridge.call(action, params, { signal: ctx.signal, timeoutMs: timeoutFor(action, params) })
        const result = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : { message: String(raw ?? 'Done.') }
        remember(action, input, result)
        return format(action, result)
      } catch (error) {
        if (error instanceof NotConnectedError) return { text: `${error.message}\n${setupHelp()}`, isError: true }
        return { text: error instanceof Error ? error.message : String(error), isError: true }
      }
    }
  }

  const source: ToolSource = {
    id: 'browser-extension',
    // Work only, and only the main agent: parallel sub-agents sharing one
    // browser tab would trample each other's clicks.
    tools: (query) => (query.mode === 'work' && query.depth === 0 && query.settings.browserExtension.enabled ? [tool] : []),
    guidance: () => GUIDANCE
  }

  return { tool, source }
}
