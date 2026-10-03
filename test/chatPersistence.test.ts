import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { store } from '../src/main/store'
import type { Chat } from '@shared/types'

/** What is on disk, as opposed to the store's in-memory copy. */
const onDisk = (): unknown => JSON.parse(readFileSync(join(app.getPath('userData'), 'store', 'chats.json'), 'utf8'))

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
  assert.deepEqual(onDisk(), [{ id: 'third' }])
})

test('flushWrites waits for a save made while another write was in flight', async () => {
  store.saveChats([{ id: 'a' }] as unknown as Chat[])
  await Promise.resolve()
  store.saveChats([{ id: 'b' }] as unknown as Chat[])
  await store.flushWrites()
  assert.deepEqual(onDisk(), [{ id: 'b' }])
})

test('saveChats hands nothing back for chats:save to send to the renderer', () => {
  assert.equal(store.saveChats([]), undefined)
})

const chat = (id: string, title = id): Chat => ({ id, title }) as unknown as Chat

test('applyChats lands each window\'s edits on the latest list instead of replacing it', async () => {
  store.saveChats([chat('a'), chat('b'), chat('c')])
  // Two windows save one after the other, each sending only what it changed.
  store.applyChats([chat('b', 'renamed in window 1')], [])
  store.applyChats([chat('new'), chat('c', 'renamed in window 2')], ['a'])
  assert.deepEqual(
    store.getChats().map((c) => [c.id, c.title]),
    [
      ['new', 'new'],
      ['b', 'renamed in window 1'],
      ['c', 'renamed in window 2']
    ]
  )
  await store.flushWrites()
  assert.deepEqual((onDisk() as Chat[]).map((c) => c.id), ['new', 'b', 'c'], 'the write reflects the merged list')
})

test('getChats hands out a copy, so a caller reordering it changes nothing until it saves', () => {
  store.saveChats([chat('x'), chat('y')])
  const copy = store.getChats()
  copy.reverse()
  assert.deepEqual(store.getChats().map((c) => c.id), ['x', 'y'])
})
