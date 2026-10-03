import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalRisk } from '../src/renderer/src/components/agent/ApprovalCard'

/** The approval card's colour follows what the call would do, not only which tool it is. */
test('a destructive or credential-reading command is high risk; an ordinary one is not', () => {
  assert.equal(approvalRisk('run_command', { command: 'npm test' }), 'medium')
  assert.equal(approvalRisk('run_command', { command: 'rm -rf ~/Library/Caches/com.google.Chrome' }), 'high')
  assert.equal(approvalRisk('run_command', { command: 'sudo shutdown -h now' }), 'high')
  assert.equal(approvalRisk('run_command', { command: 'cat ~/.ssh/id_rsa' }), 'high')
  assert.equal(approvalRisk('run_command'), 'medium', 'no input: by tool')
  assert.equal(approvalRisk('email_send', {}), 'high')
  assert.equal(approvalRisk('edit_file', { path: 'a.ts' }), 'low')
})
