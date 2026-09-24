import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Point } from './geometry'
import { LineHelper } from './helper'
import type { AppRef, BackendCheck, InputBackend, MouseButton } from './input'
import { MAC_KEYCODES, MAC_MODIFIERS, type Combo } from './keys'

const run = promisify(execFile)

/**
 * macOS input: CoreGraphics events posted from a JXA (JavaScript for
 * Automation) process through the Objective-C bridge. No native module, no
 * compiler — `osascript` ships with every Mac.
 *
 * Bridge gotchas, found by probing on macOS 27:
 * - CGEventKeyboardSetUnicodeString rejects any JS value for its UniChar*
 *   argument ("Ref has incompatible type") and ignores a plain string, so it
 *   is rebound with `void *` parameters and fed an NSData's bytes.
 * - CGEventCreateScrollWheelEvent is variadic; the bridge drops the second
 *   axis. CGEventCreateScrollWheelEvent2 (macOS 13+) takes both.
 * - Enum constants come back from the bridge as strings, so the script uses
 *   numeric literals.
 * - NSWorkspace only learns about app switches on its run loop, which a
 *   script blocked on stdin never spins; `frontmost` spins it briefly first.
 * - CGEventPost is asynchronous: the pointer lands a few milliseconds after
 *   the call returns, so reading the location straight back returns the old
 *   one. Anything that reads state after posting has to wait for it.
 * - Posted events reach the lock screen too (verified with pointer moves on
 *   a locked session), so the tool refuses clicks and keys while locked.
 */
const SCRIPT = String.raw`
ObjC.import('Foundation')
ObjC.import('CoreGraphics')
ObjC.import('AppKit')
ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void *', 'unsigned long', 'void *']])
ObjC.bindFunction('AXIsProcessTrusted', ['bool', []])

var TAP = 0
var stdin = $.NSFileHandle.fileHandleWithStandardInput
var stdout = $.NSFileHandle.fileHandleWithStandardOutput
var BUTTONS = { left: [1, 2, 6, 0], right: [3, 4, 7, 1], middle: [25, 26, 27, 2] }

function ascii(text) {
  return text.replace(/[\u007f-￿]/g, function (c) { return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4) })
}
function send(message) {
  stdout.writeData($(ascii(JSON.stringify(message)) + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
}
function pause(ms) { if (ms > 0) $.NSThread.sleepForTimeInterval(ms / 1000) }
function post(event) { $.CGEventPost(TAP, event) }
function mouse(type, x, y, button) { return $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button) }

function cursor() {
  var p = $.CGEventGetLocation($.CGEventCreate(null))
  return { x: p.x, y: p.y }
}
function move(x, y) { post(mouse(5, x, y, 0)) }

function click(x, y, button, count) {
  var b = BUTTONS[button] || BUTTONS.left
  move(x, y)
  pause(40)
  for (var i = 1; i <= count; i++) {
    var down = mouse(b[0], x, y, b[3])
    // Click state is how apps tell a double click from two single clicks.
    $.CGEventSetIntegerValueField(down, 1, i)
    post(down)
    pause(25)
    var up = mouse(b[1], x, y, b[3])
    $.CGEventSetIntegerValueField(up, 1, i)
    post(up)
    if (i < count) pause(70)
  }
}

function drag(x1, y1, x2, y2) {
  move(x1, y1)
  pause(60)
  post(mouse(1, x1, y1, 0))
  pause(90)
  var steps = 24
  for (var i = 1; i <= steps; i++) {
    post(mouse(6, x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, 0))
    pause(12)
  }
  pause(90)
  post(mouse(2, x2, y2, 0))
}

function scroll(x, y, dx, dy) {
  move(x, y)
  pause(40)
  var n = Math.max(Math.abs(dx), Math.abs(dy))
  for (var i = 0; i < n; i++) {
    var sy = i < Math.abs(dy) ? (dy > 0 ? 1 : -1) : 0
    var sx = i < Math.abs(dx) ? (dx > 0 ? 1 : -1) : 0
    // Line units, three per wheel click; CoreGraphics' positive is up/left.
    post($.CGEventCreateScrollWheelEvent2(null, 1, 2, -sy * 3, -sx * 3, 0))
    pause(16)
  }
}

function keyEvent(code, down, flags) {
  var event = $.CGEventCreateKeyboardEvent(null, code, down)
  $.CGEventSetFlags(event, flags)
  return event
}

function combo(modifiers, code) {
  var flags = 0
  for (var i = 0; i < modifiers.length; i++) {
    flags |= modifiers[i].flag
    post(keyEvent(modifiers[i].code, true, flags))
    pause(8)
  }
  if (code !== null) {
    post(keyEvent(code, true, flags))
    pause(20)
    post(keyEvent(code, false, flags))
    pause(8)
  }
  for (var j = modifiers.length - 1; j >= 0; j--) {
    flags &= ~modifiers[j].flag
    post(keyEvent(modifiers[j].code, false, flags))
    pause(8)
  }
}

function typeText(text) {
  var chars = Array.from(text)
  for (var i = 0; i < chars.length; i++) {
    var ch = chars[i]
    if (ch === '\n') {
      combo([], 36)
    } else if (ch === '\t') {
      combo([], 48)
    } else {
      var data = $(ch).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding)
      var down = keyEvent(0, true, 0)
      $.CGEventKeyboardSetUnicodeString(down, data.length / 2, data.bytes)
      var up = keyEvent(0, false, 0)
      $.CGEventKeyboardSetUnicodeString(up, data.length / 2, data.bytes)
      post(down)
      post(up)
    }
    pause(6)
  }
}

function frontmost() {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02))
  var app = $.NSWorkspace.sharedWorkspace.frontmostApplication
  if (!app || app.isNil()) return null
  var bundle = app.bundleIdentifier
  return { name: ObjC.unwrap(app.localizedName) || '', pid: app.processIdentifier, bundleId: bundle.isNil() ? null : ObjC.unwrap(bundle) }
}

function activate(pid) {
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid)
  if (!app || app.isNil()) return false
  return app.activateWithOptions(2)
}

function locked() {
  var ref = $.CGSessionCopyCurrentDictionary()
  if (!ref) return false
  var dict = ObjC.castRefToObject(ref)
  var value = dict.objectForKey('CGSSessionScreenIsLocked')
  return !value.isNil() && ObjC.unwrap(value) === true
}

function handle(req) {
  switch (req.cmd) {
    case 'check': return { trusted: $.AXIsProcessTrusted(), locked: locked() }
    case 'cursor': return cursor()
    case 'move': move(req.x, req.y); return null
    case 'click': click(req.x, req.y, req.button, req.clicks); return null
    case 'drag': drag(req.x1, req.y1, req.x2, req.y2); return null
    case 'scroll': scroll(req.x, req.y, req.dx, req.dy); return null
    case 'key': combo(req.modifiers, req.code); return null
    case 'type': typeText(req.text); return null
    case 'frontmost': return frontmost()
    case 'activate': return activate(req.pid)
    case 'locked': return locked()
    default: throw new Error('unknown command ' + req.cmd)
  }
}

function main() {
  var buffer = ''
  while (true) {
    var newline = buffer.indexOf('\n')
    if (newline === -1) {
      var data = stdin.availableData
      // Empty read: Eaon closed the pipe (quit or crashed), so stop too.
      if (!data || data.length === 0) return
      buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding))
      continue
    }
    var line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    var req = null
    try {
      req = JSON.parse(line)
      var result = handle(req)
      send({ id: req.id, ok: true, result: result === undefined ? null : result })
    } catch (e) {
      send({ id: req ? req.id : -1, ok: false, error: String(e && e.message ? e.message : e) })
    }
  }
}
main()
`

