import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolsFor, type ToolContext, type ToolQuery } from '../src/main/agent/tools'
import { store, defaultSettings } from '../src/main/store'
import { describeAction, needsConfirmation, parseAction, riskReason } from '../src/main/features/computer/actions'
import { frameFor, sameFrame, targetSize, toScreen, toShot, type Frame } from '../src/main/features/computer/geometry'
import { setInputBackend } from '../src/main/features/computer/backend'
import { asciiJson } from '../src/main/features/computer/helper'
import type { InputBackend } from '../src/main/features/computer/input'
import { dangerousCombo, formatCombo, MAC_KEYCODES, parseCombo, windowsKey, xdotoolKey } from '../src/main/features/computer/keys'
import '../src/main/features/computerUse'
import { computerTool } from '../src/main/features/computer/tool'

/* ------------------------------------------------------------- geometry */

test('screenshots are downscaled to the quality long edge and never upscaled', () => {
  // This Mac: 1710×1112 pt at 2× = 3420×2224 px.
  assert.deepEqual(targetSize(3420, 2224, 'balanced'), { width: 1280, height: 832 })
  assert.deepEqual(targetSize(3420, 2224, 'sharp'), { width: 1600, height: 1040 })
  assert.deepEqual(targetSize(1024, 768, 'balanced'), { width: 1024, height: 768 })
  // Portrait: the long edge is the height.
  assert.deepEqual(targetSize(2160, 3840, 'balanced'), { width: 720, height: 1280 })
})

test('screenshot pixels map to screen points through the display bounds', () => {
  const retina = frameFor({ id: 1, bounds: { x: 0, y: 0, width: 1710, height: 1112 }, scaleFactor: 2 }, 'balanced')
  assert.equal(retina.width, 1280)
  assert.equal(retina.height, 832)
  assert.deepEqual(toScreen(retina, 0, 0), { x: 0, y: 0 })
  assert.deepEqual(toScreen(retina, 640, 416), { x: 855, y: 556 })
  const corner = toScreen(retina, 1279, 831)
  assert.ok(Math.abs(corner.x - 1708.66) < 0.01 && Math.abs(corner.y - 1110.66) < 0.01)

  // A 1× display to the left of the main one, with a negative origin.
  const left = frameFor({ id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }, 'balanced')
  assert.deepEqual({ w: left.width, h: left.height }, { w: 1280, h: 720 })
  assert.deepEqual(toScreen(left, 640, 360), { x: -960, y: 540 })
  assert.deepEqual(toScreen(left, 0, 0), { x: -1920, y: 0 })
})

test('points round-trip back to screenshot pixels, and other displays are reported as off-frame', () => {
  const frame: Frame = { displayId: 1, bounds: { x: 0, y: 0, width: 1710, height: 1112 }, width: 1280, height: 832 }
  for (const [x, y] of [[0, 0], [100, 200], [640, 416], [1279, 831]]) {
    assert.deepEqual(toShot(frame, toScreen(frame, x, y)), { x, y })
  }
  // The bottom point row is inside the image, not one past it.
  assert.deepEqual(toShot(frame, { x: 1709.9, y: 1111.9 }), { x: 1279, y: 831 })
  assert.equal(toShot(frame, { x: -5, y: 10 }), null)
  assert.equal(toShot(frame, { x: 1710, y: 10 }), null)
})

test('coordinates outside the screenshot are an error, not clamped', () => {
  const frame: Frame = { displayId: 1, bounds: { x: 0, y: 0, width: 1710, height: 1112 }, width: 1280, height: 832 }
  assert.throws(() => toScreen(frame, 1280, 10), /outside the screenshot, which is 1280×832/)
  assert.throws(() => toScreen(frame, -1, 10), /outside/)
  assert.throws(() => toScreen(frame, Number.NaN, 10), /must be numbers/)
})

test('sameFrame notices a resolution change', () => {
  const a: Frame = { displayId: 1, bounds: { x: 0, y: 0, width: 1710, height: 1112 }, width: 1280, height: 832 }
  assert.equal(sameFrame(a, { ...a }), true)
  assert.equal(sameFrame(a, { ...a, bounds: { ...a.bounds, width: 1470 } }), false)
})

/* ----------------------------------------------------------------- keys */

test('key combos parse in the dialects models write', () => {
  assert.deepEqual(parseCombo('cmd+c'), { modifiers: ['cmd'], key: 'c' })
  assert.deepEqual(parseCombo('Command+Shift+T'), { modifiers: ['shift', 'cmd'], key: 't' })
  assert.deepEqual(parseCombo('shift+tab'), { modifiers: ['shift'], key: 'tab' })
  assert.deepEqual(parseCombo('Return'), { modifiers: [], key: 'return' })
  assert.deepEqual(parseCombo('enter'), { modifiers: [], key: 'return' })
  assert.deepEqual(parseCombo('ctrl+Page_Down'), { modifiers: ['ctrl'], key: 'pagedown' })
  assert.deepEqual(parseCombo('option + left'), { modifiers: ['alt'], key: 'left' })
  assert.deepEqual(parseCombo('F12'), { modifiers: [], key: 'f12' })
  assert.deepEqual(parseCombo('cmd++'), { modifiers: ['shift', 'cmd'], key: 'equal' })
  assert.deepEqual(parseCombo('shift'), { modifiers: ['shift'], key: null })
  assert.equal(formatCombo(parseCombo('ctrl+alt+Delete')), 'ctrl+alt+delete')
})

