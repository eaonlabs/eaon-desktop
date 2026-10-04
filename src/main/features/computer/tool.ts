import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { Display } from 'electron'
import type { AgentTool, ToolContext, ToolResult } from '../../agent/tools'
import { store } from '../../store'
import {
  ACTIONS,
  changesNothing,
  describeAction,
  INPUT_ACTIONS,
  KEYBOARD_ACTIONS,
  needsConfirmation,
  normalizeComputerInput,
  parseAction,
  riskReason,
  type Action
} from './actions'
import { inputBackend } from './backend'
import { captureDisplay, orderedDisplays, type Shot } from './capture'
import { clipRect, displayUnchanged, frameFor, regionToScreen, toScreen, toShot, type Frame, type Point, type Quality, type Rect } from './geometry'
import type { AppRef, WindowInfo } from './input'
import { formatCombo, parseCombo } from './keys'
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
 * Per chat: what the screenshots are zoomed in on, if anything — one app's
 * window (looked up again each time, since windows move) or a fixed region.
 * Sticky: the screenshot after each action shows the same zoom, so driving a
 * small window like iPhone Mirroring stays sharp step after step. A plain
 * screenshot (no app, no region) zooms back out.
 */
type Zoom = { kind: 'app'; app: string } | { kind: 'region'; rect: Rect; displayId: number }
const zooms = new Map<string, Zoom>()

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
  if (!display || !displayUnchanged(known, display)) {
    frames.delete(chatId)
    throw new Error('The display in your last screenshot was disconnected or changed resolution. Take a new screenshot first.')
  }
  return { frame: known, display, index }
}

/** Names the same window goes by: Xcode 27's DeviceHub shows the simulators Simulator.app used to. */
const ALIASES: Record<string, string[]> = { simulator: ['device hub', 'devicehub'], 'ios simulator': ['device hub', 'devicehub', 'simulator'], 'device hub': ['simulator'], devicehub: ['device hub', 'simulator'] }

/** Two names for the same app: case and spacing aside, one starting the other ("iPhone Mirroring" vs "iPhone"), or an alias. */
export function sameApp(windowApp: string, wanted: string): boolean {
  const a = windowApp.toLowerCase().replace(/\s+/g, ' ').trim()
  const b = wanted.toLowerCase().replace(/\s+/g, ' ').replace(/\.app$/, '').trim()
  return a === b || (b.length >= 3 && a.startsWith(b)) || (ALIASES[b] ?? []).includes(a)
}

/** The display that holds most of `rect`. */
function displayFor(rect: Rect): { display: Display; index: number } | null {
  const displays = orderedDisplays()
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const index = displays.findIndex((d) => cx >= d.bounds.x && cy >= d.bounds.y && cx < d.bounds.x + d.bounds.width && cy < d.bounds.y + d.bounds.height)
  return index >= 0 ? { display: displays[index], index } : null
}

/** Where a zoom points now: the display, the part of it, and how to name it. */
async function resolveZoom(zoom: Zoom): Promise<{ display: Display; index: number; region: Rect; label: string }> {
  if (zoom.kind === 'region') {
    const displays = orderedDisplays()
    const index = displays.findIndex((d) => d.id === zoom.displayId)
    const region = index >= 0 ? clipRect(zoom.rect, displays[index].bounds) : null
    if (index < 0 || !region) throw new Error('The zoomed region is no longer on a connected display. Take a plain screenshot first.')
    return { display: displays[index], index, region, label: 'Zoomed-in region' }
  }
  const backend = inputBackend()
  if (!backend.windows) throw new Error('Screenshots of a single app window are only available on macOS so far. Take a plain screenshot, or zoom with "region".')
  const all: WindowInfo[] = await backend.windows()
  // Its biggest window: a main window rather than a palette or a tooltip.
  const mine = all.filter((w) => sameApp(w.app, zoom.app) && w.width >= 40 && w.height >= 40).sort((a, b) => b.width * b.height - a.width * a.height)[0]
  if (!mine) {
    const open = [...new Set(all.map((w) => w.app).filter(Boolean))].slice(0, 12)
    throw new Error(`No window of "${zoom.app}" is on screen. Open it with open_app first${open.length ? `. Apps with windows now: ${open.join(', ')}` : ''}.`)
  }
  const rect = { x: mine.x, y: mine.y, width: mine.width, height: mine.height }
  const where = displayFor(rect)
  const region = where ? clipRect(rect, where.display.bounds) : null
  if (!where || !region) throw new Error(`The ${mine.app} window is off screen. Move it onto a display first.`)
  return { display: where.display, index: where.index, region, label: `${mine.app} window` }
}

