import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Chat } from '@shared/types'
import { chatChanges } from '../src/renderer/src/state/chatSync'

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
