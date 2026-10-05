import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SHORTCUTS, formatShortcut, hasCommandModifier } from '../src/renderer/src/lib/keys'

test('shortcuts are written the platform’s way', () => {
  assert.equal(formatShortcut({ modifiers: ['shift', 'mod'], key: 'A' }, true), '⇧⌘A')
  assert.equal(formatShortcut({ modifiers: ['shift', 'mod'], key: 'A' }, false), 'Ctrl+Shift+A')
  assert.equal(formatShortcut({ modifiers: ['alt', 'mod'], key: 'N' }, true), '⌥⌘N')
  assert.equal(formatShortcut({ modifiers: ['alt', 'mod'], key: 'N' }, false), 'Ctrl+Alt+N')
  assert.equal(formatShortcut({ modifiers: [], key: 'Enter' }, true), '↩')
  assert.equal(formatShortcut({ modifiers: ['shift'], key: 'Enter' }, false), 'Shift+Enter')
  // One binding per shortcut.
  const written = SHORTCUTS.map((s) => formatShortcut(s, true))
  assert.equal(new Set(written).size, written.length)
})

test('the command modifier is ⌘ on a Mac and Ctrl elsewhere, alone', () => {
  assert.equal(hasCommandModifier({ metaKey: true, ctrlKey: false }, true), true)
  assert.equal(hasCommandModifier({ metaKey: false, ctrlKey: true }, true), false)
  assert.equal(hasCommandModifier({ metaKey: false, ctrlKey: true }, false), true)
  assert.equal(hasCommandModifier({ metaKey: true, ctrlKey: false }, false), false)
  assert.equal(hasCommandModifier({ metaKey: true, ctrlKey: true }, true), false)
})
