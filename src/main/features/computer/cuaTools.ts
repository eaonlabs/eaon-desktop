import type { AgentTool, ToolContext, ToolResult } from '../../agent/tools'
import { store } from '../../store'
import { riskReason } from './actions'
import type { CuaCallResult, CuaDriver, CuaTool } from './cua'
import { ownerLabel, REVOKED_TEXT as REVOKED } from './lease'
import { beginDriving, STOP_LABEL } from './session'
import { computerLease, leaseOwnerOf } from './tool'

/**
 * Cua Driver's tools as the agent's computer-use tools. Cua describes them
 * (read from it at runtime, so they always match the bundled version);
 * Eaon decides which are offered and wraps every call in what computer use
 * has always had: the Settings switch read live, the one-pointer lease
 * shared with every other agent, the indicator and its Stop, and approval
 * for anything that changes the screen.
 */

/** Tools offered, in this order. The rest stay out: Cua's own browser, recording, configuration, updates, installs. */
export const OFFERED = [
  'list_apps',
  'list_windows',
  'launch_app',
  'bring_to_front',
  'get_window_state',
  'get_desktop_state',
  'zoom',
  'click',
  'double_click',
  'right_click',
  'type_text',
  'set_value',
  'press_key',
  'hotkey',
  'scroll',
  'drag',
  'invoke_menu',
  'move_cursor',
  'set_window_frame',
  'verify_state',
  'get_screen_size',
  'get_cursor_position',
  'clipboard_write'
] as const

/** Tools that only look. Everything else changes something and goes through approval. */
const LOOKING = new Set(['list_apps', 'list_windows', 'get_window_state', 'get_desktop_state', 'zoom', 'verify_state', 'get_screen_size', 'get_cursor_position'])

/** Agent tool names: Cua's, prefixed so they read as one family and can't collide with another source's. */
export const PREFIX = 'desktop_'

const keysOf = (input: Record<string, unknown>): string => {
  if (Array.isArray(input.keys)) return input.keys.map(String).join('+')
  const mods = Array.isArray(input.modifiers) ? input.modifiers.map(String) : []
  return [...mods, typeof input.key === 'string' ? input.key : ''].filter(Boolean).join('+')
}

/** Why a call needs the user even in "Approve for me" (and is never run by a worker on its own), or null. */
export function cuaRisk(name: string, input: Record<string, unknown>, platform: NodeJS.Platform = process.platform): string | null {
  if (name === 'hotkey' || name === 'press_key') return riskReason({ action: 'key', keys: keysOf(input) }, platform)
  if (name === 'type_text' || name === 'set_value' || name === 'clipboard_write') {
    const text = typeof input.text === 'string' ? input.text : typeof input.value === 'string' ? input.value : ''
    return riskReason({ action: 'type', text }, platform)
  }
  return null
}

function describe(name: string, input: Record<string, unknown>): string {
  const text = typeof input.text === 'string' ? input.text : typeof input.value === 'string' ? input.value : null
  if (text !== null) return `${name.replace(/_/g, ' ')} "${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`
  if (name === 'hotkey' || name === 'press_key') return `key ${keysOf(input)}`
  if (name === 'launch_app' || name === 'bring_to_front') return `${name.replace(/_/g, ' ')} ${String(input.name ?? input.bundle_id ?? input.app ?? input.pid ?? '')}`.trim()
  if (Array.isArray(input.path)) return `menu ${input.path.map(String).join(' → ')}`
  const at = typeof input.x === 'number' && typeof input.y === 'number' ? ` ${Math.round(input.x)}, ${Math.round(input.y)}` : ''
  return `${name.replace(/_/g, ' ')}${at}`
}

/** Cua's answer as the loop's: text joined, images passed on as images. */
export function toToolResult(result: CuaCallResult): ToolResult {
  const text = result.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
  const images = result.content.filter((c) => c.type === 'image' && c.data).map((c) => ({ mime: c.mimeType ?? 'image/png', data: c.data! }))
  return { text: text || (images.length ? 'Screenshot attached.' : 'Done.'), ...(images.length ? { images } : {}), ...(result.isError ? { isError: true } : {}) }
}

async function run(driver: CuaDriver, name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // Read live: turning computer use off in Settings stops a turn already running.
  if (!store.getSettings().computerUse.enabled) return { text: 'Computer use is turned off in Settings → Computer use.', isError: true }
  if (computerLease.isRevoked(ctx.request.messageId)) return { text: REVOKED, isError: true }
  beginDriving(ctx.request.messageId, ctx.signal)
  // Looking needs no hold on the pointer; anything else waits its turn for it.
  if (!LOOKING.has(name)) {
    const held = await computerLease.acquire(leaseOwnerOf(ctx.request), {
      signal: ctx.signal,
      onWait: (holder) => ctx.progress(`Waiting for the computer — ${ownerLabel(holder)} is using it.`)
    })
    if (!held.ok) {
      if (held.reason === 'aborted') throw new Error('Stopped by the user.')
      return { text: held.text, isError: true }
    }
  }
  try {
    return toToolResult(await driver.call(name, input, ctx.signal))
  } catch (error) {
    if (ctx.signal.aborted) throw new Error('Stopped by the user.')
    return { text: (error as Error).message, isError: true }
  }
}

/** Cua's tools, as the agent sees them; only those Eaon offers, in Eaon's order. */
export function cuaAgentTools(driver: CuaDriver, tools: CuaTool[]): AgentTool[] {
  const byName = new Map(tools.map((t) => [t.name, t]))
  return OFFERED.flatMap((name) => {
    const tool = byName.get(name)
    if (!tool) return []
    const agentTool: AgentTool = {
      name: `${PREFIX}${name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
      mutating: !LOOKING.has(name),
      risky: (input) => cuaRisk(name, input) !== null,
      catastrophic: (input) => cuaRisk(name, input) !== null,
      describe: (input) => describe(name, input),
      run: (input, ctx) => run(driver, name, input, ctx)
    }
    return [agentTool]
  })
}

/** What the model is told about the desktop tools. */
export function cuaGuidance(): string {
  return [
    `Computer use (desktop_* tools, powered by Cua Driver): see and operate the user's apps through their accessibility tree. Find the app with desktop_list_apps or desktop_list_windows, read a window with desktop_get_window_state, then act on an element by its element_token (click, type_text, set_value, invoke_menu) — that is more reliable than clicking pixels. Use x, y from that window's screenshot only when an element isn't in the tree. Re-read the window after acting and before the next element action: a new read makes the old tokens stale.`,
    'Most actions happen in the background without taking over the user\'s mouse or bringing the app forward. Use delivery_mode "foreground" only for a step that didn\'t land in the background.',
    'There is one mouse and keyboard, shared by every agent on this computer. You hold them from your first action that changes something to the end of your turn; another agent that wants them waits. If you are told the computer is busy, work on what does not need the screen, and never retry in a loop. If the user takes control back, stop using the computer for this turn.',
    "Prefer files, shell and web tools when they can do the job, and your own browser (web_browser) for anything on the web. Use the desktop for apps that have no other way in.",
    `The user can stop you with ${STOP_LABEL}. Never type passwords or card numbers yourself (payment_card fills cards when the user has set one up), and ask before sending, purchasing or deleting anything unless payment_card has authorized the purchase.`
  ].join('\n')
}
