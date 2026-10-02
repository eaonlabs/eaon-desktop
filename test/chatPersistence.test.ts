import { test } from 'node:test'
import assert from 'node:assert/strict'
import { store } from '../src/main/store'
import type { Chat } from '@shared/types'

/**
 * chats.json is the whole history, rewritten on every save. These pin down the
 * two costs that used to scale with it: every save queued behind a slow write
 * was stringified and written in turn, and `chats:save` sent the entire array
 * back to the renderer.
 */

/** A stand-in for a chat list that counts how often it is serialised. */
function snapshot(label: string): { value: Chat[]; stringified: () => number } {
  let count = 0
  const value = {
    toJSON() {
      count++
      return [{ id: label }]
    }
  }
  return { value: value as unknown as Chat[], stringified: () => count }
}

test('saves that queue up behind a write collapse into the newest, stringified once', async () => {
  await store.flushWrites()
  const first = snapshot('first')
  store.saveChats(first.value)
  // Let the first write start, so the next saves queue behind it.
  await Promise.resolve()
  assert.equal(first.stringified(), 1)

  const second = snapshot('second')
  const third = snapshot('third')
  store.saveChats(second.value)
  store.saveChats(third.value)
  await store.flushWrites()

  assert.equal(second.stringified(), 0, 'a save overtaken before its write started is never serialised')
  assert.equal(third.stringified(), 1)
  assert.deepEqual(store.getChats(), [{ id: 'third' }])
})

test('flushWrites waits for a save made while another write was in flight', async () => {
  store.saveChats([{ id: 'a' }] as unknown as Chat[])
  await Promise.resolve()
  store.saveChats([{ id: 'b' }] as unknown as Chat[])
  await store.flushWrites()
  assert.deepEqual(store.getChats(), [{ id: 'b' }])
})

test('saveChats hands nothing back for chats:save to send to the renderer', () => {
  assert.equal(store.saveChats([]), undefined)
})
