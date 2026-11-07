import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FINISHED_AFTER_MS, approvalGate, approvalNotice, approvalWants, finishedNotice } from '../src/shared/chatNotice'

/**
 * The notifications Chat sends while Eaon isn't in front (shared/chatNotice.ts):
 * what they say, and that a run asking several things at once raises one.
 */

test('a task that ran a while is announced when it ends, with an error said as one', () => {
  assert.deepEqual(finishedNotice({ mode: 'work', chatTitle: 'Fix the login redirect' }, undefined, FINISHED_AFTER_MS), { title: 'Task finished', body: 'Fix the login redirect' })
  assert.deepEqual(finishedNotice({ mode: 'work', chatTitle: '' }, 'rate limited', 60_000), { title: 'Task stopped with an error', body: 'Eaon' })
  assert.equal(finishedNotice({ mode: 'work', chatTitle: 'x' }, undefined, FINISHED_AFTER_MS - 1), null, 'a short one ends before anyone looked away')
  assert.equal(finishedNotice({ mode: 'chat', chatTitle: 'x' }, undefined, 120_000), null, 'only coding and work runs')
})

test('an approval says what kind of thing is asked, never the whole command', () => {
  const ask = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    approvalNotice({ chatTitle: 'Tidy the repo' }, { type: 'approval-request', messageId: 'm', requestId: 'r', tool, input, ...extra })
  assert.deepEqual(ask('run_command', { command: 'npm test -- --token=abc123' }), { title: 'Tidy the repo needs your OK', body: 'Wants to run npm' })
  assert.equal(ask('run_command', { command: '/usr/local/bin/Node script.js' }).body, 'Wants to run node')
  assert.equal(ask('run_command', {}).body, 'Wants to run a command')
  assert.equal(ask('write_file', { path: '/Users/me/project/src/app.ts', content: 'secret' }).body, 'Wants to change app.ts')
  assert.equal(ask('delete_file', {}).body, 'Wants to change a file')
  assert.equal(ask('browser', {}, { summary: 'Click [2] button "Place order"' }).body, 'Wants to click [2] button "Place order"')
  assert.equal(ask('browser', {}, { summary: '[2] click the button' }).body, 'Wants to [2] click the button')
  assert.equal(ask('email_send', {}).body, 'Wants to use email send')
  assert.equal(ask('email_send', {}, { summary: 'x'.repeat(300) }).body.length, 100)
  assert.equal(ask('run_command', { command: 'ls' }, { agent: 'tester' }).title, 'tester in Tidy the repo needs your OK')
  assert.equal(approvalNotice({ chatTitle: '' }, { type: 'approval-request', messageId: 'm', requestId: 'r', tool: 'x', input: {} }).title, 'Eaon needs your OK')
  assert.equal(approvalWants({ tool: 'run_command', input: { command: 'rm -rf build' } }), 'Wants to run rm')
})

test('a run that asks several things at once raises one banner, and asks again later', () => {
  const gate = approvalGate(15_000)
  assert.equal(gate('run-1', 1_000), true)
  assert.equal(gate('run-1', 2_000), false)
  assert.equal(gate('run-2', 2_000), true, 'another run has its own')
  assert.equal(gate('run-1', 16_001), true, 'it asked again after the person had time to answer')
  assert.equal(gate('run-1', 17_000), false)
  // Forgotten runs are dropped as time passes, and a forgotten one is new again.
  assert.equal(gate('run-3', 500_000), true)
  assert.equal(gate('run-2', 500_001), true)
})
