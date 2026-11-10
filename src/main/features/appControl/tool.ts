import type { AppControlEnvelope, AppControlSource } from '@shared/appControl'
import type { AgentTool, ToolContext, ToolResult } from '../../agent/tools'
import { leaseOwnerOf } from '../computer/tool'
import { COMMANDS, findCommand } from './commands'
import { looksLikeRef, parseRef, labelOf } from './refs'
import { commandRisk } from './safety'
import type { AppControlService } from './service'

/**
 * App control as one tool for Eaon's own agents (Work mode, workers,
 * scheduled tasks): `app_control` with an `action` and that command's
 * arguments. Reads run freely; anything that acts goes through the usual
 * approval, and the risky ones (quit or delete shortcuts, commands typed
 * into a terminal, force quit) ask even in "Approve for me".
 */

const ACTIONS = COMMANDS.filter((command) => !command.summary.startsWith('Reserved') && !command.summary.startsWith('Needs the real pointer')).map((command) => command.name.replace(/-/g, '_'))

/** Snapshots for a model are compact text unless it asks for JSON. */
function modelArgs(command: string, input: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...args } = input
  if (command === 'snapshot' && args.compact === undefined) args.compact = true
  if (command === 'batch' && Array.isArray(args.commands)) {
    args.commands = (args.commands as Record<string, unknown>[]).map((step) => ({ ...step, command: String(step.command ?? step.action ?? '') }))
  }
  return args
}

function sourceOf(ctx: ToolContext): AppControlSource {
  const owner = leaseOwnerOf(ctx.request)
  return { kind: owner.kind, name: owner.name.trim() || (owner.kind === 'worker' ? 'A worker' : 'Eaon') }
}

/** The envelope as the model reads it: snapshots as their text, everything else as JSON. */
export function envelopeText(envelope: AppControlEnvelope): string {
  if (!envelope.ok) {
    const { code, message, hint } = envelope.error
    return `${code}: ${message}${hint ? `\n${hint}` : ''}`
  }
  const data = envelope.data as Record<string, unknown> | null
  if (data && typeof data.text === 'string') {
    const { text, ...rest } = data
    return `${JSON.stringify(rest)}\n${text}`
  }
  if (data && typeof data.guide === 'string') return data.guide
  return JSON.stringify(data, null, 1)
}

function commandOf(input: Record<string, unknown>): string {
  return typeof input.action === 'string' ? input.action : ''
}

