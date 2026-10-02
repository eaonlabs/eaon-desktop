import type { Display } from 'electron'
import type { AgentTool, ToolContext, ToolResult } from '../../agent/tools'
import { store } from '../../store'
import {
  ACTIONS,
  describeAction,
  INPUT_ACTIONS,
  isLookingAction,
  KEYBOARD_ACTIONS,
  needsConfirmation,
  parseAction,
  riskReason,
  type Action
} from './actions'
import { inputBackend } from './backend'
import { captureDisplay, orderedDisplays, type Shot } from './capture'
import { frameFor, sameFrame, toScreen, toShot, type Frame, type Point, type Quality } from './geometry'
import type { AppRef } from './input'
import { formatCombo } from './keys'
import { permissionOwnerLabel } from './mac'
import { beginDriving, bringEaonForward, eaonHasFocus, STOP_LABEL, withEaonHidden } from './session'

/**
 * The `computer` tool: one tool, an `action` enum, for seeing the screen and
 * driving the pointer and keyboard.
 *
 * Every action except cursor_position answers with a fresh screenshot. The
 * model needs to see what its click did before its next step anyway; handing
 * the image back with the action saves a whole model round trip per step
 * (seconds, and the full prompt prefix re-sent). It adds no images the model
 * would not have asked for: the alternative is the same screenshot one call
 * later. Cost stays bounded because history rebuilt for a new turn replays
 * only the newest image, and within a long turn old ones are cleared in
 * batches (server-side on Anthropic, `pruneInFlight` elsewhere).
 * `screenshot: false` skips the picture for steps chained without looking.
 */

/** How long the screen gets to react before the screenshot that follows an action. */
const SETTLE_MS: Partial<Record<Action['action'], number>> = {
  click: 400,
  drag: 400,
  type: 300,
  key: 400,
  scroll: 350,
  move: 150,
  open_app: 1500
}

/** Typed in slices so a stop lands between slices rather than after the whole text. */
const TYPE_CHUNK = 120

/** Per chat: the screenshot geometry the model is looking at, and the app it was working in. */
const frames = new Map<string, Frame>()
const targets = new Map<string, AppRef>()

/**
 * One action at a time across every chat: two turns interleaving clicks on
 * one screen would each be acting on a screen the other just changed.
 */
let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => {})
  return next
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Stopped by the user.'))
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('Stopped by the user.'))
      },
      { once: true }
    )
  })

const quality = (): Quality => store.getSettings().computerUse.quality ?? 'balanced'

function displayLabel(display: Display, index: number): string {
  return `display ${index}${index === 0 ? ' (main)' : ''}`
}

/** The frame coordinates in this chat refer to, checked against the displays as they are now. */
function currentFrame(chatId: string): { frame: Frame; display: Display; index: number } {
  const displays = orderedDisplays()
  const known = frames.get(chatId)
  if (!known) {
    // Acting before looking: coordinates are read as a main-display screenshot.
    const display = displays[0]
    return { frame: frameFor(display, quality()), display, index: 0 }
  }
  const index = displays.findIndex((d) => d.id === known.displayId)
  const display = displays[index]
  if (!display || !sameFrame(known, { ...known, bounds: display.bounds })) {
    frames.delete(chatId)
    throw new Error('The display in your last screenshot was disconnected or changed resolution. Take a new screenshot first.')
  }
  return { frame: known, display, index }
}

function pickDisplay(chatId: string, requested: number | undefined): { display: Display; index: number } {
  const displays = orderedDisplays()
  if (requested !== undefined) {
    const display = displays[requested]
    if (!display) {
      throw new Error(`There is no display ${requested}; this computer has ${displays.length} (0–${displays.length - 1}).`)
    }
    return { display, index: requested }
  }
  const known = frames.get(chatId)
  const index = known ? Math.max(0, displays.findIndex((d) => d.id === known.displayId)) : 0
  return { display: displays[index], index }
}

async function capture(chatId: string, display: Display): Promise<Shot> {
  const shot = await captureDisplay(display, quality())
  frames.set(chatId, shot.frame)
  return shot
}

