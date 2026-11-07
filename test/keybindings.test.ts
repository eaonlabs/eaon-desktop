import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BINDABLE,
  bindable,
  canonicalBinding,
  conflictsFor,
  effectiveBinding,
  formatBinding,
  isDefaultBinding,
  isTerminalAppChord,
  matchesChord,
  parseBinding,
  pressedKey,
  recordBinding,
  reservedReason,
  toAccelerator,
  type KeyLike
} from '../src/shared/keybindings'
import { CHAT_SHORTCUTS, SHORTCUTS, formatShortcut } from '../src/renderer/src/lib/keys'

/** The rules every place that listens for a shortcut shares (shared/keybindings.ts). */

const press = (key: string, mods: Partial<Omit<KeyLike, 'key'>> = {}): KeyLike => ({ key, meta: false, ctrl: false, alt: false, shift: false, ...mods })

test('a binding means ⌘ on a Mac and Ctrl elsewhere, however it is written', () => {
  assert.deepEqual(parseBinding('⇧⌘A', true), { meta: true, ctrl: false, alt: false, shift: true, key: 'a' })
  assert.deepEqual(parseBinding('⇧⌘A', false), { meta: false, ctrl: true, alt: false, shift: true, key: 'a' })
  assert.deepEqual(parseBinding('Ctrl+Shift+C', false), { meta: false, ctrl: true, alt: false, shift: true, key: 'c' })
  assert.equal(canonicalBinding('⇧⌘A', false), canonicalBinding('Ctrl+Shift+A', false), 'one chord on Windows')
  assert.notEqual(canonicalBinding('⇧⌘A', true), canonicalBinding('Ctrl+Shift+A', true), 'two chords on a Mac')
  assert.equal(parseBinding('', true), null)
  assert.equal(parseBinding(null, true), null)
  assert.equal(parseBinding('⌘Banana', true), null, 'a name that is not a key')
  assert.equal(parseBinding('Hyper+K', true), null, 'a modifier that does not exist')
})

test('a key press matches only the exact chord', () => {
  assert.ok(matchesChord('⌘,', press(',', { meta: true }), true))
  assert.ok(!matchesChord('⌘,', press(',', { meta: true, shift: true }), true), '⇧⌘, is not ⌘,')
  assert.ok(!matchesChord('⌘B', press('b', { ctrl: true }), true), 'Ctrl on a Mac is the text field’s')
  assert.ok(matchesChord('⌘B', press('b', { ctrl: true }), false))
  assert.ok(!matchesChord('⌘B', press('b', { ctrl: true, alt: true }), false))
  assert.ok(matchesChord('⇧⌘A', press('A', { meta: true, shift: true }), true), 'the case of the letter does not matter')
  assert.ok(!matchesChord(null, press('a', { meta: true }), true), 'a command with no key matches nothing')
})

test('Option and Shift chords are matched by the key, not by what they type', () => {
  // ⌥⌘N: Option types ñ on a Mac.
  assert.ok(matchesChord('⌥⌘N', { ...press('ñ', { meta: true, alt: true }), code: 'KeyN' }, true))
  assert.ok(matchesChord('⇧⌘1', { ...press('!', { meta: true, shift: true }), code: 'Digit1' }, true))
  assert.ok(matchesChord('⇧⌘,', { ...press('<', { meta: true, shift: true }), code: 'Comma' }, true))
  assert.equal(pressedKey({ key: 'a', code: 'KeyQ' }), 'a', 'a letter is the letter it typed: AZERTY puts a on KeyQ')
})

test('AltGr is text, not a shortcut', () => {
  const altGr = { ...press('n', { ctrl: true, alt: true }), altGraph: true }
  assert.ok(!matchesChord('⌥⌘N', altGr, false))
  assert.ok(matchesChord('⌥⌘N', press('n', { ctrl: true, alt: true }), false))
})

test('a shortcut is written the platform’s way', () => {
  assert.equal(formatBinding('⇧⌘A', true), '⇧⌘A')
  assert.equal(formatBinding('⇧⌘A', false), 'Ctrl+Shift+A')
  assert.equal(formatBinding('⌥⌘N', true), '⌥⌘N')
  assert.equal(formatBinding('⌥⌘N', false), 'Ctrl+Alt+N')
  assert.equal(formatBinding('⌘,', false), 'Ctrl+,')
  assert.equal(formatBinding(null, true), '')
})

test('the menu gets an accelerator for each binding', () => {
  assert.equal(toAccelerator('⇧⌘A', true), 'Cmd+Shift+A')
  assert.equal(toAccelerator('⇧⌘A', false), 'Ctrl+Shift+A')
  assert.equal(toAccelerator('⌥⌘N', false), 'Ctrl+Alt+N')
  assert.equal(toAccelerator('⌘,', true), 'Cmd+,')
  assert.equal(toAccelerator(null, true), null)
  assert.equal(toAccelerator('nonsense', true), null)
})

test('a command has its default key until one is saved for it', () => {
  assert.equal(effectiveBinding('new-chat', undefined, true), '⌘N')
  assert.equal(effectiveBinding('new-chat', {}, true), '⌘N')
  assert.equal(effectiveBinding('new-chat', { 'new-chat': '⌘T' }, true), '⌘T')
  assert.equal(effectiveBinding('new-chat', { 'new-chat': null }, true), null, 'saved as none')
  assert.equal(effectiveBinding('new-chat', { 'new-chat': 'banana' }, true), '⌘N', 'a value that cannot be read is ignored')
  assert.equal(effectiveBinding('not-a-command', {}, true), null)
  assert.ok(isDefaultBinding('new-chat', { 'new-chat': 'Ctrl+N' }, false), 'the same chord written by name')
  assert.ok(!isDefaultBinding('new-chat', { 'new-chat': '⌘T' }, true))
})

