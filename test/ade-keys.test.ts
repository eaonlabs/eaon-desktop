import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adeKeyAction, paneAfter, sessionAfter, type KeyLike } from '../src/shared/adeKeys'
import { ADE_SHORTCUTS, CHAT_SHORTCUTS, SHORTCUTS, formatShortcut } from '../src/renderer/src/lib/keys'
import { groupSessions, visibleSessions, type AdeSession } from '../src/shared/adeSessions'

/**
 * The ADE's keyboard shortcuts: which chord asks for what (by the physical
 * key, so ⌥1 and ⇧] work whatever character they type), what a terminal must
 * let through, how panes and sessions are stepped, and that the Shortcuts
 * page lists them without a clash.
 */

const key = (over: Partial<KeyLike> & { key?: string; code?: string }): KeyLike => ({
  key: '',
  code: '',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over
})

test('⇧⌘] and ⇧⌘[ step through the terminals, whatever the layout types for them', () => {
  // On a US layout ⇧] types }; the physical key is what counts.
  assert.deepEqual(adeKeyAction(key({ metaKey: true, shiftKey: true, key: '}', code: 'BracketRight' }), true), { do: 'pane', step: 1 })
  assert.deepEqual(adeKeyAction(key({ metaKey: true, shiftKey: true, key: '{', code: 'BracketLeft' }), true), { do: 'pane', step: -1 })
  // Ctrl+Shift elsewhere.
  assert.deepEqual(adeKeyAction(key({ ctrlKey: true, shiftKey: true, key: '}', code: 'BracketRight' }), false), { do: 'pane', step: 1 })
})

test('⌥⌘1 to ⌥⌘9 open sessions, though ⌥1 types ¡; ⌥⌘↓ and ⌥⌘↑ step', () => {
  assert.deepEqual(adeKeyAction(key({ metaKey: true, altKey: true, key: '¡', code: 'Digit1' }), true), { do: 'session', index: 0 })
  assert.deepEqual(adeKeyAction(key({ metaKey: true, altKey: true, key: '9', code: 'Digit9' }), true), { do: 'session', index: 8 })
  assert.equal(adeKeyAction(key({ metaKey: true, altKey: true, key: '0', code: 'Digit0' }), true), null)
  assert.deepEqual(adeKeyAction(key({ metaKey: true, altKey: true, key: 'ArrowDown', code: 'ArrowDown' }), true), { do: 'session-step', step: 1 })
  assert.deepEqual(adeKeyAction(key({ metaKey: true, altKey: true, key: 'ArrowUp', code: 'ArrowUp' }), true), { do: 'session-step', step: -1 })
})

test('⇧⌘↩ fills the view with a terminal and ⇧⌘N asks for a new session', () => {
  assert.deepEqual(adeKeyAction(key({ metaKey: true, shiftKey: true, key: 'Enter', code: 'Enter' }), true), { do: 'maximize' })
  assert.deepEqual(adeKeyAction(key({ metaKey: true, shiftKey: true, key: 'N', code: 'KeyN' }), true), { do: 'new-session' })
})

test('the app’s own chords and the shell’s are not the ADE’s', () => {
  // ⌘1 to ⌘3 switch tabs, ⌘N is a new chat, ⌘B the sidebar, ⌘F is find (handled by the terminal itself).
  assert.equal(adeKeyAction(key({ metaKey: true, key: '1', code: 'Digit1' }), true), null)
  assert.equal(adeKeyAction(key({ metaKey: true, key: 'n', code: 'KeyN' }), true), null)
  assert.equal(adeKeyAction(key({ metaKey: true, key: 'b', code: 'KeyB' }), true), null)
  assert.equal(adeKeyAction(key({ metaKey: true, key: 'f', code: 'KeyF' }), true), null)
  // Ctrl on a Mac belongs to the shell, and a bare Ctrl chord elsewhere too.
  assert.equal(adeKeyAction(key({ ctrlKey: true, shiftKey: true, key: '}', code: 'BracketRight' }), true), null)
  assert.equal(adeKeyAction(key({ ctrlKey: true, key: ']', code: 'BracketRight' }), false), null)
  assert.equal(adeKeyAction(key({ shiftKey: true, key: 'Enter', code: 'Enter' }), true), null)
  // ⌘ and Ctrl together, or ⌘ with the wrong extra key, are nothing of ours.
  assert.equal(adeKeyAction(key({ metaKey: true, ctrlKey: true, shiftKey: true, key: 'Enter', code: 'Enter' }), true), null)
  assert.equal(adeKeyAction(key({ metaKey: true, altKey: true, shiftKey: true, key: '1', code: 'Digit1' }), true), null)
})

