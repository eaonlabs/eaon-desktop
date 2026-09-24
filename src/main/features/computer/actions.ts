import { isRiskyCommand } from '../../agent/approvals'
import type { MouseButton } from './input'
import { dangerousCombo, parseCombo, type Combo } from './keys'

/**
 * The `computer` tool's input, parsed and validated. Pure — no Electron, no
 * I/O — so every rule about what a call means, whether it changes anything and
 * whether it must be confirmed is unit tested in one place.
 *
 * Validation is strict and the errors are written for the model: a malformed
 * call is reported back with what to send instead, never guessed at, because
 * a guess here is a click or a keystroke in someone's app.
 */

export const ACTIONS = [
  'screenshot',
  'click',
  'move',
  'drag',
  'type',
  'key',
  'scroll',
  'wait',
  'cursor_position',
  'open_app'
] as const

export type ActionName = (typeof ACTIONS)[number]

export type Action =
  | { action: 'screenshot'; display?: number }
  | { action: 'click'; x: number; y: number; button: MouseButton; clicks: number }
  | { action: 'move'; x: number; y: number }
  | { action: 'drag'; x: number; y: number; toX: number; toY: number }
  | { action: 'type'; text: string }
  | { action: 'key'; combo: Combo; keys: string }
  | { action: 'scroll'; x: number | null; y: number | null; dx: number; dy: number }
  | { action: 'wait'; seconds: number }
  | { action: 'cursor_position' }
  | { action: 'open_app'; app: string }

export const MAX_TYPE_LENGTH = 4000
export const MAX_WAIT_SECONDS = 30
export const MAX_SCROLL = 25

/** Actions that only look. Everything else changes something outside the conversation. */
const LOOKING: ReadonlySet<string> = new Set(['screenshot', 'cursor_position', 'wait'])

/**
 * Actions "Confirm each action" stops for. Pointer moves and scrolling cannot
 * submit, delete or send anything by themselves, and asking for each one would
 * make the setting unbearable enough that people turn it off.
 */
const CONFIRMED: ReadonlySet<string> = new Set(['click', 'drag', 'type', 'key', 'open_app'])

/** Needs the pointer or keyboard, so refused while the screen is locked. */
export const INPUT_ACTIONS: ReadonlySet<string> = new Set(['click', 'drag', 'type', 'key', 'scroll'])

/** Actions whose keystrokes go to whichever app has focus, so Eaon must not be it. */
export const KEYBOARD_ACTIONS: ReadonlySet<string> = new Set(['type', 'key'])

function actionName(input: Record<string, unknown>): string {
  return typeof input.action === 'string' ? input.action.trim().toLowerCase() : ''
}

export function isLookingAction(input: Record<string, unknown>): boolean {
  return LOOKING.has(actionName(input))
}

export function needsConfirmation(input: Record<string, unknown>): boolean {
  return CONFIRMED.has(actionName(input))
}

