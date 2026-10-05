import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalRisk, enterApproves, startsOnDeny } from '../src/renderer/src/components/agent/ApprovalCard'

/**
 * ⏎ on the approval card: the composer sits right behind it, and ⏎ there
 * means "send" — it must never approve a command the user was only typing
 * near.
 */

const nothing = { button: false, field: false, inCard: false, nothingFocused: true }

test('⏎ approves a routine call from the card or with nothing focused, and from nowhere else', () => {
  assert.equal(enterApproves(nothing, 'medium'), true)
  assert.equal(enterApproves({ ...nothing, nothingFocused: false, inCard: true }, 'low'), true)
  // The composer (a text box) behind the card: ⏎ is "send", never "approve".
  assert.equal(enterApproves({ ...nothing, nothingFocused: false, field: true }, 'low'), false)
  assert.equal(enterApproves({ ...nothing, nothingFocused: false, field: true, inCard: true }, 'low'), false, 'nor the note field on the card')
  // A button answers ⏎ itself.
  assert.equal(enterApproves({ ...nothing, nothingFocused: false, button: true }, 'low'), false)
  // Something else on the page has focus.
  assert.equal(enterApproves({ ...nothing, nothingFocused: false }, 'low'), false)
})

test('a call that could delete or change the system is never approved with ⏎', () => {
  assert.equal(approvalRisk('run_command', { command: 'rm -rf build' }), 'high')
  assert.equal(enterApproves(nothing, approvalRisk('run_command', { command: 'rm -rf build' })), false)
  assert.equal(enterApproves({ ...nothing, nothingFocused: false, inCard: true }, 'high'), false)
  assert.equal(enterApproves(nothing, approvalRisk('run_command', { command: 'ls' })), true)
})

test('a dialog for a call that could delete or change the system starts on Deny, so a stray ⏎ or Space cannot approve it', () => {
  assert.equal(startsOnDeny(approvalRisk('run_command', { command: 'rm -rf ~/Projects' })), true)
  assert.equal(startsOnDeny(approvalRisk('write_file', { path: '/tmp/a.txt', content: 'x' })), false)
})
