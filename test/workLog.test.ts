import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, ChatToolPart } from '@shared/types'
import { liveStep, stepSummary, thoughtLine, workLog, type StepCall } from '../src/renderer/src/components/chat/workLog'

/** Chat's work log: sentences, thoughts on lines of their own, and each run of calls folded to one line. */

const tool = (id: string, name: string, status: ChatToolPart['status'] = 'done'): ChatToolPart => ({ type: 'tool', id, name, input: {}, output: 'ok', status })
const reasoning = (text: string): ChatMessage['parts'][number] => ({ type: 'reasoning', text })
const text = (value: string): ChatMessage['parts'][number] => ({ type: 'text', text: value })
const call = (name: string, target = '', status: StepCall['status'] = 'done'): StepCall => ({ name, status, target, label: name })

test('calls between two sentences are one run; a thought is a line of its own and splits runs', () => {
  const items = workLog([
    reasoning('**Looking around**'),
    tool('a', 'read_file'),
    tool('b', 'run_command'),
    text('\n\n'),
    tool('c', 'edit_file'),
    tool('d', 'update_plan'),
    reasoning('**Checking**'),
    tool('e', 'run_command'),
    text('Done.'),
    tool('f', 'spawn_agents')
  ])
  assert.deepEqual(
    items.map((i) => (i.kind === 'tools' ? i.parts.map((p) => p.id).join('') : i.kind)),
    ['thought', 'abc', 'thought', 'e', 'text', 'own']
  )
  // The run keeps its first call's key as it grows.
  assert.equal(workLog([tool('a', 'read_file')])[0].key, workLog([tool('a', 'read_file'), tool('b', 'grep')])[0].key)
})

test('a run reads as what it did, changes first, two kinds at most', () => {
  assert.equal(stepSummary([call('run_command', 'ls')]).text, 'Ran 1 command')
  assert.equal(stepSummary([call('read_file', 'a.ts'), call('run_command', 'ls')]).text, 'Read 1 file and ran 1 command')
  assert.equal(stepSummary([call('read_file', 'a.ts'), call('read_file', 'a.ts'), call('read_file', 'b.ts')]).text, 'Read 2 files')
  assert.equal(stepSummary([call('edit_file', 'a.ts'), call('edit_file', 'a.ts'), call('write_file', 'b.ts')]).text, 'Changed 2 files')
  assert.equal(stepSummary([call('grep'), call('read_file', 'x'), call('web_search'), call('run_command')]).text, 'Searched the code, ran 1 command, and 2 other steps')
  assert.equal(stepSummary([call('message_worker', 'Pixel')]).text, 'Messaged Pixel')
  const failing = stepSummary([call('run_command', 'npm test', 'error'), call('run_command', 'ls')])
  assert.deepEqual([failing.text, failing.failed, failing.kind], ['Ran 2 commands', 1, 'command'])
  assert.equal(stepSummary([call('read_file', 'x'), call('run_command')]).kind, 'mixed')
  // A read-only automation's refused write changed nothing.
  const refused = stepSummary([call('read_file', 'a.ts'), call('write_file', 'notes.md', 'denied')])
  // Skipped, not failed: nothing went wrong, it didn't run.
  assert.deepEqual([refused.text, refused.failed, refused.skipped], ['Read 1 file and tried to change 1 file', 0, 1])
  assert.equal(stepSummary([call('run_command', 'rm x', 'denied')]).text, 'Tried to run 1 command')
  // One edit went through, one was refused: what went through is counted.
  assert.equal(stepSummary([call('edit_file', 'a.ts'), call('edit_file', 'b.ts', 'denied')]).text, 'Changed 1 file')
})

test('a running call says what it is doing now', () => {
  assert.equal(liveStep(call('run_command', 'npm test', 'running')), 'Running npm test')
  assert.equal(liveStep(call('edit_file', 'src/app.ts', 'running')), 'Editing src/app.ts')
  assert.equal(liveStep(call('write_file', 'src/new.ts', 'running')), 'Writing src/new.ts')
  assert.equal(liveStep(call('browser', 'click', 'running')), 'Using the browser')
})

test('a thought’s line is its title, or its first sentence, as plain text', () => {
  assert.equal(thoughtLine('**Checking the fonts**\n\nThe TTF files look valid.'), 'Checking the fonts')
  assert.equal(thoughtLine('The TTF files look **valid**, so the screenshots are stale. Next I check.'), 'The TTF files look valid, so the screenshots are stale.')
  assert.equal(thoughtLine('One line with `code`'), 'One line with code')
})

test('an opened thought leaves out the title its line shows', async () => {
  const { thoughtRest } = await import('../src/renderer/src/components/chat/workLog')
  assert.equal(thoughtRest('**Checking**\n\nThe disk is full.'), 'The disk is full.')
  assert.equal(thoughtRest('Plain reasoning.'), 'Plain reasoning.')
})

test('a worker going to sleep says so, not "used 1 tool"', () => {
  assert.equal(stepSummary([call('sleep', '')]).text, 'Went to sleep until later')
  assert.equal(stepSummary([call('sleep', ''), call('sleep', '')]).text, 'Went to sleep 2 times')
})