function num(input: Record<string, unknown>, key: string, action: string): number {
  const raw = input[key]
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${action} needs "${key}" as a number (screenshot pixels).`)
  }
  return value
}

function optionalInt(input: Record<string, unknown>, key: string, fallback: number): number {
  const raw = input[key]
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`"${key}" must be a number.`)
  return Math.round(value)
}

/** Parses one call. Throws an Error whose message tells the model how to fix the call. */
export function parseAction(input: Record<string, unknown>): Action {
  const action = actionName(input)
  switch (action) {
    case 'screenshot': {
      if (input.display === undefined || input.display === null) return { action }
      const display = optionalInt(input, 'display', 0)
      if (display < 0) throw new Error('"display" is a display number from 0 (the main display).')
      return { action, display }
    }
    case 'click': {
      const button = input.button === undefined ? 'left' : String(input.button).toLowerCase()
      if (button !== 'left' && button !== 'right' && button !== 'middle') {
        throw new Error('"button" must be "left", "right" or "middle".')
      }
      const clicks = optionalInt(input, 'clicks', 1)
      if (clicks < 1 || clicks > 3) throw new Error('"clicks" must be 1, 2 or 3.')
      return { action, x: num(input, 'x', action), y: num(input, 'y', action), button, clicks }
    }
    case 'move':
      return { action, x: num(input, 'x', action), y: num(input, 'y', action) }
    case 'drag':
      return {
        action,
        x: num(input, 'x', action),
        y: num(input, 'y', action),
        toX: num(input, 'to_x', action),
        toY: num(input, 'to_y', action)
      }
    case 'type': {
      if (typeof input.text !== 'string' || input.text.length === 0) {
        throw new Error('type needs "text": the characters to type. For Return, Tab or shortcuts use action "key".')
      }
      if (input.text.length > MAX_TYPE_LENGTH) {
        throw new Error(`"text" is ${input.text.length} characters; type at most ${MAX_TYPE_LENGTH} per call. For long content, write a file instead.`)
      }
      return { action, text: input.text }
    }
    case 'key': {
      const keys = typeof input.keys === 'string' ? input.keys : typeof input.key === 'string' ? input.key : ''
      if (!keys.trim()) throw new Error('key needs "keys", e.g. "Return", "cmd+c" or "shift+tab".')
      return { action, combo: parseCombo(keys), keys: keys.trim() }
    }
    case 'scroll': {
      const dx = optionalInt(input, 'dx', 0)
      const dy = optionalInt(input, 'dy', 0)
      if (dx === 0 && dy === 0) throw new Error('scroll needs "dy" (positive scrolls down) and/or "dx" (positive scrolls right), in wheel clicks.')
      if (Math.abs(dx) > MAX_SCROLL || Math.abs(dy) > MAX_SCROLL) {
        throw new Error(`Scroll at most ${MAX_SCROLL} clicks per call, then look again.`)
      }
      const hasX = input.x !== undefined && input.x !== null
      const hasY = input.y !== undefined && input.y !== null
      if (hasX !== hasY) throw new Error('Pass both "x" and "y" for where to scroll, or neither to scroll where the pointer is.')
      return { action, x: hasX ? num(input, 'x', action) : null, y: hasY ? num(input, 'y', action) : null, dx, dy }
    }
    case 'wait': {
      const raw = input.seconds ?? input.duration ?? 1
      const seconds = typeof raw === 'string' ? Number(raw) : raw
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new Error('"seconds" must be a number ≥ 0.')
      return { action, seconds: Math.min(seconds, MAX_WAIT_SECONDS) }
    }
    case 'cursor_position':
      return { action }
    case 'open_app': {
      const app = typeof input.app === 'string' ? input.app.trim() : ''
      if (!app) throw new Error('open_app needs "app", the application name, e.g. "Safari".')
      // A leading dash would be read as an option by `open`.
      if (app.startsWith('-') || /[\n\r\0]/.test(app)) throw new Error(`"${app}" is not an application name.`)
      return { action, app }
    }
    case '':
      throw new Error(`"action" is required: one of ${ACTIONS.join(', ')}.`)
    default:
      throw new Error(`Unknown action "${String(input.action)}". Use one of ${ACTIONS.join(', ')}.`)
  }
}

/**
 * Why a call is dangerous enough that "Approve for me" must still ask, or
 * null. Covers shortcuts that quit, log out or delete, and typing something
 * that reads like a destructive shell command (into a terminal it would run).
 */
export function riskReason(input: Record<string, unknown>, platform: NodeJS.Platform): string | null {
  const action = actionName(input)
  const os = platform === 'darwin' || platform === 'win32' ? platform : 'linux'
  if (action === 'key') {
    const keys = typeof input.keys === 'string' ? input.keys : typeof input.key === 'string' ? input.key : ''
    try {
      return dangerousCombo(parseCombo(keys), os)
    } catch {
      return null // invalid calls fail in run() without doing anything
    }
  }
  if (action === 'type' && typeof input.text === 'string' && isRiskyCommand(input.text)) {
    return 'types what looks like a destructive command'
  }
  return null
}

/** One line for the approval dialog's trace and the transcript. */
export function describeAction(input: Record<string, unknown>): string {
  const action = actionName(input) || 'computer'
  const at = typeof input.x === 'number' && typeof input.y === 'number' ? ` ${Math.round(input.x)}, ${Math.round(input.y)}` : ''
  switch (action) {
    case 'drag':
      return `drag${at} → ${input.to_x}, ${input.to_y}`
    case 'type': {
      const text = typeof input.text === 'string' ? input.text : ''
      return `type "${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`
    }
    case 'key':
      return `key ${String(input.keys ?? input.key ?? '')}`
    case 'open_app':
      return `open ${String(input.app ?? '')}`
    case 'wait':
      return `wait ${String(input.seconds ?? 1)}s`
    default:
      return `${action.replace('_', ' ')}${at}`
  }
}
