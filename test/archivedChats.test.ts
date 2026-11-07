import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Chat, ChatMessage } from '@shared/types'
import { archivable, archivedOf, chatCount, replying, searchChats, snippetAround } from '@shared/chatArchive'

/**
 * Settings → Archived chats: which chats "Archive all" takes, the list of
 * archived ones, the search through them, and the store actions that move or
 * delete many chats at once (state/store.ts archiveChats, deleteChats).
 */

const applied: { upserts: Chat[]; removed: string[] }[] = []
const stopped: string[] = []
const dropped: { folder: string; replies: string[] }[] = []
const g = globalThis as unknown as Record<string, unknown>
g.window = {
  api: {
    chats: {
      apply: async (upserts: Chat[], removed: string[]) => {
        applied.push({ upserts, removed })
      }
    },
    chat: { cancel: async (id: string) => void stopped.push(id), stream: async () => {} },
    chatCode: { dropCheckpoints: async (folder: string, replies: string[]) => void dropped.push({ folder, replies }) },
    settings: { patch: async () => ({}) }
  },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
}
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const say = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({ id, role, parts: [{ type: 'text', text }], createdAt: 1 })
const chat = (id: string, extra: Partial<Chat> = {}): Chat =>
  ({ id, workspaceId: 'w', projectId: null, title: id, messages: [], createdAt: 1, updatedAt: 1, archived: false, pinned: false, unread: false, modelId: null, effort: 'medium', ...extra }) as unknown as Chat

test('Archive all takes the chats the sidebar lists, and leaves one that is still replying', () => {
  const chats = [
    chat('a'),
    chat('b', { pinned: true }),
    chat('replying'),
    chat('done', { archived: true }),
    chat('temp', { temporary: true }),
    chat('elsewhere', { workspaceId: 'workers' })
  ]
  const spaces = new Set(['w'])
  const running = { replying: 'msg' }
  assert.deepEqual(archivable(chats, spaces, running).map((c) => c.id), ['a', 'b'])
  assert.deepEqual(replying(chats, spaces, running).map((c) => c.id), ['replying'])
  assert.deepEqual(archivable(chats, new Set(), {}), [])
})

test('the archived list is newest first, and counts read as words', () => {
  const list = archivedOf([chat('old', { archived: true, updatedAt: 1 }), chat('kept'), chat('new', { archived: true, updatedAt: 9 })])
  assert.deepEqual(list.map((c) => c.id), ['new', 'old'])
  assert.equal(chatCount(1), '1 chat')
  assert.equal(chatCount(0), '0 chats')
  assert.equal(chatCount(12), '12 chats')
})

test('search finds a chat by its title or by what was said, titles first, with a line to show', () => {
  const chats = [
    chat('trip', { title: 'Lisbon trip', messages: [say('1', 'user', 'Where should we eat?'), say('2', 'assistant', 'Try the pastel de nata near Alfama.')] }),
    chat('budget', { title: 'Monthly budget', messages: [say('3', 'user', 'Plan the Lisbon spending for May please')] }),
    chat('code', { title: 'Fix parser', messages: [say('4', 'user', 'The parser drops tokens')] })
  ]
  assert.deepEqual(searchChats(chats, '').map((h) => h.chat.id), ['trip', 'budget', 'code'])

  const lisbon = searchChats(chats, 'lisbon')
  assert.deepEqual(lisbon.map((h) => h.chat.id), ['trip', 'budget'], 'the title match comes first')
  assert.equal(lisbon[0].snippet, undefined)
  assert.match(lisbon[1].snippet ?? '', /Plan the Lisbon spending for May please/)

  assert.deepEqual(searchChats(chats, 'PASTEL alfama').map((h) => h.chat.id), ['trip'], 'every word, any order, ignoring case')
  assert.match(searchChats(chats, 'pastel')[0].snippet ?? '', /pastel de nata/)
  assert.deepEqual(searchChats(chats, 'lisbon parser'), [], 'every word has to be in the same chat')
  assert.deepEqual(searchChats(chats, 'zzz'), [])
})

test('search reads what was said, not the model’s reasoning, tool output or system notes', () => {
  const noisy = chat('noisy', {
    title: 'Notes',
    messages: [
      { id: 'm', role: 'assistant', createdAt: 1, parts: [{ type: 'reasoning', text: 'secretword' }, { type: 'tool', id: 't', name: 'run_command', input: {}, output: 'toolword', status: 'done' }, { type: 'text', text: 'plain answer' }] },
      say('s', 'system', 'systemword')
    ]
  })
  assert.equal(searchChats([noisy], 'secretword').length, 0)
  assert.equal(searchChats([noisy], 'toolword').length, 0)
  assert.equal(searchChats([noisy], 'systemword').length, 0)
  assert.equal(searchChats([noisy], 'plain').length, 1)
})

