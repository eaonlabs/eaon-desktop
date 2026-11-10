import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  nameFor,
  parseSavedPrompts,
  previewOf,
  PROMPT_COUNT_LIMIT,
  PROMPT_NAME_LIMIT,
  PROMPT_TEXT_LIMIT,
  removePrompt,
  savePrompt,
  searchPrompts,
  type SavedPrompt
} from '@shared/savedPrompts'
import { deleteSavedPrompt, listSavedPrompts, resetSavedPromptsForTests, saveSavedPrompt } from '../src/main/features/savedPrompts'
import { savedPromptItems } from '../src/renderer/src/components/composer/promptItems'
import { rankItems } from '../src/renderer/src/components/composer/suggest'
import { usePrompts } from '../src/renderer/src/state/prompts'
import { store } from '../src/main/store'

/** The prompt library (shared/savedPrompts.ts, main/features/savedPrompts, the composer's "/" entries). */

let n = 0
const id = (): string => `id${++n}`
const prompt = (name: string, text: string, updatedAt = 1): SavedPrompt => ({ id: id(), name, text, createdAt: updatedAt, updatedAt })

beforeEach(async () => {
  await store.flushWrites()
  store.setJson('saved-prompts.json', [])
  resetSavedPromptsForTests()
  usePrompts.setState({ list: [] })
})

test('a prompt gets the name given, or its first line, and its text is kept as written', () => {
  const named = savePrompt([], { name: '  Weekly   summary ', text: 'Summarise my week.\r\nKeep it short.' }, id, 5)
  assert.ok(named.ok)
  assert.equal(named.prompt.name, 'Weekly summary')
  assert.equal(named.prompt.text, 'Summarise my week.\nKeep it short.')
  assert.equal(named.prompt.createdAt, 5)

  const unnamed = savePrompt([], { text: '\n\n  Translate this to French:  \n\nmore' }, id, 5)
  assert.ok(unnamed.ok)
  assert.equal(unnamed.prompt.name, 'Translate this to French:')
  assert.equal(nameFor('x'.repeat(100)).length, 60)
  assert.equal(nameFor('   '), 'Untitled prompt')

  const capped = savePrompt([], { name: 'n'.repeat(500), text: 't'.repeat(PROMPT_TEXT_LIMIT + 10) }, id, 5)
  assert.ok(capped.ok)
  assert.equal(capped.prompt.name.length, PROMPT_NAME_LIMIT)
  assert.equal(capped.prompt.text.length, PROMPT_TEXT_LIMIT)
})

test('empty text is refused, a full library says so, and editing needs a prompt that is there', () => {
  const empty = savePrompt([], { name: 'x', text: '   ' }, id, 1)
  assert.ok(!empty.ok)
  assert.match(empty.message, /needs some text/)

  const full = Array.from({ length: PROMPT_COUNT_LIMIT }, (_, i) => prompt(`p${i}`, `text ${i}`))
  const refused = savePrompt(full, { name: 'one more', text: 'x' }, id, 1)
  assert.ok(!refused.ok)
  assert.match(refused.message, new RegExp(`${PROMPT_COUNT_LIMIT} saved prompts`))
  // Changing one that is there still works when the library is full.
  const changed = savePrompt(full, { id: full[3].id, name: 'renamed', text: 'new text' }, id, 9)
  assert.ok(changed.ok)
  assert.equal(changed.list.length, PROMPT_COUNT_LIMIT)

  const gone = savePrompt([], { id: 'nope', name: 'x', text: 'y' }, id, 1)
  assert.ok(!gone.ok)
  assert.match(gone.message, /gone/)
})

test('a saved or edited prompt goes to the top; delete removes one', () => {
  let list: SavedPrompt[] = []
  for (const name of ['one', 'two', 'three']) {
    const added = savePrompt(list, { name, text: `${name} text` }, () => name, 1)
    assert.ok(added.ok)
    list = added.list
  }
  assert.deepEqual(list.map((p) => p.name), ['three', 'two', 'one'])
  const edited = savePrompt(list, { id: 'one', name: 'one, edited', text: 'changed' }, id, 50)
  assert.ok(edited.ok)
  assert.deepEqual(edited.list.map((p) => p.name), ['one, edited', 'three', 'two'])
  assert.equal(edited.prompt.updatedAt, 50)
  assert.equal(edited.prompt.createdAt, 1)
  assert.deepEqual(removePrompt(edited.list, 'three').map((p) => p.name), ['one, edited', 'two'])
})

