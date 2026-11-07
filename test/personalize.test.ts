import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  addMemory,
  cleanInstructions,
  deleteMemory,
  editMemory,
  INSTRUCTIONS_LIMIT,
  instructionsBlock,
  memoryBlock,
  MEMORY_COUNT_LIMIT,
  MEMORY_TEXT_LIMIT,
  parsePersonalize,
  personalInstructions,
  type MemoryItem,
  type Personalize
} from '@shared/personalize'
import { getToolSource, type ToolQuery } from '../src/main/agent/tools'
import {
  addUserMemory,
  clearMemory,
  deleteUserMemory,
  editUserMemory,
  loadPersonalize,
  rememberTool,
  resetPersonalizeForTests,
  setInstructions,
  setMemoryEnabled,
  withPersonalInstructions
} from '../src/main/features/personalize'
import { store } from '../src/main/store'

/**
 * Custom instructions and memory (shared/personalize.ts, main/features/personalize):
 * what is kept, what a chat's system prompt gets, and when the model may write to memory.
 */

const item = (text: string, id = text, now = 1): MemoryItem => ({ id, text, createdAt: now, updatedAt: now, source: 'you' })

beforeEach(async () => {
  await store.flushWrites()
  store.setJson('personalize.json', {})
  resetPersonalizeForTests()
})

/* -------------------------------------------------------- the pure parts */

test('custom instructions are trimmed and capped, and nothing is added while they are empty', () => {
  assert.equal(cleanInstructions('  Keep it short.\r\nUse metric.  '), 'Keep it short.\nUse metric.')
  assert.equal(cleanInstructions('x'.repeat(INSTRUCTIONS_LIMIT + 50)).length, INSTRUCTIONS_LIMIT)
  assert.equal(cleanInstructions(42), '')
  assert.equal(instructionsBlock('   '), '')
  assert.match(instructionsBlock('Keep it short.'), /custom instructions, which apply to every chat:\nKeep it short\.$/)
  const none: Personalize = { instructions: '', memory: { enabled: true, items: [] } }
  assert.equal(personalInstructions(none), '', 'empty instructions and no memories add nothing')
})

test('a memory is one short line; duplicates, empties and a full list are refused with a reason', () => {
  const first = addMemory([], '  Prefers\n metric   units. ', 'model', 'a', 5)
  assert.ok(first.ok)
  assert.equal(first.item.text, 'Prefers metric units.')
  assert.equal(first.item.source, 'model')
  assert.equal(first.item.createdAt, 5)

  const again = addMemory(first.items, 'PREFERS metric units.', 'you', 'b', 6)
  assert.ok(!again.ok && again.reason === 'duplicate')
  const empty = addMemory(first.items, '   ', 'you', 'c', 6)
  assert.ok(!empty.ok && empty.reason === 'empty')

  const long = addMemory([], 'y'.repeat(MEMORY_TEXT_LIMIT + 40), 'you', 'd', 1)
  assert.ok(long.ok)
  assert.equal(long.item.text.length, MEMORY_TEXT_LIMIT)

  const full = Array.from({ length: MEMORY_COUNT_LIMIT }, (_, i) => item(`fact ${i}`))
  const refused = addMemory(full, 'one more', 'model', 'e', 1)
  assert.ok(!refused.ok && refused.reason === 'full')
  assert.match(refused.message, /Settings → Memory/)
})

test('the newest memory comes first, and editing and deleting change one item', () => {
  let items: MemoryItem[] = []
  for (const [i, text] of ['one', 'two', 'three'].entries()) {
    const added = addMemory(items, text, 'you', text, i + 1)
    assert.ok(added.ok)
    items = added.items
  }
  assert.deepEqual(items.map((m) => m.text), ['three', 'two', 'one'])

  const edited = editMemory(items, 'two', 'two, edited', 9)
  assert.ok(edited.ok)
  assert.deepEqual(edited.items.map((m) => m.text), ['three', 'two, edited', 'one'])
  assert.equal(edited.item.updatedAt, 9)
  assert.equal(edited.item.createdAt, 2)

  const clash = editMemory(items, 'two', 'ONE', 9)
  assert.ok(!clash.ok && clash.reason === 'duplicate')
  const blank = editMemory(items, 'two', ' ', 9)
  assert.ok(!blank.ok && blank.reason === 'empty')
  const gone = editMemory(items, 'nope', 'x', 9)
  assert.ok(!gone.ok && gone.reason === 'missing')

  assert.deepEqual(deleteMemory(items, 'two').map((m) => m.text), ['three', 'one'])
  assert.deepEqual(deleteMemory(items, 'nope'), items)
})

test('memory in the prompt is bounded, newest first, and says how many were left out', () => {
  const items = ['newest fact', 'middle fact', 'oldest fact'].map((t) => item(t))
  const all = memoryBlock(items)
  assert.ok(all.indexOf('newest fact') < all.indexOf('middle fact') && all.indexOf('middle fact') < all.indexOf('oldest fact'))
  assert.ok(!/not shown/.test(all))

  const head = memoryBlock([item('a')]).split('\n')[0]
  const small = memoryBlock(items, head.length + '- newest fact'.length + 1 + '- middle fact'.length + 2)
  assert.match(small, /newest fact/)
  assert.match(small, /middle fact/)
  assert.ok(!/oldest fact/.test(small))
  assert.match(small, /\(1 older memory is not shown here\.\)/)

  assert.equal(memoryBlock([]), '')
  assert.equal(memoryBlock(items, 10), '', 'a limit too small for even one line sends nothing rather than half a line')
  const big = Array.from({ length: MEMORY_COUNT_LIMIT }, (_, i) => item(`${'w'.repeat(MEMORY_TEXT_LIMIT - 10)}${i}`))
  assert.ok(memoryBlock(big).length <= 3000)
})

