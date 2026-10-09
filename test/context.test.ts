import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHistory, pruneImages, pruneInFlight } from '../src/main/agent/context'
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

test('screenshots in flight are dropped in batches, keeping the newest', () => {
  const shot = (i: number) => [
    { role: 'assistant' as const, text: '', calls: [{ id: `s${i}`, name: 'computer', input: {} }] },
    { role: 'tool' as const, results: [{ id: `s${i}`, name: 'computer', output: 'ok', images: [{ mime: 'image/jpeg', data: 'AA' }] }] }
  ]
  const messages = [{ role: 'user' as const, text: 'go' }, ...[1, 2, 3, 4].flatMap(shot)]
  assert.equal(pruneImages(messages), false, 'four is under the trigger')
  messages.push(...shot(5))
  assert.equal(pruneImages(messages), true)
  const withImages = messages.filter((m) => m.role === 'tool' && m.results[0].images)
  assert.equal(withImages.length, 1)
})

test('attachments are sized up before they are read: big files are named, not loaded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaon-attach-'))
  const note = join(dir, 'note.txt')
  writeFileSync(note, 'hello')
  const log = join(dir, 'huge.log')
  writeFileSync(log, '')
  truncateSync(log, 3 * 1024 * 1024 * 1024)
  const photo = join(dir, 'photo.png')
  writeFileSync(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const poster = join(dir, 'poster.png')
  writeFileSync(poster, '')
  truncateSync(poster, 25 * 1024 * 1024)
  const history: ChatMessage[] = [{ ...user('u1', 'look'), attachments: [note, log, photo, poster, dir] }]
  const started = Date.now()
  const [message] = buildHistory(history, null, 2).messages as Extract<ReturnType<typeof buildHistory>['messages'][number], { role: 'user' }>[]
  assert.ok(Date.now() - started < 1000, 'a 3 GB attachment is not read')
  assert.match(message.text, /Attached file .*note\.txt:\n```\nhello\n```/)
  assert.match(message.text, /\[Attached: .*huge\.log\]/)
  assert.match(message.text, /poster\.png was not sent: it is 25 MB, and images are limited to 20 MB/)
  assert.equal(message.images?.length, 1, 'only the small image is sent')
  rmSync(dir, { recursive: true, force: true })
})
