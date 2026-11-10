import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatToolPart } from '../src/shared/types'
import { hunkChanges, patchChanges } from '../src/renderer/src/components/chatCode/changes/patch'
import { changeCounts, collectEdits } from '../src/renderer/src/components/chatCode/changes/build'
import { stepKind } from '../src/renderer/src/components/chat/workLog'
import { changingReplies } from '../src/renderer/src/components/chatCode/diskChanges'

/** Changes from calls that aren't Eaon's own edit and write: a Codex patch, a Claude multi-edit. */

const call = (name: string, input: Record<string, unknown>, status: ChatToolPart['status'] = 'done'): ChatToolPart => ({ type: 'tool', id: name, name, input, output: '', status })

test('a unified diff becomes one edit per hunk, headers and notes left out', () => {
  const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', ' keep', '-old', '+new', ' tail', '@@ -10,2 +10,3 @@', ' ten', '+added', ' eleven', '\\ No newline at end of file', ''].join('\n')
  assert.deepEqual(hunkChanges('x.ts', diff), [
    { file: 'x.ts', before: 'keep\nold\ntail\n', after: 'keep\nnew\ntail\n' },
    { file: 'x.ts', before: 'ten\neleven\n', after: 'ten\nadded\neleven\n' }
  ])
  assert.deepEqual(hunkChanges('x.ts', ''), [])
})

test('a Codex patch counts its added, updated and deleted files', () => {
  const patch = call('apply_patch', {
    files: ['new.ts', 'x.ts', 'gone.ts'],
    changes: [
      { path: 'new.ts', kind: 'add', diff: 'a\nb\n' },
      { path: 'x.ts', kind: 'update', diff: '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n' },
      { path: 'gone.ts', kind: 'delete', diff: 'one\ntwo\nthree\n' }
    ]
  })
  const changes = patchChanges(patch)
  assert.deepEqual(
    changes.map((c) => [c.file, changeCounts([c]).added, changeCounts([c]).removed, Boolean(c.created)]),
    [
      ['new.ts', 2, 0, true],
      ['x.ts', 1, 1, false],
      ['gone.ts', 0, 3, false]
    ]
  )
  // An add that comes as a diff of added lines is the same file.
  assert.equal(patchChanges(call('apply_patch', { changes: [{ path: 'n.ts', kind: 'add', diff: '@@ -0,0 +1,2 @@\n+a\n+b\n' }] }))[0].after, 'a\nb\n')
  // Unfinished or refused, it changed nothing.
  assert.deepEqual(patchChanges({ ...patch, status: 'running' }), [])
  assert.deepEqual(patchChanges({ ...patch, status: 'denied' }), [])
})

test('a Claude multi-edit is each of its edits', () => {
  const edit = call('edit_file', { path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q\nr', replace_all: true }, { bad: 1 }] })
  assert.deepEqual(patchChanges(edit), [
    { file: 'a.ts', before: 'x', after: 'y' },
    { file: 'a.ts', before: 'p', after: 'q\nr', replaceAll: true }
  ])
})

test('the Changes pane takes a patch as edits, and the work log reads it as one', () => {
  const edits = collectEdits([
    { id: 'u', role: 'user', parts: [], createdAt: 0 },
    { id: 'a', role: 'assistant', parts: [call('apply_patch', { changes: [{ path: 'n.ts', kind: 'add', diff: 'a\n' }, { path: 'x.ts', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b\n' }] })], createdAt: 0 }
  ])
  assert.deepEqual(
    edits.map((e) => [e.path, e.kind, e.turn, e.seen === true]),
    [
      ['n.ts', 'write', 1, true],
      ['x.ts', 'edit', 1, false]
    ]
  )
  assert.equal(stepKind('apply_patch'), 'edit')
})

test('the replies that could have changed files are the ones that called a tool and weren’t undone', () => {
  const parts = [call('run_command', { command: 'sed -i s/a/b/ x' })]
  assert.deepEqual(
    changingReplies([
      { id: 'u', role: 'user', parts, createdAt: 0 },
      { id: 'talk', role: 'assistant', parts: [{ type: 'text', text: 'hi' }], createdAt: 0 },
      { id: 'ran', role: 'assistant', parts, createdAt: 0 },
      { id: 'undone', role: 'assistant', parts, createdAt: 0, undone: true }
    ]),
    ['ran']
  )
})