export function appControlTool(service: AppControlService): AgentTool {
  const appNameOf = (input: Record<string, unknown>): string | null => {
    if (looksLikeRef(input.ref)) return service.refs.appOf(parseRef(input.ref))?.name ?? null
    return typeof input.app === 'string' ? input.app : null
  }
  const stepsOf = (input: Record<string, unknown>): Record<string, unknown>[] =>
    commandOf(input).replace(/_/g, '-') === 'batch' && Array.isArray(input.commands) ? (input.commands as Record<string, unknown>[]) : [input]
  const stepCommand = (step: Record<string, unknown>): string => String(step.command ?? step.action ?? '')

  return {
    name: 'app_control',
    description: [
      "Read and operate the user's desktop apps through their accessibility tree: no screenshots, and the pointer never moves, so apps can be used in the background.",
      'Observe with snapshot (app; interactive: true for only what can be operated; skeleton then root: <ref> to drill in) or find (app + role/name/text/value/id/state). Act on refs: click, type, set_value, select (option), check, uncheck, expand, scroll_to, menu (app + path "File > Save As…"), press (keys + app or ref). Each action returns the element afterwards (`after`): verify from it, or wait (ref + predicate, or app + text/window).',
      'Also: list_apps, launch, quit_app, list_windows, focus_window, move_window, resize_window, minimize, maximize, restore, close_window, list_surfaces, focused, get, is, clear, focus, toggle, collapse, scroll, double_click, right_click, clipboard_get, clipboard_set, batch (commands: [{command, …}]), guide.',
      'Refs (@s…:e12) come only from snapshot, find, list_windows, list_surfaces or focused, and go stale: never invent one.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        app: { type: 'string', description: "App name, bundle id or pid (launch: name, bundle id or .app path)" },
        ref: { type: 'string', description: 'Element ref from a snapshot, e.g. @s4k2p9xq:e12' },
        root: { type: 'string', description: 'snapshot/find: only this element and what is inside it' },
        window: { type: 'string', description: 'A window title (or ref) of the app' },
        scope: { type: 'string', enum: ['window', 'app', 'menubar'], description: 'snapshot: the focused window (default), every window, or the menu bar' },
        interactive: { type: 'boolean', description: 'snapshot/find: only what can be operated' },
        skeleton: { type: 'boolean', description: 'snapshot: a shallow map (depth 3)' },
        depth: { type: 'integer' },
        limit: { type: 'integer', description: 'Most elements to return' },
        role: { type: 'string', description: 'find: roles, comma-separated (button, textfield, menuitem, checkbox, row…)' },
        name: { type: 'string', description: 'find: part of the name' },
        text: { type: 'string', description: 'type/clipboard_set: the text. find/wait: text in names, values or descriptions' },
        value: { type: 'string', description: 'set_value: the new value. find: part of the value. wait/is: the value to compare' },
        id: { type: 'string', description: "find: the app's identifier for the element" },
        state: { type: 'string', description: 'find: states that must hold (checked, focused…). is: the one to check' },
        option: { type: 'string', description: 'select: the option to pick' },
        path: { type: 'string', description: 'menu: "File > Save As…"' },
        keys: { type: 'string', description: 'press: a key or combo, e.g. "return", "cmd+s", "ctrl+shift+tab"' },
        predicate: { type: 'string', description: 'wait: exists, gone, enabled, focused, checked, selected, expanded, visible, value, value-contains, name' },
        property: { type: 'string', description: 'get: text, value, name, bounds, states, actions or all' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        units: { type: 'integer' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        timeout: { type: 'integer', description: 'wait/launch: milliseconds' },
        ms: { type: 'integer', description: 'wait: just this many milliseconds' },
        gone: { type: 'boolean', description: 'wait: for the text or window to go away' },
        activate: { type: 'boolean', description: 'launch: bring it to the front' },
        force: { type: 'boolean', description: 'quit_app: end it at once (unsaved work is lost)' },
        wait_text: { type: 'string', description: 'After acting, wait until this text shows in the app' },
        commands: { type: 'array', items: { type: 'object' }, description: 'batch: steps like {"command":"click","ref":"…"}' }
      },
      required: ['action']
    },
    mutating: (input) => stepsOf(input).some((step) => findCommand(stepCommand(step))?.acts ?? false),
    risky: (input) => stepsOf(input).some((step) => commandRisk(stepCommand(step).replace(/_/g, '-'), step, appNameOf(step), process.platform) !== null),
    catastrophic: (input) => stepsOf(input).some((step) => {
      const command = stepCommand(step).replace(/_/g, '-')
      return command === 'press' && commandRisk(command, step, appNameOf(step), process.platform) !== null
    }),
    describe: (input) => {
      const command = commandOf(input).replace(/_/g, '-')
      if (command === 'batch') return `app control: ${stepsOf(input).length} steps`
      const target = looksLikeRef(input.ref) ? labelOf(service.refs.summary(parseRef(input.ref)), service.refs.appOf(parseRef(input.ref))) : typeof input.app === 'string' ? input.app : ''
      const extra = command === 'menu' && typeof input.path === 'string' ? ` “${input.path}”` : command === 'press' && typeof input.keys === 'string' ? ` ${input.keys}` : command === 'select' && typeof input.option === 'string' ? ` “${input.option}”` : command === 'type' && typeof input.text === 'string' ? ` (${input.text.length} characters)` : ''
      return `${command.replace(/-/g, ' ')}${extra}${target ? ` → ${target}` : ''}`
    },
    run: async (input, ctx): Promise<ToolResult | string> => {
      const command = commandOf(input)
      if (!command) return { text: 'action is required.', isError: true }
      const envelope = await service.run(command, modelArgs(command.replace(/_/g, '-'), input), sourceOf(ctx), ctx.signal)
      return envelope.ok ? envelopeText(envelope) : { text: envelopeText(envelope), isError: true }
    }
  }
}
