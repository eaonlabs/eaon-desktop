import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../src/shared/types'
import { modelName, modelSwitches } from '../src/renderer/src/components/chat/modelSwitch'
import { STASH_CAP, stashTitle, withStashed, type StashedPrompt } from '../src/renderer/src/state/stash'
import { droppedFilePaths, editorDrag, filePathOf } from '../src/renderer/src/lib/files'

/** Where a conversation changed model, prompts saved for later, and files dropped from an editor. */

const msg = (id: string, role: ChatMessage['role'], model?: string): ChatMessage => ({ id, role, parts: [], createdAt: 0, ...(model ? { model } : {}) })

test('a model switch is marked on the message whose reply ran on the new model', () => {
  const messages = [msg('u1', 'user'), msg('a1', 'assistant', 'gpt-5.5'), msg('u2', 'user'), msg('a2', 'assistant', 'gpt-5.5'), msg('u3', 'user'), msg('a3', 'assistant', 'opus-5.5')]
  assert.deepEqual([...modelSwitches(messages)], [['u3', 'opus-5.5']])
  // An older reply with no model recorded neither starts nor ends a switch.
  assert.equal(modelSwitches([msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2', 'assistant', 'x')]).size, 0)
  const providers = [{ id: 'p', models: [{ id: 'opus-5.5', label: 'Opus 5.5', providerId: 'p' }] }] as never
  assert.equal(modelName(providers, 'opus-5.5'), 'Opus 5.5')
  assert.equal(modelName(providers, 'gone'), 'gone')
})

test('a stashed prompt goes to the front, once, and the stash keeps its cap', () => {
  const p = (id: string, text: string): StashedPrompt => ({ id, text, attachments: [], at: 0 })
  let list = withStashed([], p('1', 'first'))
  list = withStashed(list, p('2', 'second'))
  list = withStashed(list, p('3', 'first'))
  assert.deepEqual(list.map((x) => x.id), ['3', '2'])
  for (let i = 0; i < STASH_CAP + 5; i++) list = withStashed(list, p(`n${i}`, `t${i}`))
  assert.equal(list.length, STASH_CAP)
  assert.equal(stashTitle(p('x', '  Fix the login bug\nand more')), 'Fix the login bug')
  assert.equal(stashTitle({ id: 'y', text: '', attachments: ['/a', '/b'], at: 0 }), '2 files')
})

test('files dragged from an editor’s tree come in as paths; web links stay text', () => {
  const drag = (data: Record<string, string>): Pick<DataTransfer, 'getData' | 'types'> => ({ types: Object.keys(data), getData: (t: string) => data[t] ?? '' })
  assert.deepEqual(droppedFilePaths(drag({ resourceurls: JSON.stringify(['file:///Users/me/app/src', 'file:///Users/me/app/My%20File.ts']) })), ['/Users/me/app/src', '/Users/me/app/My File.ts'])
  assert.deepEqual(droppedFilePaths(drag({ 'text/uri-list': 'file:///tmp/a.txt\r\nfile:///tmp/b.txt' })), ['/tmp/a.txt', '/tmp/b.txt'])
  assert.deepEqual(droppedFilePaths(drag({ 'text/uri-list': 'https://example.com/a\nfile:///tmp/a.txt' })), [])
  assert.deepEqual(droppedFilePaths(drag({ 'text/plain': 'hello' })), [])
  assert.equal(filePathOf('file:///C:/Users/me/a.ts'), 'C:/Users/me/a.ts')
  assert.equal(editorDrag(['ResourceURLs', 'text/plain']), true)
  assert.equal(editorDrag(['Files']), false)
})
