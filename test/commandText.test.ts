import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandSummary, splitCommandOutput } from '../src/renderer/src/components/agent/commandText'

/**
 * A command's card names the programs it ran and says how it ended, read
 * from the command line and from run_command's own first output line.
 */

test('the header names the programs a command line runs, once each', () => {
  assert.equal(commandSummary('npm test'), 'npm')
  assert.equal(commandSummary('cd app && NODE_ENV=test npm test | grep fail'), 'npm, grep')
  assert.equal(commandSummary('cd app'), 'cd', 'a lone cd is still what ran')
  assert.equal(commandSummary('sudo ./node_modules/.bin/tsc --noEmit; tsc -b'), 'tsc')
  assert.equal(commandSummary('git status && git diff && ls; pwd; echo hi'), 'git, ls, pwd, echo')
  assert.equal(commandSummary('(cd web && npm run build)'), 'npm')
  assert.equal(commandSummary(''), '')
})

test("run_command's status line becomes the exit badge, and the rest is the output", () => {
  assert.deepEqual(splitCommandOutput('exit code 0\nok\n'), { exit: 0, signal: null, text: 'ok\n' })
  assert.deepEqual(splitCommandOutput('exit code 2\n(no output)'), { exit: 2, signal: null, text: '' })
  assert.deepEqual(splitCommandOutput('terminated (SIGKILL)\npartial'), { exit: null, signal: 'SIGKILL', text: 'partial' })
  // A background start or an error has no status line: all of it is shown.
  assert.deepEqual(splitCommandOutput('Started in the background, pid 42.\nlog'), {
    exit: null,
    signal: null,
    text: 'Started in the background, pid 42.\nlog'
  })
  assert.deepEqual(splitCommandOutput(null), { exit: null, signal: null, text: '' })
})
