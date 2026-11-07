import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderedEditors } from '../src/shared/openTargets'
import type { OpenTarget } from '../src/shared/chatCode'

/** Opening a session in an editor: which editors are offered, and in what order. */

const targets: OpenTarget[] = [
  { id: 'vscode', label: 'Visual Studio Code', kind: 'editor' },
  { id: 'cursor', label: 'Cursor', kind: 'editor' },
  { id: 'zed', label: 'Zed', kind: 'editor' },
  { id: 'terminal', label: 'Terminal', kind: 'terminal' },
  { id: 'files', label: 'Finder', kind: 'files' }
]

test('the editor used last leads, then the others; terminals and the file manager are not editors', () => {
  assert.deepEqual(
    orderedEditors(targets, 'cursor').map((t) => t.id),
    ['cursor', 'vscode', 'zed']
  )
  assert.deepEqual(
    orderedEditors(targets, null).map((t) => t.id),
    ['vscode', 'cursor', 'zed']
  )
})

test('a remembered terminal or an editor that is gone leaves the order as found', () => {
  assert.deepEqual(
    orderedEditors(targets, 'terminal').map((t) => t.id),
    ['vscode', 'cursor', 'zed']
  )
  assert.deepEqual(
    orderedEditors(targets, 'sublime').map((t) => t.id),
    ['vscode', 'cursor', 'zed']
  )
})

test('before the editors have been looked for, or with none installed, nothing is offered', () => {
  assert.deepEqual(orderedEditors(null, 'cursor'), [])
  assert.deepEqual(orderedEditors([{ id: 'files', label: 'Finder', kind: 'files' }], null), [])
})