test('the defaults are one key each, and the ones the page lists are the ones the app has', () => {
  const keys = BINDABLE.map((entry) => canonicalBinding(entry.default, true))
  assert.equal(new Set(keys).size, keys.length, 'two commands share a default key')
  assert.equal(new Set(BINDABLE.map((entry) => entry.id)).size, BINDABLE.length)
  // lib/keys.ts is what the page and the older code list; a default changed in one place is caught here.
  for (const shortcut of [...SHORTCUTS, ...CHAT_SHORTCUTS]) {
    const entry = bindable(shortcut.id)
    if (entry) assert.equal(formatBinding(entry.default, true), formatShortcut(shortcut, true), `${shortcut.id} has two defaults`)
  }
  for (const entry of BINDABLE) assert.equal(reservedReason(entry.default, true), null, `${entry.id} defaults to a reserved key`)
})

test('choosing a key: a modifier alone waits, and a bare letter is refused', () => {
  assert.deepEqual(recordBinding(press('Meta', { meta: true }), true), { ok: false, waiting: true })
  assert.deepEqual(recordBinding(press('Shift', { shift: true }), true), { ok: false, waiting: true })
  const bare = recordBinding(press('k'), true)
  assert.ok(!bare.ok && 'error' in bare && /⌘/.test(bare.error))
  const control = recordBinding(press('k', { ctrl: true }), true)
  assert.ok(!control.ok && 'error' in control, 'Ctrl on a Mac belongs to text fields and terminals')
  assert.deepEqual(recordBinding(press('k', { meta: true, shift: true }), true), { ok: true, binding: '⇧⌘K' })
  assert.deepEqual(recordBinding(press('k', { ctrl: true, shift: true }), false), { ok: true, binding: '⇧⌘K' }, 'stored the same on every platform')
  assert.deepEqual(recordBinding({ ...press('å', { meta: true, alt: true }), code: 'KeyA' }, true), { ok: true, binding: '⌥⌘A' })
  const arrow = recordBinding(press('ArrowUp', { meta: true }), true)
  assert.ok(!arrow.ok && 'error' in arrow)
})

test('keys that belong to the system or the editor cannot be given away', () => {
  assert.equal(reservedReason('⌘C', true), 'copies')
  assert.equal(reservedReason('Ctrl+C', false), 'copies')
  const copy = recordBinding(press('c', { meta: true }), true)
  assert.ok(!copy.ok && 'error' in copy && /copies/.test(copy.error))
  assert.ok(reservedReason('⌘K', true), 'the editor’s ask-about-the-selection')
  assert.ok(reservedReason('⌘P', true), 'quick open')
  assert.equal(reservedReason('⌘M', false), null, 'minimize is a Mac menu key only')
  assert.ok(reservedReason('⌘M', true))
  assert.equal(reservedReason('⇧⌘K', true), null)
})

test('a key another command has is reported, and a command is never its own conflict', () => {
  assert.deepEqual(conflictsFor('command-palette', '⌘B', {}, true).map((e) => e.id), ['toggle-sidebar'])
  assert.deepEqual(conflictsFor('toggle-sidebar', '⌘B', {}, true), [])
  assert.deepEqual(conflictsFor('command-palette', '⌘B', { 'toggle-sidebar': '⌘9' }, true), [], 'the sidebar moved off ⌘B')
  assert.deepEqual(conflictsFor('command-palette', '⌘9', { 'toggle-sidebar': '⌘9' }, true).map((e) => e.id), ['toggle-sidebar'])
  assert.deepEqual(conflictsFor('command-palette', '⌘B', { 'toggle-sidebar': null }, true), [], 'a command with no key holds none')
  assert.deepEqual(conflictsFor('command-palette', null, {}, true), [])
  // Written by name, still the same chord.
  assert.deepEqual(conflictsFor('command-palette', 'Ctrl+B', {}, false).map((e) => e.id), ['toggle-sidebar'])
})

test('off a Mac a terminal gives the app its chords, as set', () => {
  const ctrl = (key: string, extra: Partial<KeyLike> = {}): KeyLike => press(key, { ctrl: true, ...extra })
  assert.ok(isTerminalAppChord(ctrl('1'), {}, false), 'Ctrl+1: Chat')
  assert.ok(isTerminalAppChord(ctrl(','), {}, false), 'Ctrl+,: Settings')
  assert.ok(isTerminalAppChord(ctrl('P', { shift: true }), {}, false), 'Ctrl+Shift+P: Plugins')
  assert.ok(isTerminalAppChord(ctrl('K', { shift: true }), {}, false), 'Ctrl+Shift+K: the palette')
  assert.ok(!isTerminalAppChord(ctrl('b'), {}, false), 'Ctrl+B stays with the shell')
  assert.ok(!isTerminalAppChord(ctrl('c'), {}, false))
  // After a change it is the new key that passes, and the old one goes back to the shell.
  const moved = { 'command-palette': '⇧⌘J', 'tab-chat': '⌘9' }
  assert.ok(isTerminalAppChord(ctrl('J', { shift: true }), moved, false))
  assert.ok(!isTerminalAppChord(ctrl('K', { shift: true }), moved, false))
  assert.ok(isTerminalAppChord(ctrl('9'), moved, false))
  assert.ok(!isTerminalAppChord(ctrl('1'), moved, false))
  // A plain Ctrl letter is the shell's, whatever it is bound to.
  assert.ok(!isTerminalAppChord(ctrl('g'), { plugins: '⌘G' }, false))
})