/** Remembers the app the agent is working in, so keyboard focus can be handed back to it. */
async function rememberTarget(chatId: string): Promise<AppRef | null> {
  try {
    const app = await inputBackend().frontmost()
    if (app && app.pid !== process.pid) {
      targets.set(chatId, app)
      return app
    }
  } catch {
    /* not knowing the frontmost app only loses the focus hand-back */
  }
  return targets.get(chatId) ?? null
}

/**
 * Keystrokes go to whichever app has focus. After the user clicks Approve,
 * that is Eaon — and Eaon's approval dialog answers to Return. So before any
 * key or text, focus goes back to the app the agent was working in, and if it
 * cannot, the action is refused rather than typed into Eaon.
 */
async function ensureFocusAway(chatId: string, signal: AbortSignal): Promise<void> {
  if (!eaonHasFocus()) return
  const target = targets.get(chatId)
  if (!target) {
    throw new Error('Eaon itself has keyboard focus, so the keys would go to Eaon. Click in the app you want to type into (or use open_app) first.')
  }
  await inputBackend().activate(target)
  for (let i = 0; i < 10 && eaonHasFocus(); i++) await sleep(50, signal)
  if (eaonHasFocus()) {
    throw new Error(`Could not give keyboard focus back to ${target.name}. Click in it first, then retry.`)
  }
}

async function perform(action: Action, frame: Frame, signal: AbortSignal): Promise<string> {
  const input = inputBackend()
  const at = (x: number, y: number): Point => toScreen(frame, x, y)
  switch (action.action) {
    case 'click': {
      await input.click(at(action.x, action.y), action.button, action.clicks)
      const kind = action.clicks === 2 ? 'Double-clicked' : action.clicks === 3 ? 'Triple-clicked' : 'Clicked'
      return `${kind}${action.button === 'left' ? '' : ` (${action.button})`} at (${action.x}, ${action.y}).`
    }
    case 'move':
      await input.move(at(action.x, action.y))
      return `Moved the pointer to (${action.x}, ${action.y}).`
    case 'drag':
      await input.drag(at(action.x, action.y), at(action.toX, action.toY))
      return `Dragged from (${action.x}, ${action.y}) to (${action.toX}, ${action.toY}).`
    case 'scroll': {
      let point: Point
      if (action.x !== null && action.y !== null) point = at(action.x, action.y)
      else {
        // No position given: scroll where the pointer is if it is on this display, else its middle.
        const cursor = await input.cursor()
        point = toShot(frame, cursor) ? cursor : at(frame.width / 2, frame.height / 2)
      }
      await input.scroll(point, action.dx, action.dy)
      const parts = [action.dy ? `${Math.abs(action.dy)} ${action.dy > 0 ? 'down' : 'up'}` : '', action.dx ? `${Math.abs(action.dx)} ${action.dx > 0 ? 'right' : 'left'}` : '']
      return `Scrolled ${parts.filter(Boolean).join(' and ')}.`
    }
    case 'type': {
      const chars = Array.from(action.text)
      for (let i = 0; i < chars.length; i += TYPE_CHUNK) {
        if (signal.aborted) throw new Error('Stopped by the user.')
        await input.type(chars.slice(i, i + TYPE_CHUNK).join(''))
      }
      return `Typed ${chars.length} character${chars.length === 1 ? '' : 's'}.`
    }
    case 'key':
      await input.key(action.combo)
      return `Pressed ${formatCombo(action.combo)}.`
    case 'open_app':
      await input.openApp(action.app)
      return `Opened ${action.app}.`
    default:
      return ''
  }
}

function shotText(shot: Shot, index: number, display: Display, cursor: Point | null, app: AppRef | null): string {
  const lines = [
    `Screenshot of ${displayLabel(display, index)}: ${shot.frame.width}×${shot.frame.height} px. Give coordinates in this image's pixels.`
  ]
  if (cursor) {
    const p = toShot(shot.frame, cursor)
    lines.push(p ? `Pointer at (${p.x}, ${p.y}).` : 'The pointer is on another display.')
  }
  if (app) lines.push(`Frontmost app: ${app.name}.`)
  const count = orderedDisplays().length
  if (count > 1) lines.push(`${count} displays are connected; pass "display": 0–${count - 1} to screenshot another.`)
  if (shot.warning) lines.push(`Warning: ${shot.warning}`)
  return lines.join('\n')
}

