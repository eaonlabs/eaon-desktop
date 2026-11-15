import { test } from 'node:test'
import assert from 'node:assert/strict'
import { irreversibleReason, riskReason } from '../src/main/features/computer/actions'
import { irreversibleCombo, parseCombo } from '../src/main/features/computer/keys'
import { cuaIrreversible, cuaRisk } from '../src/main/features/computer/cuaTools'
import { commandIrreversible, commandRisk } from '../src/main/features/appControl/safety'

/**
 * With Full access only what can't be undone asks (agent/policy.ts asks a
 * tool's `catastrophic`). For screen and app control that used to be all of
 * what Auto asks about, so moving a file to the Trash or typing `rm -rf
 * build` into a terminal asked even with Full access, while run_command ran
 * the same command without asking. These pin the line between the two.
 */

test('screen control: what Auto asks about but Full access runs, and what still asks', () => {
  // Risky (Auto asks), undoable (Full access runs).
  for (const input of [
    { action: 'key', keys: 'cmd+backspace' },
    { action: 'key', keys: 'cmd+q' },
    { action: 'type', text: 'rm -rf node_modules' },
    { action: 'type', text: 'git push origin main' }
  ]) {
    assert.notEqual(riskReason(input, 'darwin'), null, `${JSON.stringify(input)} is risky`)
    assert.equal(irreversibleReason(input, 'darwin'), null, `${JSON.stringify(input)} runs with Full access`)
  }
  // Can't be undone: asks even with Full access.
  assert.match(irreversibleReason({ action: 'key', keys: 'cmd+shift+backspace' }, 'darwin') ?? '', /empties the Trash/)
  assert.match(irreversibleReason({ action: 'key', keys: 'cmd+shift+q' }, 'darwin') ?? '', /logs you out/)
  assert.match(irreversibleReason({ action: 'key', keys: 'shift+delete' }, 'win32') ?? '', /permanently deletes/)
  assert.notEqual(irreversibleReason({ action: 'type', text: 'sudo rm -rf /var/db' }, 'darwin'), null)
  assert.notEqual(irreversibleReason({ action: 'type', text: 'git push --force origin main' }, 'darwin'), null)
  assert.equal(irreversibleReason({ action: 'click', x: 1, y: 2 }, 'darwin'), null)
  assert.equal(irreversibleCombo(parseCombo('cmd+w'), 'darwin'), null)
})

test('Cua desktop tools follow the same line', () => {
  assert.notEqual(cuaRisk('hotkey', { keys: ['cmd', 'backspace'] }, 'darwin'), null)
  assert.equal(cuaIrreversible('hotkey', { keys: ['cmd', 'backspace'] }, 'darwin'), null)
  assert.notEqual(cuaIrreversible('hotkey', { keys: ['cmd', 'shift', 'backspace'] }, 'darwin'), null)
  assert.equal(cuaIrreversible('type_text', { text: 'rm -rf dist' }, 'darwin'), null)
  assert.notEqual(cuaIrreversible('type_text', { text: 'sudo shutdown -h now' }, 'darwin'), null)
})

test('app control: undoable steps run with Full access; sudo typed into a terminal asks (it used to run)', () => {
  assert.notEqual(commandRisk('press', { keys: 'cmd+q' }, 'Notes', 'darwin'), null)
  assert.equal(commandIrreversible('press', { keys: 'cmd+q' }, 'Notes', 'darwin'), null)
  assert.notEqual(commandIrreversible('press', { keys: 'cmd+shift+backspace' }, 'Finder', 'darwin'), null)
  assert.notEqual(commandRisk('type', { text: 'rm -rf build\n' }, 'Terminal', 'darwin'), null)
  assert.equal(commandIrreversible('type', { text: 'rm -rf build\n' }, 'Terminal', 'darwin'), null)
  assert.notEqual(commandIrreversible('type', { text: 'sudo rm -rf /Library/Caches\n' }, 'Terminal', 'darwin'), null)
  // Words in a document are only words.
  assert.equal(commandIrreversible('type', { text: 'sudo rm -rf /' }, 'Notes', 'darwin'), null)
})
