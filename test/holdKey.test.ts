import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_HOLD_KEY, holdKeyAllowed, holdKeyLabel, isModifierCode } from '../src/shared/holdKey'

test('the default hold-to-talk key is the right Option / Alt key, a modifier', () => {
  assert.equal(DEFAULT_HOLD_KEY, 'AltRight')
  assert.ok(isModifierCode(DEFAULT_HOLD_KEY))
  assert.ok(!isModifierCode('F13'))
})

test('only keys that type nothing in a terminal can be held to talk', () => {
  for (const code of ['AltRight', 'MetaLeft', 'ControlRight', 'ShiftLeft', 'F5', 'F13', 'F24', 'Pause', 'ScrollLock']) assert.ok(holdKeyAllowed(code), code)
  for (const code of ['KeyA', 'Space', 'Enter', 'Escape', 'Backspace', 'ArrowUp', 'Tab', 'CapsLock', 'F25', 'Digit1']) assert.ok(!holdKeyAllowed(code), code)
})

test('keys are named the way each platform labels them', () => {
  assert.equal(holdKeyLabel('AltRight', true), 'Right Option ⌥')
  assert.equal(holdKeyLabel('AltRight', false), 'Right Alt')
  assert.equal(holdKeyLabel('MetaLeft', true), 'Left Command ⌘')
  assert.equal(holdKeyLabel('MetaLeft', false), 'Left Windows')
  assert.equal(holdKeyLabel('ControlRight', false), 'Right Ctrl')
  assert.equal(holdKeyLabel('F13', true), 'F13')
  assert.equal(holdKeyLabel('ScrollLock', false), 'Scroll Lock')
})
