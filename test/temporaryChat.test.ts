import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Chat } from '@shared/types'
import { chatChanges } from '../src/renderer/src/state/chatSync'

/**
 * Temporary chats (Chat.temporary): started from the start page's switch,
 * kept in the window that started them and nowhere else, and dropped when the
 * window leaves them. These pin down the "never saved" part: what main is
 * sent, what the lists show, and when the chat goes.
 */

const applied: { upserts: string[]; removed: string[] }[] = []
const g = globalThis as unknown as Record<string, unknown>
g.window = {
  api: {
    chats: {
      apply: async (upserts: Chat[], removed: string[]) => {
        applied.push({ upserts: upserts.map((c) => c.id), removed })
      }
    },
    chat: { cancel: async () => {}, stream: async () => {} },
    chatCode: { dropCheckpoints: async () => {} },
    settings: { patch: async () => ({}) }
  },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
}
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

/** Whether main was told anything about this chat: saved, or removed. */
const toldAbout = (id: string): boolean => applied.some((call) => call.upserts.includes(id) || call.removed.includes(id))

const chat = (id: string, extra: Partial<Chat> = {}): Chat =>
  ({ id, workspaceId: 'w', projectId: null, title: id, messages: [], createdAt: 1, updatedAt: 1, archived: false, pinned: false, unread: false, modelId: null, effort: 'medium', ...extra }) as unknown as Chat

test('a temporary chat is never in what a window saves, as a new chat, a change or a removal', () => {
  const kept = chat('kept')
  const temp = chat('temp', { temporary: true })
  assert.deepEqual(chatChanges(new Map(), [kept, temp]), { upserts: [kept], removed: [] })
  // Even if it somehow got into the synced copy and then went, main isn't told of a chat it never had.
  assert.deepEqual(chatChanges(new Map([[kept.id, kept]]), [kept, { ...temp }]), { upserts: [], removed: [] })
})

test('the switch starts the next chat as a temporary one, outside any project, and the chat is not saved or listed', async (t) => {
  const { useApp } = await import('../src/renderer/src/state/store')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  applied.length = 0
  useApp.setState({
    chats: [chat('kept')],
    projects: [{ id: 'p1', workspaceId: 'w', name: 'P', instructions: '', createdAt: 1, folder: '/tmp/p' }],
    workspaces: [{ id: 'w', name: 'Chat', kind: 'chat', cwd: null }],
    providers: [],
    settings: { activeWorkspaceId: 'w', effort: 'medium', recentModels: [] } as never,
    activeChatId: null,
    pendingProjectId: 'p1',
    pendingTemporary: false
  })

  // Turning it on lets go of a project picked for the next chat.
  useApp.getState().setPendingTemporary(true)
  assert.equal(useApp.getState().pendingProjectId, null)
  assert.equal(useApp.getState().pendingTemporary, true)

  // No model is connected here, so the send stops after making the chat: enough to see how it is made.
  await useApp.getState().send('a private question')
  const started = useApp.getState().chats.find((c) => c.id !== 'kept')
  assert.ok(started, 'the chat exists in this window')
  assert.equal(started.temporary, true)
  assert.equal(started.projectId, null)
  assert.equal(useApp.getState().activeChatId, started.id)
  assert.equal(useApp.getState().pendingTemporary, false, 'the switch was for that chat only')
  assert.ok(!toldAbout(started.id), 'nothing was sent to main to save')
  assert.deepEqual(useApp.getState().visibleChats().map((c) => c.id), ['kept'], 'not in the sidebar or its search')

  // Changing it does not save it either.
  useApp.getState().renameChat(started.id, 'Renamed')
  t.mock.timers.tick(250)
  await new Promise((r) => setImmediate(r))
  assert.ok(!toldAbout(started.id))
})

test('leaving a temporary chat drops it: for another chat, the start page, or the end of the chat', async (t) => {
  const { useApp } = await import('../src/renderer/src/state/store')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  applied.length = 0
  const settings = { activeWorkspaceId: 'w', effort: 'medium' } as never
  const open = (id: string): void => useApp.setState({ chats: [chat('kept'), chat(id, { temporary: true })], activeChatId: id, settings })

  open('t1')
  useApp.getState().openChat('kept')
  assert.deepEqual(useApp.getState().chats.map((c) => c.id), ['kept'])

  open('t2')
  useApp.getState().newChat()
  assert.deepEqual(useApp.getState().chats.map((c) => c.id), ['kept'])
  assert.equal(useApp.getState().pendingTemporary, false)

  // Archive has nothing to keep: it ends the chat.
  open('t3')
  useApp.getState().archiveChat('t3')
  assert.deepEqual(useApp.getState().chats.map((c) => c.id), ['kept'])

  open('t4')
  useApp.getState().deleteChat('t4')
  assert.deepEqual(useApp.getState().chats.map((c) => c.id), ['kept'])

  // A temporary chat can't be moved into a project, which would give it a folder that outlives it.
  open('t5')
  useApp.getState().moveChat('t5', 'p1')
  assert.equal(useApp.getState().chats.find((c) => c.id === 't5')?.projectId, null)

  t.mock.timers.tick(500)
  await new Promise((r) => setImmediate(r))
  assert.ok(!['t1', 't2', 't3', 't4', 't5'].some(toldAbout), 'main never heard of any of them')
})

test('a normal chat is untouched by all of this', async (t) => {
  const { useApp } = await import('../src/renderer/src/state/store')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  applied.length = 0
  useApp.setState({ chats: [chat('a'), chat('b')], activeChatId: 'a', settings: { activeWorkspaceId: 'w' } as never })
  useApp.getState().openChat('b')
  assert.deepEqual(useApp.getState().chats.map((c) => c.id), ['a', 'b'])
  useApp.getState().archiveChat('b')
  assert.equal(useApp.getState().chats.find((c) => c.id === 'b')?.archived, true)
})
