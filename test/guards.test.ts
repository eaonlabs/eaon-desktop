import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CallGuard, callSignature, MAX_IDENTICAL_FAILURES } from '../src/main/agent/guards'
import { goalBudgetExceeded } from '../src/main/agent/loop'
import type { NeutralMessage } from '../src/main/providers/adapters/types'
import type { Settings } from '@shared/types'

/** The loop's anti-spinning bookkeeping, without a model. */

test('call signatures ignore key order but not values', () => {
  assert.equal(callSignature('t', { a: 1, b: { c: 2, d: 3 } }), callSignature('t', { b: { d: 3, c: 2 }, a: 1 }))
  assert.notEqual(callSignature('t', { a: 1 }), callSignature('t', { a: 2 }))
  assert.notEqual(callSignature('t', { a: 1 }), callSignature('u', { a: 1 }))
})

test('an identical call is refused after repeated failures, and warned about on the second', () => {
  const guard = new CallGuard()
  const input = { path: 'missing.txt' }
  assert.equal(guard.record('read_file', input, 'error', 'ENOENT', false), null)
  assert.match(guard.record('read_file', input, 'error', 'ENOENT', false) ?? '', /failed twice/)
  for (let i = 2; i < MAX_IDENTICAL_FAILURES; i++) guard.record('read_file', input, 'error', 'ENOENT', false)
  assert.match(guard.refuse('read_file', input) ?? '', /already failed 3 times[\s\S]*ENOENT/)
  // Different arguments are a different call.
  assert.equal(guard.refuse('read_file', { path: 'other.txt' }), null)
})

test('a successful change clears the failure history; denials never count', () => {
  const guard = new CallGuard()
  const input = { command: 'npm test' }
  for (let i = 0; i < MAX_IDENTICAL_FAILURES; i++) guard.record('run_command', input, 'error', 'boom', false)
  assert.notEqual(guard.refuse('run_command', input), null)
  guard.record('edit_file', { path: 'a.ts' }, 'done', 'Edited', true)
  assert.equal(guard.refuse('run_command', input), null)

  for (let i = 0; i < 5; i++) guard.record('write_file', { path: 'x' }, 'denied', 'denied', false)
  assert.equal(guard.refuse('write_file', { path: 'x' }), null)
})

const toolMessage = (id: string, output: string): NeutralMessage => ({ role: 'tool', results: [{ id, name: 'read_file', output }] })
const long = 'x'.repeat(500)

test('an unchanged repeat of a recent observation becomes a pointer to it', () => {
  const guard = new CallGuard()
  const messages: NeutralMessage[] = []
  assert.equal(guard.dedupe('read_file', { path: 'a' }, 'c1', long, messages), null)
  messages.push(toolMessage('c1', long))
  assert.match(guard.dedupe('read_file', { path: 'a' }, 'c2', long, messages) ?? '', /Same result as your earlier identical read_file/)
  // Changed output is sent in full.
  assert.equal(guard.dedupe('read_file', { path: 'a' }, 'c3', long + 'y', messages), null)
})

test('no pointer to an observation that was pruned, scrolled out of view, or is short', () => {
  const pruned = new CallGuard()
  pruned.dedupe('read_file', { path: 'a' }, 'c1', long, [])
  assert.equal(pruned.dedupe('read_file', { path: 'a' }, 'c2', long, [toolMessage('c1', '[output cleared]')]), null)

  const old = new CallGuard()
  old.dedupe('read_file', { path: 'a' }, 'c1', long, [])
  const messages = [toolMessage('c1', long), ...Array.from({ length: 6 }, (_, i) => toolMessage(`o${i}`, 'other'))]
  assert.equal(old.dedupe('read_file', { path: 'a' }, 'c2', long, messages), null)

  const short = new CallGuard()
  short.dedupe('read_file', { path: 'a' }, 'c1', 'tiny', [])
  assert.equal(short.dedupe('read_file', { path: 'a' }, 'c2', 'tiny', [toolMessage('c1', 'tiny')]), null)
})

test('goal budgets: time and tokens, with 0 meaning no limit', () => {
  const settings = (goalMaxMinutes: number, goalMaxTokens: number) => ({ work: { goalMaxMinutes, goalMaxTokens } }) as Settings
  const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 })
  assert.equal(goalBudgetExceeded(settings(60, 1000), 0, usage(10, 10), 59 * 60_000), null)
  assert.match(goalBudgetExceeded(settings(60, 1000), 0, usage(10, 10), 60 * 60_000) ?? '', /time limit of 60 min/)
  assert.match(goalBudgetExceeded(settings(60, 1000), 0, usage(900, 100), 1000) ?? '', /token limit of 1,000/)
  assert.equal(goalBudgetExceeded(settings(0, 0), 0, usage(1e9, 1e9), 1e12), null)
})