export class MacInput implements InputBackend {
  readonly name = 'CoreGraphics via JXA'
  private helper = new LineHelper('JXA', '/usr/bin/osascript', () => ['-l', 'JavaScript', '-e', SCRIPT])

  async check(): Promise<BackendCheck> {
    try {
      const result = await this.helper.request<{ trusted: boolean; locked: boolean }>('check', {}, 8000)
      return {
        available: true,
        trusted: result.trusted,
        locked: result.locked,
        ...(result.trusted ? {} : { detail: 'Eaon is not allowed to control the computer yet (Accessibility).' })
      }
    } catch (error) {
      return { available: false, detail: (error as Error).message }
    }
  }

  async move(point: Point): Promise<void> {
    await this.helper.request('move', { x: point.x, y: point.y })
  }

  async click(point: Point, button: MouseButton, clicks: number): Promise<void> {
    await this.helper.request('click', { ...point, button, clicks })
  }

  async drag(from: Point, to: Point): Promise<void> {
    await this.helper.request('drag', { x1: from.x, y1: from.y, x2: to.x, y2: to.y })
  }

  async scroll(point: Point, dx: number, dy: number): Promise<void> {
    await this.helper.request('scroll', { ...point, dx, dy })
  }

  async type(text: string): Promise<void> {
    await this.helper.request('type', { text }, 30_000)
  }

  async key(combo: Combo): Promise<void> {
    const code = combo.key === null ? null : MAC_KEYCODES[combo.key]
    if (code === undefined) throw new Error(`The key "${combo.key}" has no macOS key code.`)
    await this.helper.request('key', { modifiers: combo.modifiers.map((m) => MAC_MODIFIERS[m]), code })
  }

  async cursor(): Promise<Point> {
    return this.helper.request<Point>('cursor')
  }

  async frontmost(): Promise<AppRef | null> {
    return this.helper.request<AppRef | null>('frontmost')
  }

  async activate(app: AppRef): Promise<void> {
    const ok = await this.helper.request<boolean>('activate', { pid: app.pid }).catch(() => false)
    // Since macOS 14 a background process's activation request can be
    // declined; LaunchServices (`open -b`) is honoured.
    if (!ok && app.bundleId) await run('/usr/bin/open', ['-b', app.bundleId])
  }

  async locked(): Promise<boolean> {
    return this.helper.request<boolean>('locked').catch(() => false)
  }

  async openApp(name: string): Promise<void> {
    try {
      await run('/usr/bin/open', ['-a', name], { timeout: 15_000 })
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? '').trim()
      throw new Error(stderr || `Could not open "${name}".`)
    }
  }

  dispose(): void {
    this.helper.kill()
  }
}
