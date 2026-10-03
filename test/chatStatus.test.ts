import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '@shared/types'
import { lastTurnFailed } from '../src/renderer/src/state/chatStatus'

/**
 * The sidebar's error mark is for the chat's latest turn only. It used to
 * stay on a chat for good once any reply in it had failed.
 */

let n = 0
const message = (role: ChatMessage['role'], error?: string): ChatMessage => ({
  id: `m${++n}`,
  role,
  parts: [{ type: 'text', text: role }],
  createdAt: n,
  ...(error ? { error } : {})
})

test('a failed latest reply marks the chat', () => {
  assert.equal(lastTurnFailed([message('user'), message('assistant', 'Rate limited')]), true)
})

test('an error from an earlier turn no longer marks the chat once a later reply went through', () => {
  const messages = [message('user'), message('assistant', 'Rate limited'), message('user'), message('assistant')]
  assert.equal(lastTurnFailed(messages), false)
})

test('a new message after a failed reply clears the mark while it waits for an answer', () => {
  assert.equal(lastTurnFailed([message('user'), message('assistant', 'Timed out'), message('user')]), false)
})

test('system notes after a failed reply are not a new turn', () => {
  assert.equal(lastTurnFailed([message('user'), message('assistant', 'Timed out'), message('system')]), true)
  assert.equal(lastTurnFailed([message('user'), message('assistant'), message('system', 'odd')]), false)
})

test('an empty chat is not failed', () => {
  assert.equal(lastTurnFailed([]), false)
})