test('search finds by name or text, names first, with the app’s word matching', () => {
  const list = [
    prompt('Email reply', 'Write a polite reply to this message.', 3),
    prompt('Summarise', 'Summarise the email below in three bullets.', 2),
    prompt('Code review', 'Review this diff for bugs.', 1)
  ]
  assert.deepEqual(searchPrompts(list, '').map((p) => p.name), ['Email reply', 'Summarise', 'Code review'])
  assert.deepEqual(searchPrompts(list, 'email').map((p) => p.name), ['Email reply', 'Summarise'], 'a name match, then a match in the text')
  assert.deepEqual(searchPrompts(list, 'review bug').map((p) => p.name), ['Code review'], 'each word must start a word, in any order')
  assert.deepEqual(searchPrompts(list, 'rev').map((p) => p.name), ['Code review'], 'a prefix of a word counts')
  assert.deepEqual(searchPrompts(list, 'zebra'), [])
  assert.equal(previewOf('a  b\n c'), 'a b c')
  assert.equal(previewOf('x'.repeat(300), 20).length, 20)
})

test('a damaged file keeps what is usable', () => {
  assert.deepEqual(parseSavedPrompts(null), [])
  assert.deepEqual(parseSavedPrompts({ not: 'a list' }), [])
  const list = parseSavedPrompts([
    null,
    { id: 'a', name: 'Kept', text: 'ok', createdAt: 1, updatedAt: 3 },
    { id: 'a', name: 'Same id', text: 'twice' },
    { id: 'b', text: 'no name' },
    { id: 'c', name: 'No text', text: '  ' },
    { name: 'No id', text: 'x' }
  ])
  assert.deepEqual(list.map((p) => [p.id, p.name]), [['a', 'Kept'], ['b', 'no name']])
})

test('the library is kept on disk and survives a restart', async () => {
  const a = saveSavedPrompt({ name: 'Standup', text: 'Write my standup from yesterday’s commits.' })
  assert.ok(a.ok)
  const b = saveSavedPrompt({ text: 'Explain this error:' })
  assert.ok(b.ok)
  assert.ok(b.ok && b.prompt.name === 'Explain this error:')
  assert.ok(!saveSavedPrompt({ text: '' }).ok)
  assert.ok(!saveSavedPrompt('nonsense').ok)

  await store.flushWrites()
  resetSavedPromptsForTests()
  assert.deepEqual(listSavedPrompts().map((p) => p.name), ['Explain this error:', 'Standup'])
  assert.equal(listSavedPrompts().length, (store.getJson<unknown[]>('saved-prompts.json', [])).length)

  const first = listSavedPrompts()[1]
  const edited = saveSavedPrompt({ id: first.id, name: 'Standup note', text: first.text })
  assert.ok(edited.ok)
  assert.deepEqual(listSavedPrompts().map((p) => p.name), ['Standup note', 'Explain this error:'])
  assert.deepEqual(deleteSavedPrompt(first.id).map((p) => p.name), ['Explain this error:'])
  assert.deepEqual(deleteSavedPrompt('nope').map((p) => p.name), ['Explain this error:'])
})

test('"/" offers the library, and saved prompts by name once a word is typed', () => {
  const opened: string[] = []
  const open = (): void => void opened.push('open')
  assert.deepEqual(savedPromptItems(open, '').map((i) => i.title), ['Saved prompts'])
  assert.equal(savedPromptItems(open, '')[0].hint, 'None yet')

  usePrompts.setState({ list: [prompt('Weekly summary', 'Summarise my week.\nKeep it short.'), prompt('Standup', 'Write my standup.')] })
  assert.deepEqual(savedPromptItems(open, '').map((i) => i.title), ['Saved prompts'], 'the empty menu stays short')
  assert.equal(savedPromptItems(open, '')[0].hint, undefined)
  savedPromptItems(open, '')[0].run?.()
  assert.deepEqual(opened, ['open'])

  const items = savedPromptItems(open, 'wee')
  assert.deepEqual(rankItems(items, 'wee').map((i) => i.title), ['Weekly summary'])
  const picked = rankItems(items, 'wee')[0]
  assert.equal(picked.insert, 'Summarise my week.\nKeep it short.', 'picking puts the text in the box; nothing is sent')
  assert.ok(!picked.run)
  assert.equal(picked.description, 'Summarise my week. Keep it short.')
  assert.deepEqual(rankItems(items, 'prompt').map((i) => i.title).slice(0, 1), ['Saved prompts'])
})