/** Where to save a screenshot: a .png path as given, or a new file in a folder; relative paths are in the work folder. */
function savePath(cwd: string, saveTo: string): string {
  const absolute = isAbsolute(saveTo) ? saveTo : resolve(cwd, saveTo)
  if (/\.png$/i.test(absolute)) return absolute
  if (extname(absolute)) throw new Error('"save_to" must end in .png, or be a folder.')
  const at = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return join(absolute, `screen-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}-${p(at.getMilliseconds(), 3)}.png`)
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

async function capture(chatId: string, display: Display, region?: Rect, keepFull = false): Promise<Shot> {
  const shot = await captureDisplay(display, quality(), { ...(region ? { region } : {}), keepFull })
  frames.set(chatId, shot.frame)
  return shot
}

/**
 * A screenshot as this chat's zoom says: the zoomed window or region, else
 * the display it was on. `strict` (a zoom just asked for) fails rather than
 * quietly showing the whole display.
 */
async function captureCurrent(
  chatId: string,
  keepFull = false,
  strict = false
): Promise<{ shot: Shot; index: number; display: Display; label: string | null; note?: string }> {
  const zoom = zooms.get(chatId)
  if (zoom) {
    let target: Awaited<ReturnType<typeof resolveZoom>> | null = null
    try {
      target = await resolveZoom(zoom)
    } catch (error) {
      zooms.delete(chatId)
      if (strict) throw error
      // The window closed or moved away: show the whole screen and say why.
      const { display, index } = pickDisplay(chatId, undefined)
      return { shot: await capture(chatId, display, undefined, keepFull), index, display, label: null, note: `${(error as Error).message} Showing the whole display instead.` }
    }
    return { shot: await capture(chatId, target.display, target.region, keepFull), index: target.index, display: target.display, label: target.label }
  }
  const { display, index } = pickDisplay(chatId, undefined)
  return { shot: await capture(chatId, display, undefined, keepFull), index, display, label: null }
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

function shotText(shot: Shot, index: number, display: Display, cursor: Point | null, app: AppRef | null, label: string | null = null): string {
  const lines = [
    label
      ? `Screenshot of the ${label} on ${displayLabel(display, index)}: ${shot.frame.width}×${shot.frame.height} px. Give coordinates in this image's pixels; screenshots stay zoomed in like this until you take one without "app" or "region".`
      : `Screenshot of ${displayLabel(display, index)}: ${shot.frame.width}×${shot.frame.height} px. Give coordinates in this image's pixels.`
  ]
  if (cursor) {
    const p = toShot(shot.frame, cursor)
    lines.push(p ? `Pointer at (${p.x}, ${p.y}).` : label ? 'The pointer is outside this view.' : 'The pointer is on another display.')
  }
  if (app) lines.push(`Frontmost app: ${app.name}.`)
  const count = orderedDisplays().length
  if (count > 1 && !label) lines.push(`${count} displays are connected; pass "display": 0–${count - 1} to screenshot another.`)
  if (shot.warning) lines.push(`Warning: ${shot.warning}`)
  return lines.join('\n')
}

async function withScreenshot(chatId: string, head: string, cursor: Point | null): Promise<ToolResult> {
  try {
    const { shot, index, display, label, note } = await captureCurrent(chatId)
    const app = await rememberTarget(chatId)
    return {
      text: [head, note, shotText(shot, index, display, cursor, app, label)].filter(Boolean).join('\n'),
      images: [{ mime: 'image/jpeg', data: shot.jpeg.toString('base64') }]
    }
  } catch (error) {
    // The action itself happened; say so, and why there is no picture.
    return { text: `${head}\nNo screenshot: ${(error as Error).message}` }
  }
}

/** Saves a native-resolution PNG of a shot; the path, for the reply. */
async function saveShot(shot: Shot, cwd: string, saveTo: string): Promise<string> {
  if (!shot.full) throw new Error('The screenshot was taken without its full-resolution image.')
  const path = savePath(cwd, saveTo)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, shot.full.toPNG())
  return path
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
      // What to zoom into, decided against the screenshot the model is looking at now.
      if (action.app) zooms.set(chatId, { kind: 'app', app: action.app })
      else if (action.region) {
        const { frame } = currentFrame(chatId)
        zooms.set(chatId, { kind: 'region', rect: regionToScreen(frame, action.region), displayId: frame.displayId })
      } else zooms.delete(chatId)
      const keepFull = Boolean(action.saveTo)
      let taken: { shot: Shot; index: number; display: Display; label: string | null; note?: string }
      if (action.display !== undefined) {
        const { display, index } = pickDisplay(chatId, action.display)
        taken = { shot: await withEaonHidden(() => capture(chatId, display, undefined, keepFull)), index, display, label: null }
      } else {
        // An app or region just asked for that can't be shown is an error, not a quiet zoom-out.
        taken = await withEaonHidden(() => captureCurrent(chatId, keepFull, Boolean(action.app || action.region)))
      }
      const { shot, index, display, label, note } = taken
      const saved = action.saveTo ? await saveShot(shot, ctx.cwd, action.saveTo) : null
      const [cursor, app] = await Promise.all([inputBackend().cursor().catch(() => null), rememberTarget(chatId)])
      return {
        text: [note, shotText(shot, index, display, cursor, app, label), saved ? `Saved at full resolution to ${saved}.` : ''].filter(Boolean).join('\n'),
        images: [{ mime: 'image/jpeg', data: shot.jpeg.toString('base64') }]
      }
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

/**
 * Types text the model must never see — card details — into whatever has
 * keyboard focus, through the same checks and focus hand-back as `type`, and
 * with nothing echoed back: no screenshot, no count. Tab between values when
 * asked. Returns the name of the app that received them.
 */
export async function typeHidden(ctx: ToolContext, values: string[], tabBetween: boolean): Promise<string> {
  if (!store.getSettings().computerUse.enabled) {
    throw new Error('Computer use is off, so Eaon can’t type on screen. Turn it on in Settings → Computer use, or pay in your own browser (target "browser").')
  }
  const chatId = ctx.request.chatId
  const backend = inputBackend()
  const check = await backend.check()
  if (!check.available) throw new Error(`Input is unavailable on this computer: ${check.detail ?? backend.name}`)
  if (check.trusted === false) throw new Error(`macOS has not let Eaon use the keyboard: Accessibility is off for ${await permissionOwnerLabel()}.`)
  if (check.locked) throw new Error('The screen is locked.')
  beginDriving(ctx.request.messageId, ctx.signal)
  const tab = parseCombo('Tab')
  return exclusive(async () => {
    if (ctx.signal.aborted) throw new Error('Stopped by the user.')
    await ensureFocusAway(chatId, ctx.signal)
    const app = await rememberTarget(chatId)
    if (!app) throw new Error('Could not tell which app has focus. Click the first card field with the computer tool, then try again.')
    await withEaonHidden(async () => {
      for (let i = 0; i < values.length; i++) {
        if (ctx.signal.aborted) throw new Error('Stopped by the user.')
        if (i > 0 && tabBetween) {
          await backend.key(tab)
          await sleep(120, ctx.signal)
        }
        await backend.type(values[i])
      }
    })
    return app.name
  })
}

export const computerTool: AgentTool = {
  name: 'computer',
  description: [
    "See and control the user's screen with the mouse and keyboard.",
    'Actions: screenshot (display? | app? | region?, save_to?), click (x, y, button?, clicks?), move (x, y), drag (x, y → to_x, to_y), type (text), key (keys, e.g. "Return", "cmd+c", "shift+tab"), scroll (dy/dx in wheel clicks, x/y optional), wait (seconds), cursor_position, open_app (app).',
    'screenshot app: "Name" zooms in on that app\'s window (sharper for small windows like iPhone Mirroring or Simulator); region: [x, y, w, h] zooms in on part of the latest screenshot. The zoom sticks for the screenshots after each action until a plain screenshot. save_to: a .png path or folder (in the work folder) to save the screenshot at full resolution.',
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
      app: { type: 'string', description: 'open_app: application name, e.g. "Safari". screenshot: zoom in on that app\'s window' },
      display: { type: 'integer', description: 'screenshot: display number, 0 = main' },
      region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: 'screenshot: [x, y, width, height] of the latest screenshot to zoom in on' },
      save_to: { type: 'string', description: 'screenshot: .png path or folder to save it to at full resolution' },
      screenshot: { type: 'boolean', description: 'false skips the screenshot after an action, for steps chained without looking' }
    },
    required: ['action']
  },
  // Every check sees the call as it will run, aliases resolved.
  mutating: (input) => !changesNothing(normalizeComputerInput(input)),
  risky: (input) => riskReason(normalizeComputerInput(input), process.platform) !== null,
  // Destructive key combos and destructive commands typed into a terminal.
  catastrophic: (input) => riskReason(normalizeComputerInput(input), process.platform) !== null,
  describe: (input) => describeAction(normalizeComputerInput(input)),
  run: (input, ctx) => run(normalizeComputerInput(input), ctx)
}

export const COMPUTER_GUIDANCE = [
  'Computer use: start with a screenshot. Coordinates are pixels in the latest screenshot; each action returns a new one, so check it before the next step.',
  'Prefer files, shell and web tools when they can do the job; use the screen for apps that have no other way in. Prefer keyboard shortcuts to hunting for buttons.',
  "The user's iPhone: open_app \"iPhone Mirroring\" shows their real phone in a window, and clicks, scrolls and typing there act on the phone; screenshot with app: \"iPhone Mirroring\" to see it sharp. Swipe with drag; Home is cmd+1, the app switcher cmd+2, Spotlight cmd+3.",
  'To capture every screen of an app, go through it screen by screen with screenshot save_to into one folder, named in order.',
  `Eaon hides its own window from screenshots and clicks. The user can stop you with ${STOP_LABEL}. Never type passwords or card numbers yourself (payment_card fills cards when the user has set one up), and ask before sending, purchasing or deleting anything unless payment_card has authorized the purchase.`
].join('\n')

/** Forgets per-chat state; used by tests and when computer use is switched off. */
export function resetComputerState(): void {
  frames.clear()
  targets.clear()
  zooms.clear()
}