test('malformed combos are rejected rather than guessed', () => {
  assert.throws(() => parseCombo(''), /empty/)
  assert.throws(() => parseCombo('cmd+c cmd+v'), /more than one combo/)
  assert.throws(() => parseCombo('cmd+a+b'), /more than one key/)
  assert.throws(() => parseCombo('cmd+'), /not a valid combo/)
  assert.throws(() => parseCombo('hyper+x'), /Unknown key "hyper"/)
  assert.throws(() => parseCombo('⌘c'), /Unknown key/)
})

test('every named key has a code on each platform', () => {
  for (const key of ['return', 'tab', 'space', 'escape', 'backspace', 'delete', 'left', 'pagedown', 'f5', 'a', '7', 'slash']) {
    assert.equal(typeof MAC_KEYCODES[key], 'number', `mac ${key}`)
    assert.ok(windowsKey(key), `windows ${key}`)
  }
  assert.equal(xdotoolKey('pagedown'), 'Next')
  assert.equal(xdotoolKey('f5'), 'F5')
  assert.deepEqual(windowsKey('a'), { vk: 0x41, ext: false })
  assert.deepEqual(windowsKey('left'), { vk: 0x25, ext: true })
})

test('combos that quit, log out or delete are flagged', () => {
  assert.match(dangerousCombo(parseCombo('cmd+q'), 'darwin') ?? '', /quits/)
  assert.match(dangerousCombo(parseCombo('cmd+shift+q'), 'darwin') ?? '', /logs you out/)
  assert.match(dangerousCombo(parseCombo('cmd+backspace'), 'darwin') ?? '', /Trash/)
  assert.match(dangerousCombo(parseCombo('alt+f4'), 'win32') ?? '', /closes/)
  assert.equal(dangerousCombo(parseCombo('cmd+c'), 'darwin'), null)
  assert.equal(dangerousCombo(parseCombo('Return'), 'darwin'), null)
})

/* -------------------------------------------------------------- actions */

test('actions parse with defaults and precise errors', () => {
  assert.deepEqual(parseAction({ action: 'click', x: 10, y: 20 }), { action: 'click', x: 10, y: 20, button: 'left', clicks: 1 })
  assert.deepEqual(parseAction({ action: 'click', x: '10', y: 20, button: 'right', clicks: 2 }), {
    action: 'click', x: 10, y: 20, button: 'right', clicks: 2
  })
  assert.deepEqual(parseAction({ action: 'drag', x: 1, y: 2, to_x: 3, to_y: 4 }), { action: 'drag', x: 1, y: 2, toX: 3, toY: 4 })
  assert.deepEqual(parseAction({ action: 'scroll', dy: 3 }), { action: 'scroll', x: null, y: null, dx: 0, dy: 3 })
  assert.deepEqual(parseAction({ action: 'key', key: 'cmd+c' }).action, 'key')
  assert.deepEqual(parseAction({ action: 'wait', seconds: 120 }), { action: 'wait', seconds: 30 })
  assert.deepEqual(parseAction({ action: 'screenshot', display: 1 }), { action: 'screenshot', display: 1 })

  assert.throws(() => parseAction({}), /"action" is required/)
  assert.throws(() => parseAction({ action: 'teleport' }), /Unknown action "teleport"/)
  assert.throws(() => parseAction({ action: 'click', x: 10 }), /needs "y"/)
  assert.throws(() => parseAction({ action: 'click', x: 1, y: 1, clicks: 5 }), /1, 2 or 3/)
  assert.throws(() => parseAction({ action: 'type', text: '' }), /needs "text"/)
  assert.throws(() => parseAction({ action: 'type', text: 'x'.repeat(5000) }), /at most/)
  assert.throws(() => parseAction({ action: 'scroll' }), /needs "dy"/)
  assert.throws(() => parseAction({ action: 'scroll', dy: 1, x: 5 }), /both "x" and "y"/)
  assert.throws(() => parseAction({ action: 'open_app', app: '-a Terminal' }), /not an application name/)
  assert.throws(() => parseAction({ action: 'key', keys: 'cmd+nonsense' }), /Unknown key/)
})