test('a snippet is one line around the first match, with ellipses where it was cut', () => {
  const text = `${'a '.repeat(60)}needle${' b'.repeat(60)}`
  const out = snippetAround(text, 'NEEDLE', 10)
  assert.match(out, /^….*needle.*…$/)
  assert.ok(out.length < 40)
  assert.equal(snippetAround('short needle here', 'needle'), 'short needle here')
  assert.equal(snippetAround('nothing', 'needle'), '')
  assert.ok(!snippetAround('line one\nneedle\n\nline three', 'needle').includes('\n'))
})

test('the store archives and deletes many chats at once, saved in one go', async (t) => {
  const { useApp } = await import('../src/renderer/src/state/store')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  applied.length = 0
  stopped.length = 0
  dropped.length = 0
  useApp.setState({
    settings: { activeWorkspaceId: 'w' } as never,
    projects: [{ id: 'p', workspaceId: 'w', name: 'P', instructions: '', createdAt: 1, folder: '/tmp/proj' }],
    chats: [
      chat('a'),
      chat('b'),
      chat('busy'),
      chat('temp', { temporary: true }),
      chat('old1', { archived: true }),
      chat('old2', { archived: true, projectId: 'p', messages: [say('r1', 'user', 'hi'), { ...say('r2', 'assistant', 'hello') }] })
    ],
    activeChatId: 'a',
    runs: { busy: 'msg1' }
  })
  // Everything is already saved, so only what the actions change is sent.
  const { chats } = useApp.getState()
  useApp.setState({ chats: [...chats] })

  const moved = useApp.getState().archiveChats(['a', 'b', 'busy', 'temp', 'old1', 'missing'])
  assert.equal(moved, 2, 'a chat still replying, a temporary one and one already archived are left')
  const state = useApp.getState()
  assert.deepEqual(state.chats.filter((c) => c.archived).map((c) => c.id).sort(), ['a', 'b', 'old1', 'old2'])
  assert.equal(state.chats.find((c) => c.id === 'busy')?.archived, false)
  assert.equal(state.chats.find((c) => c.id === 'temp')?.archived, false)
  assert.equal(state.activeChatId, null, 'the open chat was archived, so the page moves off it')
  assert.deepEqual(stopped, [], 'archiving all never stops a reply')
  assert.equal(useApp.getState().archiveChats([]), 0)

  const gone = useApp.getState().deleteChats(['a', 'b', 'old1', 'old2', 'missing'])
  assert.equal(gone, 4)
  assert.deepEqual(useApp.getState().chats.map((c) => c.id), ['busy', 'temp'])
  assert.deepEqual(dropped, [{ folder: '/tmp/proj', replies: ['r2'] }], 'a coding chat’s checkpoints go with it')
  assert.equal(useApp.getState().deleteChats(['nope']), 0)

  t.mock.timers.tick(250)
  await new Promise((r) => setImmediate(r))
  const last = applied[applied.length - 1]
  assert.deepEqual(last.removed.sort(), [], 'chats this window never saved aren’t reported as removed')
})

test('deleting chats that were saved reports them to main once', async (t) => {
  const { useApp } = await import('../src/renderer/src/state/store')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  applied.length = 0
  // Two saved chats: a save first, so main has them.
  useApp.setState({ settings: { activeWorkspaceId: 'w' } as never, projects: [], chats: [chat('x', { archived: true }), chat('y', { archived: true }), chat('z')], activeChatId: null, runs: {} })
  useApp.getState().renameChat('z', 'Z')
  t.mock.timers.tick(250)
  await new Promise((r) => setImmediate(r))
  applied.length = 0

  // A reply still being written in a chat that is deleted is stopped, as deleting that one chat does.
  stopped.length = 0
  useApp.setState({ runs: { x: 'msg-x' } })
  useApp.getState().deleteChats(['x', 'y'])
  assert.deepEqual(stopped, ['msg-x'])
  t.mock.timers.tick(250)
  await new Promise((r) => setImmediate(r))
  assert.equal(applied.length, 1, 'one save for the whole batch')
  assert.deepEqual(applied[0].removed.sort(), ['x', 'y'])
  assert.deepEqual(applied[0].upserts, [])
})