async function withScreenshot(chatId: string, head: string, cursor: Point | null): Promise<ToolResult> {
  const { display, index } = pickDisplay(chatId, undefined)
  try {
    const shot = await capture(chatId, display)
    const app = await rememberTarget(chatId)
    return {
      text: `${head ? `${head}\n` : ''}${shotText(shot, index, display, cursor, app)}`,
      images: [{ mime: 'image/jpeg', data: shot.jpeg.toString('base64') }]
    }
  } catch (error) {
    // The action itself happened; say so, and why there is no picture.
    return { text: `${head}\nNo screenshot: ${(error as Error).message}` }
  }
}

async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | string> {
  // Read live, not from the turn's snapshot: turning computer use off in
  // Settings must stop a turn that is already running.
  const settings = store.getSettings()
  if (!settings.computerUse.enabled) {
    return { text: 'Computer use is turned off in Settings → Computer use.', isError: true }
  }
  const action = parseAction(input)
  const chatId = ctx.request.chatId
  const signal = ctx.signal
  beginDriving(ctx.request.messageId, signal)

  if (action.action === 'screenshot') {
    return exclusive(async () => {
      const { display, index } = pickDisplay(chatId, action.display)
      const shot = await withEaonHidden(() => capture(chatId, display))
      const [cursor, app] = await Promise.all([inputBackend().cursor().catch(() => null), rememberTarget(chatId)])
      return { text: shotText(shot, index, display, cursor, app), images: [{ mime: 'image/jpeg', data: shot.jpeg.toString('base64') }] }
    })
  }

  if (action.action === 'cursor_position') {
    const cursor = await inputBackend().cursor()
    const { frame, index, display } = currentFrame(chatId)
    const p = toShot(frame, cursor)
    if (p) return `The pointer is at (${p.x}, ${p.y}) in the ${frame.width}×${frame.height} screenshot of ${displayLabel(display, index)}.`
    const on = orderedDisplays().findIndex((d) => {
      const b = d.bounds
      return cursor.x >= b.x && cursor.y >= b.y && cursor.x < b.x + b.width && cursor.y < b.y + b.height
    })
    return `The pointer is not on ${displayLabel(display, index)}${on >= 0 ? `; it is on display ${on}. Screenshot that display to get coordinates there` : ''}.`
  }

  if (action.action === 'wait') {
    await sleep(action.seconds * 1000, signal)
    return exclusive(() => withEaonHidden(() => withScreenshot(chatId, `Waited ${action.seconds}s.`, null)))
  }

  // Everything below sends input.
  const backend = inputBackend()
  if (action.action !== 'open_app') {
    const check = await backend.check()
    if (!check.available) throw new Error(`Input is unavailable on this computer: ${check.detail ?? backend.name}`)
    if (check.trusted === false) {
      const who = await permissionOwnerLabel()
      throw new Error(
        `macOS has not let Eaon control the mouse and keyboard: Accessibility is off for ${who}. Tell the user to open Settings → Computer use in Eaon, which walks through it step by step, or to switch on ${who} in System Settings → Privacy & Security → Accessibility. It takes effect at once, with no restart; retry only after they have.`
      )
    }
    if (check.locked && INPUT_ACTIONS.has(action.action)) {
      throw new Error('The screen is locked; input would go to the lock screen. Ask the user to unlock the computer.')
    }
  }
  // Map before asking, so a coordinate outside the screenshot fails without a prompt.
  const { frame } = currentFrame(chatId)
  if ('x' in action && action.x !== null && action.y !== null) toScreen(frame, action.x, action.y)
  if (action.action === 'drag') toScreen(frame, action.toX, action.toY)

  const loopAsked = settings.approvalMode === 'ask' || riskReason(input, process.platform) !== null
  if (settings.computerUse.confirmEachAction && needsConfirmation(input) && !loopAsked) {
    const target = await rememberTarget(chatId)
    // The approval dialog lives in Eaon's window, which may be behind the app
    // the agent is using; bring it up without taking focus.
    bringEaonForward()
    const detail = { ...input, ...(target && action.action !== 'open_app' ? { app: target.name } : {}) }
    if (!(await ctx.confirm('computer', detail))) {
      return { text: 'The user declined this action. Do not retry it; continue another way or ask how they would like to proceed.', isError: true }
    }
  }
  if (signal.aborted) throw new Error('Stopped by the user.')
  // Chained steps (type, then Return) need no picture in between.
  const wantShot = input.screenshot !== false

  return exclusive(async () => {
    // It may have waited behind another chat's action, and been stopped meanwhile.
    if (signal.aborted) throw new Error('Stopped by the user.')
    if (KEYBOARD_ACTIONS.has(action.action)) await ensureFocusAway(chatId, signal)
    const result = await withEaonHidden(async () => {
      const head = await perform(action, frame, signal)
      if (wantShot) await sleep(SETTLE_MS[action.action] ?? 300, signal)
      if (!wantShot) return { text: head }
      const cursor = await backend.cursor().catch(() => null)
      return withScreenshot(chatId, head, cursor)
    })
    // In "Ask for approval" the next call's prompt must be visible too.
    if (settings.approvalMode === 'ask') bringEaonForward()
    return result
  })
}

