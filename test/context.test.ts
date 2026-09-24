import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHistory, pruneInFlight } from '../src/main/agent/context'
import type { ChatMessage } from '@shared/types'

const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }], createdAt: 0 })

test('interleaved text and tool parts replay as assistant/tool pairs in order', () => {
  const history: ChatMessage[] = [
    user('u1', 'do it'),
    {
      id: 'a1',
      role: 'assistant',
      createdAt: 0,
      parts: [
        { type: 'reasoning', text: 'secret thoughts' },
        { type: 'text', text: 'Looking.' },
        { type: 'tool', id: 't1', name: 'read_file', input: { path: 'a' }, output: 'A', status: 'done' },
        { type: 'tool', id: 't2', name: 'read_file', input: { path: 'b' }, output: 'B', status: 'done' },
        { type: 'text', text: 'Now editing.' },
        { type: 'tool', id: 't3', name: 'edit_file', input: { path: 'a' }, output: null, status: 'running' },
        { type: 'text', text: 'Done.' }
      ]
    },
    user('u2', 'thanks')
  ]
  const { messages } = buildHistory(history, null, 2)
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'user']
  )
  const first = messages[1] as Extract<(typeof messages)[number], { role: 'assistant' }>
  assert.equal(first.text, 'Looking.')
  assert.equal(first.calls.length, 2)
  // Reasoning is never resent.
  assert.ok(!JSON.stringify(messages).includes('secret thoughts'))
  // An interrupted call still gets a result, or every provider rejects the history.
  const interrupted = messages[4] as Extract<(typeof messages)[number], { role: 'tool' }>
  assert.match(interrupted.results[0].output, /interrupted/)
})

test('old tool output and big inputs are trimmed; recent turns are kept whole', () => {
  const big = 'x'.repeat(5000)
  const turn = (n: number): ChatMessage[] => [
    user(`u${n}`, `q${n}`),
    {
      id: `a${n}`,
      role: 'assistant',
      createdAt: 0,
      parts: [{ type: 'tool', id: `t${n}`, name: 'write_file', input: { path: 'f', content: big }, output: big, status: 'done' }]
    }
  ]
  const history = [...turn(1), ...turn(2), ...turn(3), user('u4', 'now')]
  const { messages } = buildHistory(history, null, 2)
  const tools = messages.filter((m) => m.role === 'tool') as Extract<(typeof messages)[number], { role: 'tool' }>[]
  assert.ok(tools[0].results[0].output.length < 1000, 'turn 1 output trimmed')
  assert.ok(tools[1].results[0].output.length < 1000, 'turn 2 output trimmed (older than the last 2 user messages)')
  assert.equal(tools[2].results[0].output.length, 5000, 'turn 3 kept whole')
  const calls = messages.filter((m) => m.role === 'assistant') as Extract<(typeof messages)[number], { role: 'assistant' }>[]
  assert.ok(String(calls[0].calls[0].input.content).length < 1000, 'old write_file body trimmed')
})

test('the same history always serialises identically (cache-stable)', () => {
  const history = [user('u1', 'a'), user('u2', 'b')]
  assert.equal(JSON.stringify(buildHistory(history, 'sum', 2)), JSON.stringify(buildHistory(history, 'sum', 2)))
})

test('in-flight pruning only kicks in past the budget', () => {
  const messages = [
    { role: 'user' as const, text: 'go' },
    ...Array.from({ length: 8 }, (_, i) => [
      { role: 'assistant' as const, text: '', calls: [{ id: `c${i}`, name: 'read_file', input: {} }] },
      { role: 'tool' as const, results: [{ id: `c${i}`, name: 'read_file', output: 'y'.repeat(20_000) }] }
    ]).flat()
  ]
  assert.equal(pruneInFlight(messages, 1_000_000), false)
  assert.equal(pruneInFlight(messages, 10_000), true)
  const tools = messages.filter((m) => m.role === 'tool') as { results: { output: string }[] }[]
  assert.ok(tools[0].results[0].output.length < 1000)
  assert.equal(tools[tools.length - 1].results[0].output.length, 20_000)
})
