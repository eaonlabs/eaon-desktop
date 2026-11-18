import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Chat, ChatMessage } from '../src/shared/types'
import { contextUse } from '../src/renderer/src/state/contextUse'

/**
 * The context meter's numbers (chat/ContextMeter.tsx): what fills the
 * model's context, by kind, and the total. The latest reply's own count of
 * its request, when it has one, is the total; the parts are fitted to it.
 */

const message = (role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `${role}-${text.length}-${Math.random()}`,
  role,
  parts: [{ type: 'text', text }],
  createdAt: 0,
  ...extra
})
const chat = (messages: ChatMessage[]): Chat =>
  ({ id: 'c', workspaceId: 'w', projectId: null, title: 't', messages, createdAt: 0, updatedAt: 0, archived: false, pinned: false, unread: false, modelId: null, effort: 'medium' }) as Chat

test('with nothing counted, the total is the estimate: what was said, and an allowance for the system prompt and tools', () => {
  const use = contextUse(chat([message('user', 'x'.repeat(360)), message('assistant', 'y'.repeat(720))]))
  assert.equal(use.counted, false)
  assert.equal(use.parts.messages, 300)
  assert.equal(use.parts.system, 6000)
  assert.equal(use.total, 6300)
})

test('a counted request is the total, and what the conversation doesn’t account for is the system prompt and tools', () => {
  const use = contextUse(
    chat([message('user', 'x'.repeat(360)), message('assistant', 'y'.repeat(720), { usage: { input: 10, output: 5, cacheRead: 40_000, cacheWrite: 0, context: 40_000 } })])
  )
  assert.equal(use.counted, true)
  assert.equal(use.total, 40_000)
  assert.equal(use.parts.messages, 300)
  assert.equal(use.parts.system, 39_700)
})

test('an estimate bigger than the count is scaled down to it, with nothing left over for the system prompt', () => {
  const use = contextUse(chat([message('user', 'x'.repeat(36_000)), message('assistant', 'ok', { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, context: 5000 } })]))
  assert.equal(use.total, 5000)
  assert.equal(use.parts.system, 0)
  assert.equal(Math.round(use.parts.messages), 5000)
})

test('an older reply with no count of its own but no tool calls was one request: its usage is the count', () => {
  const use = contextUse(chat([message('user', 'hey'), message('assistant', 'Hey!', { usage: { input: 15_000, output: 12, cacheRead: 400, cacheWrite: 0 } })]))
  assert.equal(use.counted, true)
  assert.equal(use.total, 15_412)
})

test('an older reply that called tools added up several requests, so it is estimated instead', () => {
  const reply = message('assistant', 'done', { usage: { input: 90_000, output: 500, cacheRead: 0, cacheWrite: 0 } })
  reply.parts.push({ type: 'tool', id: 't', name: 'read_file', input: { path: 'a' }, output: 'x' } as ChatMessage['parts'][number])
  assert.equal(contextUse(chat([message('user', 'go'), reply])).counted, false)
})

test('a reply still being written with no count yet falls back to the estimate', () => {
  const use = contextUse(chat([message('user', 'hi'), message('assistant', '')]))
  assert.equal(use.counted, false)
})
