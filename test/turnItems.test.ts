import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, ChatToolPart } from '@shared/types'
import { thoughtBody, thoughtHasBody, thoughtTitle, turnItems } from '../src/renderer/src/components/agent/turnItems'
import { runSummary } from '../src/renderer/src/components/agent/Activity'

/**
 * A turn reads in the order it happened: thinking, calls and sentences
 * interleaved. It used to show every thought joined at the top and the calls
 * folded separately below them.
 */

const tool = (id: string, name: string, status: ChatToolPart['status'] = 'done'): ChatToolPart => ({
  type: 'tool',
  id,
  name,
  input: {},
  output: status === 'running' ? null : 'ok',
  status
})
const reasoning = (text: string): ChatMessage['parts'][number] => ({ type: 'reasoning', text })
const text = (value: string): ChatMessage['parts'][number] => ({ type: 'text', text: value })

test('thoughts and calls stay in the order they happened, between the sentences', () => {
  const items = turnItems([
    reasoning('**Checking storage**'),
    tool('a', 'grep'),
    reasoning('**Reading the results**'),
    tool('b', 'read_file'),
    text('Here is what I found.'),
    reasoning('**Deciding**'),
    tool('c', 'update_notes')
  ])
  assert.deepEqual(
    items.map((item) => (item.kind === 'text' ? `text:${item.text}` : item.steps.map((s) => (s.kind === 'thought' ? `thought:${s.text}` : `tool:${s.part.name}`)))),
    [
      ['thought:**Checking storage**', 'tool:grep', 'thought:**Reading the results**', 'tool:read_file'],
      'text:Here is what I found.',
      ['thought:**Deciding**', 'tool:update_notes']
    ]
  )
})

test('whitespace does not split a run, plan calls are left to the plan panel, and a swarm keeps its own row', () => {
  const items = turnItems([
    tool('a', 'read_file'),
    text('\n\n'),
    reasoning('  '),
    tool('b', 'update_plan'),
    tool('c', 'list_dir'),
    tool('d', 'spawn_agents'),
    tool('e', 'read_file')
  ])
  assert.deepEqual(
    items.map((item) => (item.kind === 'steps' ? item.steps.map((s) => s.key) : item.kind)),
    [['a', 'c'], ['d'], ['e']]
  )
})

test('an edit and a command keep cards of their own, splitting the reads around them', () => {
  const items = turnItems([
    reasoning('**Looking around**'),
    tool('a', 'read_file'),
    tool('b', 'grep'),
    tool('c', 'edit_file'),
    tool('d', 'run_command'),
    reasoning('**Checking the result**'),
    tool('e', 'read_file'),
    tool('f', 'write_file'),
    tool('g', 'write_file')
  ])
  assert.deepEqual(
    items.map((item) => (item.kind === 'steps' ? item.steps.map((s) => s.key) : item.kind)),
    [['r0', 'a', 'b'], ['c'], ['d'], ['r5', 'e'], ['f'], ['g']]
  )
})

test("a run keeps its first step's key as it grows, so its open state survives streaming", () => {
  const first = turnItems([reasoning('**A**')])
  const later = turnItems([reasoning('**A**'), tool('x', 'read_file'), reasoning('**B**')])
  assert.equal(first[0].key, later[0].key)
})

test('a thought is titled by its first summary heading, or the latest while it is being written', () => {
  const summary = '**Clarifying Mac memory usage**\n\n**Listing available workers**\n\nThe team has two workers.'
  assert.equal(thoughtTitle(summary), 'Clarifying Mac memory usage')
  assert.equal(thoughtTitle(summary, true), 'Listing available workers')
  assert.equal(thoughtTitle('The user wants a *quick* answer.\nSo keep it short.'), 'The user wants a quick answer.')
  assert.equal(thoughtTitle('**Bold** inside a sentence is not a heading.'), 'Bold inside a sentence is not a heading.')
})

test('a thought opens only when it holds more than the title its folded row shows', () => {
  assert.equal(thoughtHasBody('**Checking storage**'), false)
  assert.equal(thoughtHasBody('**Checking storage**\n\n**Checking memory**'), true, 'the folded row shows only the first')
  assert.equal(thoughtHasBody('**Checking storage**\n\nThe disk is nearly full.'), true)
  assert.equal(thoughtHasBody('One short line.'), false)
  assert.equal(thoughtHasBody('First line.\nSecond line.'), true)
})

test("a run's line leads with the thinking, then says what its calls did", () => {
  const call = (name: string, status: 'done' | 'error' = 'done') => ({ name, status, label: name, detail: '' })
  assert.equal(runSummary([], 2).text, 'Thought about this')
  assert.equal(runSummary([call('update_notes'), call('set_status')], 0).text, 'Updated its notes and updated its status')
  assert.equal(runSummary([call('update_notes'), call('set_status')], 3).text, 'Thought, updated its notes and updated its status')
  const failing = runSummary([call('run_command', 'error'), call('list_dir')], 1)
  assert.equal(failing.text, 'Thought, listed 1 folder')
  assert.equal(failing.failed, 1)
})

test("an open thought does not repeat the title its row already shows", () => {
  const text = '**Checking storage**\n\nThe disk is nearly full.'
  assert.equal(thoughtBody(text, 'Checking storage').trim(), 'The disk is nearly full.')
  // While it streams the row shows the latest title, so the first stays in the body.
  const live = '**Checking storage**\n\n**Checking memory**'
  assert.equal(thoughtBody(live, thoughtTitle(live, true)), live)
  assert.equal(thoughtBody('Plain reasoning.', 'Plain reasoning.'), 'Plain reasoning.')
})
