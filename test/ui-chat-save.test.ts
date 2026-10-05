import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Chat } from '@shared/types'

/**
 * A chat save that fails must not be forgotten. The renderer marked chats as
 * saved before main answered, so a rejected save (a full disk, a locked
 * file) meant those edits were never sent again and were lost at quit, with
 * no word to the user.
 */

const calls: { upserts: string[]; removed: string[] }[] = []
let failNext = 0
const g = globalThis as unknown as Record<string, unknown>
g.window = {
  api: {
    chats: {
      apply: async (upserts: Chat[], removed: string[]) => {
        calls.push({ upserts: upserts.map((c) => c.id), removed })
        if (failNext > 0) {
          failNext--
          throw new Error("Error invoking remote method 'chats:apply': Error: ENOSPC: no space left on device")
        }
      }
    }
  },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
}
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const chat = (id: string, title: string): Chat =>
  ({ id, workspaceId: 'w', projectId: null, title, messages: [], createdAt: 1, updatedAt: 1, archived: false, pinned: false, unread: false, modelId: null, effort: 'medium' }) as unknown as Chat

test('a rejected chat save is retried, and the user is told once', async (t) => {
  const { useApp } = await import('../src/renderer/src/state/store')
  const { useNotice } = await import('../src/renderer/src/components/Notice')
  t.mock.timers.enable({ apis: ['setTimeout'] })

  useApp.setState({ chats: [chat('a', 'First')] })
  failNext = 1
  useApp.getState().renameChat('a', 'Renamed')
  t.mock.timers.tick(250)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls, [{ upserts: ['a'], removed: [] }])
  const notice = useNotice.getState().notice
  assert.equal(notice?.tone, 'error')
  assert.match(notice?.text ?? '', /Couldn't save your chats \(ENOSPC: no space left on device\)/)
  // The wrapper Electron adds to a rejected invoke is gone from the text.
  assert.doesNotMatch(notice?.text ?? '', /Error invoking remote method/)

  // The retry carries the same change, and nothing else.
  t.mock.timers.tick(5000)
  t.mock.timers.tick(250)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls[1], { upserts: ['a'], removed: [] })

  // Saved now: another change sends only itself.
  useNotice.getState().dismiss()
  useApp.setState({ chats: [...useApp.getState().chats, chat('b', 'Second')] })
  useApp.getState().renameChat('b', 'Second, renamed')
  t.mock.timers.tick(250)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls[2], { upserts: ['b'], removed: [] })
  assert.equal(useNotice.getState().notice, null)
})