test('on Windows AltGr (reported as Ctrl+Alt) does not count as Ctrl+Alt', () => {
  const altGr: KeyLike = { ...key({ ctrlKey: true, altKey: true, key: '@', code: 'Digit2' }), getModifierState: () => true }
  assert.equal(adeKeyAction(altGr, false), null)
  const real: KeyLike = { ...key({ ctrlKey: true, altKey: true, key: '2', code: 'Digit2' }), getModifierState: () => false }
  assert.deepEqual(adeKeyAction(real, false), { do: 'session', index: 1 })
})

test('stepping through panes wraps round, and starts at the first (or last) when none was focused', () => {
  const ids = ['a', 'b', 'c']
  assert.equal(paneAfter(ids, 'a', 1), 'b')
  assert.equal(paneAfter(ids, 'c', 1), 'a')
  assert.equal(paneAfter(ids, 'a', -1), 'c')
  assert.equal(paneAfter(ids, null, 1), 'a')
  assert.equal(paneAfter(ids, 'gone', -1), 'c')
  assert.equal(paneAfter([], 'a', 1), null)
})

const session = (id: string, project: string, cwd: string, createdAt: number): AdeSession => ({ id, title: null, project, cwd, branch: null, repo: true, worktree: cwd !== project, createdAt })

test('"session 3" is the third row the sidebar shows: a folded project’s sessions are not counted', () => {
  const sessions = [
    session('a', '/p/web', '/p/web', 1),
    session('b', '/p/web', '/w/web/one', 2),
    session('c', '/p/web', '/w/web/two', 3),
    session('d', '/p/api', '/p/api', 4)
  ]
  const groups = groupSessions(sessions, ['/p/web', '/p/api'])
  assert.deepEqual(
    visibleSessions(groups, {}).map((s) => s.id),
    ['a', 'c', 'b', 'd']
  )
  assert.deepEqual(
    visibleSessions(groups, { '/p/web': true }).map((s) => s.id),
    ['d']
  )
  // A project that is just its own folder is one row and cannot be folded.
  assert.deepEqual(
    visibleSessions(groups, { '/p/api': true }).map((s) => s.id),
    ['a', 'c', 'b', 'd']
  )
  const list = visibleSessions(groups, {})
  assert.equal(sessionAfter(list, 'd', 1)?.id, 'a')
  assert.equal(sessionAfter(list, 'a', -1)?.id, 'd')
  assert.equal(sessionAfter(list, null, 1)?.id, 'a')
  assert.equal(sessionAfter([], null, 1), null)
})

test('the Shortcuts page lists the ADE keys, each once; ⌘F is find in a terminal as it is in a chat', () => {
  const mac = [...SHORTCUTS, ...CHAT_SHORTCUTS, ...ADE_SHORTCUTS].map((s) => formatShortcut(s, true))
  // Find in the conversation (⌘F) is Chat's; in a terminal the same ⌘F finds there.
  const taken = ADE_SHORTCUTS.map((s) => formatShortcut(s, true)).filter((w) => mac.filter((x) => x === w).length > 1)
  assert.deepEqual(taken, ['⌘F'])
  const other = ADE_SHORTCUTS.map((s) => formatShortcut(s, false))
  assert.equal(new Set(other).size, other.length)
  assert.equal(formatShortcut(ADE_SHORTCUTS[0], true), '⌘F')
  assert.equal(formatShortcut(ADE_SHORTCUTS[0], false), 'Ctrl+Shift+F')
  assert.equal(formatShortcut({ modifiers: ['alt', 'mod'], key: '1–9' }, true), '⌥⌘1–9')
})
