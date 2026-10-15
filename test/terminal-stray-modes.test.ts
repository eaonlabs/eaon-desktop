import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMouseReport, shellInForeground, STRAY_MODES_OFF } from '../src/main/features/terminals/strayModes'

/**
 * A CLI that ends without turning mouse reporting off leaves the pane sending
 * every mouse move to the shell, which prints `35;40;26M…` at its prompt.
 * Reports the shell would get are recognised and dropped (ptyManager.write).
 */

test('mouse reports are recognised, alone or several in one write', () => {
  assert.ok(isMouseReport('\x1b[<35;40;26M'))
  assert.ok(isMouseReport('\x1b[<0;12;3m'))
  assert.ok(isMouseReport('\x1b[<35;40;26M\x1b[<35;41;26M\x1b[<35;42;26M'))
  assert.ok(isMouseReport('\x1b[32;40;26M'), 'urxvt form')
  assert.ok(isMouseReport('\x1b[M #!'), 'X10 form')
})

test('typing, pasting and keys are never mistaken for mouse reports', () => {
  for (const input of ['a', 'ls -la\r', '\x1b[A', '\x1b[1;5C', '\x1b[200~text\x1b[201~', '\r', '35;40;26M', '\x1b[<35;40;26Mx', '']) {
    assert.equal(isMouseReport(input), false, JSON.stringify(input))
  }
})

test('the shell is in the foreground only when the foreground program is that shell', () => {
  assert.ok(shellInForeground('zsh', '/bin/zsh', 'darwin'))
  assert.ok(shellInForeground('-zsh', '/bin/zsh', 'darwin'), 'a login shell')
  assert.ok(shellInForeground('bash', '/usr/bin/bash', 'linux'))
  assert.equal(shellInForeground('claude', '/bin/zsh', 'darwin'), false)
  assert.equal(shellInForeground('node', '/bin/zsh', 'darwin'), false)
  assert.equal(shellInForeground('tmux', '/bin/zsh', 'linux'), false)
  assert.equal(shellInForeground(undefined, '/bin/zsh', 'darwin'), false)
  // ConPTY always names the shell it started, whatever runs in it.
  assert.equal(shellInForeground('pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'), false)
})

test('switching off turns every mouse mode and focus reporting off and shows the cursor', () => {
  for (const mode of ['9', '1000', '1002', '1003', '1005', '1006', '1015', '1016', '1004']) assert.ok(STRAY_MODES_OFF.includes(`\x1b[?${mode}l`), mode)
  assert.ok(STRAY_MODES_OFF.includes('\x1b[?25h'))
})
