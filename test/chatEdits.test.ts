import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Chat, ChatMessage } from '@shared/types'
import { editPlan, forkedChat, retryPlan, sentPrompts, withFeedback } from '../src/renderer/src/state/chatEdits'

/** A reply's action bar: thumbs and emoji kept on the message, retry, and fork. */

const text = (id: string, role: ChatMessage['role'], value: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  parts: [{ type: 'text', text: value }],
  createdAt: 1,
  ...extra
})

const chat = (messages: ChatMessage[], extra: Partial<Chat> = {}): Chat => ({
  id: 'c1',
  workspaceId: 'work',
  projectId: null,
  title: 'Disk space',
  messages,
  createdAt: 1,
  updatedAt: 1,
  archived: false,
  pinned: false,
  unread: false,
  modelId: null,
  effort: 'medium',
  ...extra
})

test('a thumb and an emoji are kept on the reply, and clearing both leaves nothing behind', () => {
  const base = chat([text('u1', 'user', 'How much space?'), text('a1', 'assistant', '41 GB')])
  const up = withFeedback(base, 'a1', { vote: 'up' })
  assert.deepEqual(up.messages[1].feedback, { vote: 'up' })
  const both = withFeedback(up, 'a1', { reaction: '🎉' })
  assert.deepEqual(both.messages[1].feedback, { vote: 'up', reaction: '🎉' })
  const cleared = withFeedback(withFeedback(both, 'a1', { vote: null }), 'a1', { reaction: null })
  assert.equal(cleared.messages[1].feedback, undefined)
  assert.equal(cleared.messages[0], base.messages[0], 'other messages keep their identity')
  assert.equal(withFeedback(base, 'a1', { vote: null }), base, 'nothing changed: the same chat')
  assert.equal(withFeedback(base, 'missing', { vote: 'up' }), base)
})

test('retrying the last reply asks its question again, files and all, in place of the pair', () => {
  const base = chat([
    text('u1', 'user', 'First?'),
    text('a1', 'assistant', 'One.'),
    text('u2', 'user', 'Look at this', { attachments: ['/tmp/a.png'] }),
    text('a2', 'assistant', 'Broken answer', { error: 'Rate limited' })
  ])
  const plan = retryPlan(base, 'a2')
  assert.ok(plan)
  assert.equal(plan.text, 'Look at this')
  assert.deepEqual(plan.attachments, ['/tmp/a.png'])
  assert.deepEqual(plan.messages.map((m) => m.id), ['u1', 'a1'])
})

test("only the last reply can be retried, and only when a question of the user's came before it", () => {
  const base = chat([text('u1', 'user', 'First?'), text('a1', 'assistant', 'One.'), text('u2', 'user', 'Second?'), text('a2', 'assistant', 'Two.')])
  assert.equal(retryPlan(base, 'a1'), null, 'an earlier reply')
  assert.equal(retryPlan(base, 'u2'), null, 'not a reply')
  assert.equal(retryPlan(chat([text('a0', 'assistant', 'Hi')]), 'a0'), null, 'nothing asked')
  // A system note after the reply (compaction, goal) doesn't make it any less the last.
  const noted = chat([...base.messages, text('s1', 'system', 'Compacted')])
  assert.equal(retryPlan(noted, 'a2')?.text, 'Second?')
  // Still running a tool: not finished, so nothing to retry yet.
  const running = chat([
    text('u1', 'user', 'Draw a cat'),
    { id: 'a1', role: 'assistant', createdAt: 1, parts: [{ type: 'tool', id: 't1', name: 'generate_image', input: {}, output: null, status: 'running' }] }
  ])
  assert.equal(retryPlan(running, 'a1'), null)
})

test('forking keeps the conversation up to the reply, without the goal or a summary it no longer covers', () => {
  const base = chat([text('u1', 'user', 'A'), text('a1', 'assistant', 'B'), text('u2', 'user', 'C'), text('a2', 'assistant', 'D')], {
    goal: { text: 'ship it', status: 'active', iterations: 2 },
    summary: { text: 'earlier', throughMessageId: 'a2' },
    pinned: true
  })
  const fork = forkedChat(base, 'a1', 'c2', 99)
  assert.ok(fork)
  assert.equal(fork.id, 'c2')
  assert.equal(fork.title, 'Disk space (fork)')
  assert.deepEqual(fork.messages.map((m) => m.id), ['u1', 'a1'])
  assert.equal(fork.goal, undefined)
  assert.equal(fork.summary, undefined, 'the summary ran past the fork point')
  assert.equal(fork.pinned, false)
  assert.equal(fork.createdAt, 99)
  // A summary that only covers what the fork kept goes with it.
  const covered = forkedChat({ ...base, summary: { text: 'early', throughMessageId: 'u1' } }, 'a2', 'c3', 1)
  assert.deepEqual(covered?.summary, { text: 'early', throughMessageId: 'u1' })
  assert.equal(forkedChat(base, 'missing', 'c4', 1), null)
})

test('editing a message brings back its text and files, and the chat as it was before it', () => {
  const base = chat(
    [
      text('u1', 'user', 'Free up space'),
      text('a1', 'assistant', 'Deleted caches'),
      text('u2', 'user', 'Now the photos', { attachments: ['/tmp/a.png'] }),
      text('a2', 'assistant', 'Moved 3 GB'),
      text('u3', 'user', 'Thanks')
    ],
    { summary: { text: 'Cleaned caches', throughMessageId: 'a2' } }
  )
  const plan = editPlan(base, 'u2')
  assert.ok(plan)
  assert.equal(plan.text, 'Now the photos')
  assert.deepEqual(plan.attachments, ['/tmp/a.png'])
  assert.deepEqual(plan.chat.messages.map((m) => m.id), ['u1', 'a1'])
  assert.equal(plan.chat.summary, undefined, 'a summary of messages that are gone goes too')
  assert.equal(base.messages.length, 5, 'the chat itself is untouched until the edit is sent')

  const early = chat(base.messages, { summary: { text: 'Cleaned caches', throughMessageId: 'a1' } })
  assert.deepEqual(editPlan(early, 'u3')?.chat.summary, { text: 'Cleaned caches', throughMessageId: 'a1' })

  assert.equal(editPlan(base, 'a1'), null, 'only the user’s own messages')
  assert.equal(editPlan(base, 'nope'), null)
  const mail = chat([text('u1', 'user', 'Hi', { mail: [{ id: 'm', from: 'user', fromName: 'You', text: 'Hi' }] as ChatMessage['mail'] })])
  assert.equal(editPlan(mail, 'u1'), null, 'not a worker’s mail')
  const running = chat([
    text('u1', 'user', 'Go'),
    { id: 'a1', role: 'assistant', createdAt: 1, parts: [{ type: 'tool', id: 't', name: 'run_command', input: {}, output: null, status: 'running' }] }
  ])
  assert.equal(editPlan(running, 'u1'), null, 'not while a tool call is still running')
})

test('↑ in the message box walks back through what the user sent here, once each in a row', () => {
  const base = chat([
    text('u1', 'user', 'first'),
    text('a1', 'assistant', 'ok'),
    text('u2', 'user', '  second  '),
    text('u3', 'user', 'second'),
    text('u4', 'user', 'from a schedule', { scheduledTaskId: 's1' }),
    text('u5', 'user', 'heartbeat', { heartbeat: '9:00' }),
    text('u6', 'user', '   '),
    text('u7', 'user', 'third')
  ])
  assert.deepEqual(sentPrompts(base), ['first', 'second', 'third'])
  assert.deepEqual(sentPrompts(null), [])
})
