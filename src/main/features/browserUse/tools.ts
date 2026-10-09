import type { AgentTool, ToolContext, ToolResult } from '../../agent/tools'
import { browserCatastrophic, browserRisk, describeElement, PageMemory } from './policy'
import type { BrowserUseContent, BrowserUseTool } from './session'

/**
 * Browser Use's tools as the agent's tools for the user's own browser.
 * Browser Use describes them; Eaon picks which are offered and wraps each
 * call: it connects first (the browser asks the user to Allow it), keeps the
 * agent in tabs of its own, and judges risk on what the page holds.
 */

/** Offered, in this order. Left out: the ones that call a model of Browser Use's own, and its session housekeeping. */
export const OFFERED = [
  'browser_navigate',
  'browser_get_state',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_go_back',
  'browser_screenshot',
  'browser_get_html',
  'browser_list_tabs',
  'browser_switch_tab',
  'browser_close_tab'
] as const

const LOOKING = new Set(['browser_get_state', 'browser_screenshot', 'browser_get_html', 'browser_list_tabs', 'browser_scroll'])
/** What reads the page in front: refused until the agent has a tab of its own, so it never reads the user's. */
const READS_PAGE = new Set(['browser_get_state', 'browser_screenshot', 'browser_get_html', 'browser_scroll', 'browser_click', 'browser_type', 'browser_go_back'])
/** What changes which page is in front: what was read of the old one no longer applies. */
const MOVES = new Set(['browser_navigate', 'browser_go_back', 'browser_switch_tab', 'browser_close_tab'])

/** How a call reaches the browser: connect (or report why it can't), then call. */
export interface BrowserUseLink {
  connect: (ctx: ToolContext) => Promise<{ ok: true } | { ok: false; text: string }>
  call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<{ content: BrowserUseContent[]; isError: boolean }>
  /** Whether the agent has a tab of its own in this connection (reset when it reconnects). */
  ownsTab: () => boolean
  setOwnsTab: (owns: boolean) => void
}

export function toToolResult(result: { content: BrowserUseContent[]; isError: boolean }): ToolResult {
  const text = result.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
  const images = result.content.filter((c) => c.type === 'image' && c.data).map((c) => ({ mime: c.mimeType ?? 'image/png', data: c.data! }))
  return { text: text || (images.length ? 'Screenshot attached.' : 'Done.'), ...(images.length ? { images } : {}), ...(result.isError ? { isError: true } : {}) }
}

export function browserUseAgentTools(link: BrowserUseLink, tools: BrowserUseTool[], page = new PageMemory()): AgentTool[] {
  const byName = new Map(tools.map((t) => [t.name, t]))

  const run = async (name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const connected = await link.connect(ctx)
    if (!connected.ok) return { text: connected.text, isError: true }
    if (READS_PAGE.has(name) && !link.ownsTab()) {
      return {
        text: "You don't have a tab of your own yet, and the one in front is the user's. Open a page with browser_navigate first (it opens a new tab), or, if the user asked you to work in one of their tabs, switch to it with browser_switch_tab.",
        isError: true
      }
    }
    const args = { ...input }
    // The first page the agent opens is a tab of its own, never the user's current one.
    if (name === 'browser_navigate' && !link.ownsTab()) args.new_tab = true
    let result: { content: BrowserUseContent[]; isError: boolean }
    try {
      result = await link.call(name, args, ctx.signal)
    } catch (error) {
      if (ctx.signal.aborted) throw new Error('Stopped by the user.')
      return { text: (error as Error).message, isError: true }
    }
    if (!result.isError) {
      if (name === 'browser_navigate' || name === 'browser_switch_tab') link.setOwnsTab(true)
      if (MOVES.has(name)) page.forget()
      if (name === 'browser_get_state') page.remember(result.content.find((c) => c.type === 'text')?.text ?? '')
    }
    return toToolResult(result)
  }

  return OFFERED.flatMap((name) => {
    const tool = byName.get(name)
    if (!tool) return []
    const agentTool: AgentTool = {
      name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      mutating: !LOOKING.has(name),
      // Switching to or closing a tab may be the user's; the rest by what the page holds.
      risky: (input) => name === 'browser_switch_tab' || name === 'browser_close_tab' || browserRisk(name, input, page),
      catastrophic: (input) => browserCatastrophic(name, input, page),
      describe: (input) => {
        if (name === 'browser_navigate') return `open ${String(input.url ?? '')}`
        if (name === 'browser_click') return `click ${describeElement(page.get(input.index), input.index) || `at ${input.coordinate_x}, ${input.coordinate_y}`}`
        if (name === 'browser_type') return `type into ${describeElement(page.get(input.index), input.index)}`
        return name.replace(/^browser_/, '').replace(/_/g, ' ')
      },
      run: (input, ctx) => run(name, input, ctx)
    }
    return [agentTool]
  })
}

export const BROWSER_USE_GUIDANCE = `The user's own browser (browser_* tools, through Browser Use): it has their logins, so use it when they ask you to, or when a site needs their account; otherwise prefer your own browser (web_browser). Start with browser_navigate — it opens a tab of your own — then read the page with browser_get_state and act on elements by their index (browser_click, browser_type); read the page again after it changes. The user's other tabs are theirs: don't switch to, read or close them unless they asked you to. Confirm with the user before buying, paying, sending or posting anything, or deleting data, unless that is exactly what they asked for, and never type passwords or card numbers they didn't give you for this task.`