test('only looking actions are read-only, so plan mode keeps screenshots', () => {
  const ctx = {} as ToolContext
  const mutating = computerTool.mutating as (input: Record<string, unknown>, ctx: ToolContext) => boolean
  assert.equal(typeof computerTool.mutating, 'function')
  for (const action of ['screenshot', 'cursor_position', 'wait']) assert.equal(mutating({ action }, ctx), false, action)
  for (const action of ['click', 'move', 'drag', 'type', 'key', 'scroll', 'open_app']) assert.equal(mutating({ action }, ctx), true, action)
})

test('clicks, keys, typing and app launches are confirmed; pointer moves and scrolls are not', () => {
  for (const action of ['click', 'drag', 'type', 'key', 'open_app']) assert.equal(needsConfirmation({ action }), true, action)
  for (const action of ['move', 'scroll', 'screenshot', 'wait', 'cursor_position']) assert.equal(needsConfirmation({ action }), false, action)
})

test('dangerous combos and destructive-looking text are risky', () => {
  assert.ok(riskReason({ action: 'key', keys: 'cmd+q' }, 'darwin'))
  assert.ok(riskReason({ action: 'type', text: 'rm -rf ~/Documents\n' }, 'darwin'))
  assert.equal(riskReason({ action: 'key', keys: 'cmd+c' }, 'darwin'), null)
  assert.equal(riskReason({ action: 'type', text: 'hello world' }, 'darwin'), null)
  assert.equal(riskReason({ action: 'click', x: 1, y: 1 }, 'darwin'), null)
  assert.equal(describeAction({ action: 'click', x: 10.4, y: 20 }), 'click 10, 20')
  assert.equal(describeAction({ action: 'key', keys: 'cmd+c' }), 'key cmd+c')
})

test('the helper wire is ASCII only', () => {
  const line = asciiJson({ text: 'café — 日本 😀' })
  assert.ok(/^[\x00-\x7e]*$/.test(line))
  assert.deepEqual(JSON.parse(line), { text: 'café — 日本 😀' })
})

/* ----------------------------------------------------------- tool source */

function query(overrides: Partial<ToolQuery> = {}): ToolQuery {
  return { mode: 'work', cwd: '/tmp', depth: 0, readOnly: false, settings: store.getSettings(), request: {} as ToolQuery['request'], ...overrides }
}

test('the computer tool is offered only when enabled, in Work, to the main agent', () => {
  const names = (q: ToolQuery): string[] => toolsFor(q).map((t) => t.name)
  store.patchSettings({ computerUse: { ...defaultSettings.computerUse, enabled: false } })
  assert.ok(!names(query()).includes('computer'))

  store.patchSettings({ computerUse: { ...defaultSettings.computerUse, enabled: true } })
  assert.ok(names(query()).includes('computer'))
  assert.ok(names(query({ readOnly: true })).includes('computer'), 'plan mode keeps it for screenshots')
  assert.ok(!names(query({ mode: 'chat' })).includes('computer'))
  assert.ok(!names(query({ depth: 1 })).includes('computer'), 'swarm sub-agents do not get it')
  store.patchSettings({ computerUse: { ...defaultSettings.computerUse } })
})

test('the tool refuses to act while computer use is off, even mid-turn', async () => {
  store.patchSettings({ computerUse: { ...defaultSettings.computerUse, enabled: false } })
  const result = await computerTool.run({ action: 'screenshot' }, { request: { chatId: 'c', messageId: 'm' } } as ToolContext)
  assert.equal(typeof result === 'object' && result.isError, true)
  assert.match(typeof result === 'string' ? result : result.text, /turned off/)
})

test('without Accessibility, input is refused with the switch to flip and the setup page to follow', async () => {
  const sent: string[] = []
  const untrusted: InputBackend = {
    name: 'untrusted',
    check: async () => ({ available: true, trusted: false, locked: false }),
    move: async () => void sent.push('move'),
    click: async () => void sent.push('click'),
    drag: async () => void sent.push('drag'),
    scroll: async () => void sent.push('scroll'),
    type: async () => void sent.push('type'),
    key: async () => void sent.push('key'),
    cursor: async () => ({ x: 0, y: 0 }),
    frontmost: async () => null,
    activate: async () => {},
    locked: async () => false,
    openApp: async () => {},
    dispose: () => {}
  }
  setInputBackend(untrusted)
  store.patchSettings({ computerUse: { ...defaultSettings.computerUse, enabled: true } })
  const controller = new AbortController()
  try {
    // A refusal is a result the model can read (isError), not a thrown error.
    const result = (await computerTool.run({ action: 'click', x: 10, y: 10 }, { request: { chatId: 'ax', messageId: 'ax-m' }, signal: controller.signal } as ToolContext)) as { text: string; isError?: boolean }
    assert.equal(result.isError, true)
    assert.match(result.text, /System Settings → Privacy & Security → Accessibility/)
    assert.match(result.text, /Settings → Computer use/)
    assert.deepEqual(sent, [], 'nothing was sent')
  } finally {
    controller.abort()
    setInputBackend(null)
    store.patchSettings({ computerUse: { ...defaultSettings.computerUse } })
  }
})