test('memory is sent only while it is on', () => {
  const p: Personalize = { instructions: 'Be brief.', memory: { enabled: false, items: [item('Likes tea.')] } }
  assert.ok(!personalInstructions(p).includes('Likes tea.'))
  assert.ok(personalInstructions(p).includes('Be brief.'))
  const on = personalInstructions({ ...p, memory: { ...p.memory, enabled: true } })
  assert.ok(on.includes('Likes tea.') && on.includes('Be brief.'))
  assert.ok(on.indexOf('Be brief.') < on.indexOf('Likes tea.'), 'custom instructions come before memory')
})

test('a damaged file reads as the default, keeping what is usable', () => {
  assert.deepEqual(parsePersonalize(null), { instructions: '', memory: { enabled: false, items: [] } })
  assert.deepEqual(parsePersonalize('nonsense'), { instructions: '', memory: { enabled: false, items: [] } })
  const parsed = parsePersonalize({
    instructions: 5,
    memory: {
      enabled: 'yes',
      items: [null, { id: 'a', text: 'kept' }, { id: 'a', text: 'same id twice' }, { id: '', text: 'no id' }, { id: 'b', text: '   ' }, { id: 'c', text: 'from the model', source: 'model', createdAt: 7 }]
    }
  })
  assert.equal(parsed.instructions, '')
  assert.equal(parsed.memory.enabled, false, 'only true turns it on')
  assert.deepEqual(parsed.memory.items.map((m) => [m.id, m.text, m.source, m.createdAt, m.updatedAt]), [
    ['a', 'kept', 'you', 0, 0],
    ['c', 'from the model', 'model', 7, 7]
  ])
})

/* ------------------------------------------------------- the main process */

test('custom instructions are kept on disk and ride with the project’s and the mods’', async () => {
  setInstructions('  Answer in French.  ')
  await store.flushWrites()
  assert.equal((store.getJson<Personalize>('personalize.json', null as never) as Personalize).instructions, 'Answer in French.')
  resetPersonalizeForTests()
  assert.equal(loadPersonalize().instructions, 'Answer in French.', 'read back from the file')

  const text = withPersonalInstructions({ messageId: 'm1' }, 'Project: use tabs.\n\nFrom the Plain answers mod:\nBe plain.')
  assert.ok(text.startsWith('Project: use tabs.'))
  assert.ok(text.indexOf('Be plain.') < text.indexOf('Answer in French.'), 'theirs come after the project’s and the mods’')

  setInstructions('')
  assert.equal(withPersonalInstructions({ messageId: 'm2' }, 'Project: use tabs.'), 'Project: use tabs.', 'empty adds nothing, not even a heading')
  assert.equal(withPersonalInstructions({ messageId: 'm3' }, ''), '')
})

test('the remember tool is offered only in a turn the user started in Chat, while memory is on', () => {
  const source = getToolSource('memory')
  assert.ok(source)
  const query = (messageId: string, depth = 0): ToolQuery =>
    ({ mode: 'work', cwd: null, depth, readOnly: false, settings: {} as never, request: { messageId } as never }) as ToolQuery

  withPersonalInstructions({ messageId: 'chat-turn' }, '')
  assert.deepEqual(source.tools(query('chat-turn')), [], 'off until turned on')

  setMemoryEnabled(true)
  assert.deepEqual(source.tools(query('chat-turn')).map((t) => t.name), ['remember'])
  assert.deepEqual(source.tools(query('scheduled-run')), [], 'a run that never went through Chat gets none')
  assert.deepEqual(source.tools(query('chat-turn', 1)), [], 'nor does a sub-agent')
  assert.ok(source.guidance?.(query('chat-turn')))

  setMemoryEnabled(false)
  assert.deepEqual(source.tools(query('chat-turn')), [])
})

test('remember saves a fact the model was asked to keep, and says so; Settings can change it', async () => {
  const ctx = {} as never
  assert.equal(rememberTool.mutating, true, 'it follows the approval setting')
  assert.equal(rememberTool.describe?.({ fact: 'Likes tea.' }), 'Remember: Likes tea.')

  const saved = await rememberTool.run({ fact: 'Likes tea.' }, ctx)
  assert.match(typeof saved === 'string' ? saved : saved.text, /Saved to memory: Likes tea\./)
  assert.deepEqual(loadPersonalize().memory.items.map((m) => [m.text, m.source]), [['Likes tea.', 'model']])

  const again = await rememberTool.run({ fact: 'likes tea.' }, ctx)
  assert.ok(typeof again !== 'string' && !again.isError && /already/.test(again.text))
  const blank = await rememberTool.run({ fact: '  ' }, ctx)
  assert.ok(typeof blank !== 'string' && blank.isError)

  const id = loadPersonalize().memory.items[0].id
  const edited = editUserMemory(id, 'Likes green tea.')
  assert.ok(edited.ok)
  const added = addUserMemory('Lives in Oslo.')
  assert.ok(added.ok)
  assert.deepEqual(loadPersonalize().memory.items.map((m) => [m.text, m.source]), [
    ['Lives in Oslo.', 'you'],
    ['Likes green tea.', 'model']
  ])
  await store.flushWrites()
  resetPersonalizeForTests()
  assert.equal(loadPersonalize().memory.items.length, 2, 'both survive a restart')

  deleteUserMemory(id)
  assert.deepEqual(loadPersonalize().memory.items.map((m) => m.text), ['Lives in Oslo.'])
  clearMemory()
  assert.deepEqual(loadPersonalize().memory.items, [])
})

test('memory is off in a fresh install', () => {
  assert.equal(loadPersonalize().memory.enabled, false)
  assert.equal(withPersonalInstructions({ messageId: 'x' }, ''), '')
})
