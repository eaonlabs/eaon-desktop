import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalRow, approvalTitle, askerName } from '../src/renderer/src/components/agent/approvalText'

/**
 * The open chat's question in its transcript: a title saying what the agent
 * wants to do, and under it the thing itself, which opens in full.
 */

test('a command is named by the programs it runs, and shown as typed', () => {
  assert.deepEqual(approvalRow({ tool: 'run_command', input: { command: 'cd app &&  ls -la\n  | find . -name x' } }), {
    title: 'Run ls, find',
    link: 'cd app && ls -la | find . -name x'
  })
  assert.deepEqual(approvalRow({ tool: 'run_command', input: { command: '' } }), { title: 'Run a command', link: 'Show the command' })
})

test('a file change says how big it is and where', () => {
  assert.deepEqual(approvalRow({ tool: 'write_file', input: { path: 'notes/today.md', content: 'a\nb\nc\n' } }), {
    title: 'Write today.md',
    link: '3 lines in notes'
  })
  assert.deepEqual(approvalRow({ tool: 'write_file', input: { path: 'one.txt', content: 'x' } }).link, '1 line')
  // Over a file that's there: a replace, counted against what goes.
  assert.deepEqual(approvalRow({ tool: 'write_file', input: { path: 'qa-note.txt', content: 'one\nTWO\n' }, before: 'one\ntwo\nthree\n' }), {
    title: 'Replace qa-note.txt',
    link: '+1 −2'
  })
  assert.deepEqual(approvalRow({ tool: 'edit_file', input: { path: 'src/app.ts', old_text: 'a\nb', new_text: 'a\nB\nc' } }), {
    title: 'Edit app.ts',
    link: '+2 −1 in src'
  })
})

test('anything else uses its tool\'s own line, or its title without the question', () => {
  assert.deepEqual(approvalRow({ tool: 'email_send', input: { to: 'a@b.c' }, summary: 'To a@b.c: Invoice' }), { title: 'Send this email', link: 'To a@b.c: Invoice' })
  assert.deepEqual(approvalRow({ tool: 'mystery_tool', input: {} }), { title: 'Allow mystery tool', link: 'Show details' })
  assert.equal(approvalTitle('write_file', { path: 'x.txt' }, null), 'Write x.txt?', 'the dialog keeps its question')
})

test('who is asking: Eaon, or a sub-agent by its role', () => {
  assert.equal(askerName(), 'Eaon')
  assert.equal(askerName('tester'), 'Tester')
})
