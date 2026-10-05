import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Chat } from '@shared/types'
import { chatChanges, Checkpoint } from '../src/renderer/src/state/chatSync'

/**
 * With several windows, each saves only the chats it changed. A window that
 * saved its whole list would put back its stale copies of chats another
 * window had changed in the meantime.
 */

const chat = (id: string, title = id): Chat => ({ id, title }) as unknown as Chat

test('only chats whose object changed since the last sync are saved, plus the deleted ones', () => {
  const a = chat('a')
  const b = chat('b')
  const c = chat('c')
  const synced = new Map([a, b, c].map((x) => [x.id, x]))
  const renamed = { ...b, title: 'renamed' }
  const added = chat('new')
  const { upserts, removed } = chatChanges(synced, [added, a, renamed])
  assert.deepEqual(upserts.map((x) => x.id), ['new', 'b'])
  assert.equal(upserts[1], renamed)
  assert.deepEqual(removed, ['c'])
})

test('nothing changed: nothing to save', () => {
  const list = [chat('a'), chat('b')]
  assert.deepEqual(chatChanges(new Map(list.map((x) => [x.id, x])), list), { upserts: [], removed: [] })
})

test("a chat taken in from another window is not sent back", () => {
  const mine = chat('a')
  const theirs = { ...chat('b'), title: 'changed elsewhere' }
  // receiveChats puts the incoming object in `synced` and in the list alike.
  const synced = new Map([
    ['a', mine],
    ['b', theirs]
  ])
  assert.deepEqual(chatChanges(synced, [mine, theirs]).upserts, [])
})

/* A reply that is still streaming is saved every few seconds, not only when it ends. */

test('a checkpoint is a throttle: steady events never push it back, and one save follows each burst', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let saves = 0
  const checkpoint = new Checkpoint(() => saves++, 5_000, 5_000)
  // Tokens arrive every 20 ms for 12 seconds. A debounce would never fire.
  for (let elapsed = 0; elapsed < 12_000; elapsed += 20) {
    checkpoint.touch()
    t.mock.timers.tick(20)
  }
  assert.equal(saves, 2, 'at 5 s and at 10 s')
  // The touch at 10 s started the next one, due at 15 s; after that, with nothing touched, nothing is left to save.
  t.mock.timers.tick(5_000)
  assert.equal(saves, 3)
  t.mock.timers.tick(30_000)
  assert.equal(saves, 3)
  checkpoint.touch()
  t.mock.timers.tick(5_000)
  assert.equal(saves, 4)
})

test('a regular save cancels the pending checkpoint', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let saves = 0
  const checkpoint = new Checkpoint(() => saves++, 5_000, 5_000)
  checkpoint.touch()
  checkpoint.cancel()
  t.mock.timers.tick(10_000)
  assert.equal(saves, 0)
})

test('the first checkpoint of a reply comes early, the rest at the usual pace, and the next reply starts early again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let saves = 0
  const checkpoint = new Checkpoint(() => saves++, 5_000, 1_500)
  checkpoint.touch()
  t.mock.timers.tick(1_499)
  assert.equal(saves, 0)
  t.mock.timers.tick(1)
  assert.equal(saves, 1, 'a crash in the first seconds keeps what was said')
  checkpoint.touch()
  t.mock.timers.tick(4_999)
  assert.equal(saves, 1)
  t.mock.timers.tick(1)
  assert.equal(saves, 2, 'then every five seconds')
  checkpoint.cancel() // the reply ended and was saved in full
  checkpoint.touch()
  t.mock.timers.tick(1_500)
  assert.equal(saves, 3, 'the next reply is early too')
})