export const computerTool: AgentTool = {
  name: 'computer',
  description: [
    "See and control the user's screen with the mouse and keyboard.",
    'Actions: screenshot (display?), click (x, y, button?, clicks?), move (x, y), drag (x, y → to_x, to_y), type (text), key (keys, e.g. "Return", "cmd+c", "shift+tab"), scroll (dy/dx in wheel clicks, x/y optional), wait (seconds), cursor_position, open_app (app).',
    'Coordinates are pixels in the most recent screenshot. Every action except cursor_position returns a new screenshot (pass screenshot: false to skip it when chaining steps), so do not follow an action with a separate screenshot call.'
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      x: { type: 'number', description: 'Screenshot pixels from the left (click, move, drag start, scroll)' },
      y: { type: 'number', description: 'Screenshot pixels from the top' },
      to_x: { type: 'number', description: 'drag: end x' },
      to_y: { type: 'number', description: 'drag: end y' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      clicks: { type: 'integer', minimum: 1, maximum: 3, description: '2 for a double click' },
      text: { type: 'string', description: 'type: the text to type' },
      keys: { type: 'string', description: 'key: one key or combo, e.g. "Return", "cmd+shift+t", "Page_Down"' },
      dx: { type: 'integer', description: 'scroll: wheel clicks, positive = right' },
      dy: { type: 'integer', description: 'scroll: wheel clicks, positive = down' },
      seconds: { type: 'number', description: 'wait: seconds (max 30)' },
      app: { type: 'string', description: 'open_app: application name, e.g. "Safari"' },
      display: { type: 'integer', description: 'screenshot: display number, 0 = main' },
      screenshot: { type: 'boolean', description: 'false skips the screenshot after an action, for steps chained without looking' }
    },
    required: ['action']
  },
  mutating: (input) => !isLookingAction(input),
  risky: (input) => riskReason(input, process.platform) !== null,
  // Destructive key combos and destructive commands typed into a terminal.
  catastrophic: (input) => riskReason(input, process.platform) !== null,
  describe: describeAction,
  run
}

export const COMPUTER_GUIDANCE = [
  'Computer use: start with a screenshot. Coordinates are pixels in the latest screenshot; each action returns a new one, so check it before the next step.',
  'Prefer files, shell and web tools when they can do the job; use the screen for apps that have no other way in. Prefer keyboard shortcuts to hunting for buttons.',
  `Eaon hides its own window from screenshots and clicks. The user can stop you with ${STOP_LABEL}. Never enter passwords or payment details, and ask before sending, purchasing or deleting anything.`
].join('\n')

/** Forgets per-chat state; used by tests and when computer use is switched off. */
export function resetComputerState(): void {
  frames.clear()
  targets.clear()
}
