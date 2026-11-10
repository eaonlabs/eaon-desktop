import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FEEDBACK_CHARS, checkFeedback, detectCheckCommand, normalizeChecks, parseRunOutput, type ProjectFacts } from '../src/shared/projectChecks'
import { checkAfterEdits, projectFacts } from '../src/main/agent/checks'
import { defaultSettings } from '../src/main/store'
import type { Settings } from '../src/shared/types'

/** Type and lint errors fed back to the agent: finding the project's check, running it, and what the agent is told. */

let dir = ''
before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checks-')))
})
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({ scripts: {}, tsconfig: false, typescript: false, runner: 'npm', ...over })
const settings = (command: string, enabled = true): Settings => ({ ...defaultSettings, general: { ...defaultSettings.general, checks: { enabled, command } } })

test('a project’s own check is its typecheck, check or lint script, then tsc when TypeScript is installed', () => {
  assert.equal(detectCheckCommand(facts({ scripts: { typecheck: 'tsc', lint: 'eslint .' } })), 'npm run typecheck')
  assert.equal(detectCheckCommand(facts({ scripts: { lint: 'eslint .' }, runner: 'pnpm' })), 'pnpm run lint')
  assert.equal(detectCheckCommand(facts({ scripts: { check: 'x' }, runner: 'yarn' })), 'yarn check')
  assert.equal(detectCheckCommand(facts({ tsconfig: true, typescript: true })), 'npx --no-install tsc --noEmit')
  assert.equal(detectCheckCommand(facts({ tsconfig: true })), null, 'a tsconfig without TypeScript installed would only download it')
  assert.equal(detectCheckCommand(facts()), null)
})

test('what the folder says about itself is read from package.json and its lock file', () => {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', build: 'x', bad: 5 } }))
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}')
  assert.deepEqual(projectFacts(dir), { scripts: { typecheck: 'tsc --noEmit', build: 'x' }, tsconfig: true, typescript: false, runner: 'pnpm' })
  assert.deepEqual(projectFacts(path.join(dir, 'nowhere')).scripts, {})
})

test('settings are cleaned, and a failing check is told to the agent with the start of what it printed', () => {
  assert.deepEqual(normalizeChecks({ enabled: 'yes', command: '  npm run lint \n' }), { enabled: false, command: 'npm run lint' })
  assert.deepEqual(normalizeChecks(undefined), { enabled: false, command: '' })
  assert.equal(checkFeedback('npm run lint', { code: 0, output: 'ok' }, false), null, 'a pass says nothing')
  assert.match(checkFeedback('npm run lint', { code: 0, output: '' }, true)!, /passes now/)
  const failed = checkFeedback('tsc', { code: 2, output: 'src/a.ts(3,1): error TS2322: nope\n' }, false)!
  assert.match(failed, /`tsc` failed \(exit code 2\)\. Fix these before going on\.\]\nsrc\/a\.ts\(3,1\): error TS2322/)
  const long = checkFeedback('tsc', { code: 1, output: 'e'.repeat(FEEDBACK_CHARS * 2) }, false)!
  assert.ok(long.length < FEEDBACK_CHARS + 300)
  assert.match(long, /Output cut here/)
  assert.match(checkFeedback('tsc', { code: null, output: '' }, false)!, /did not finish/)
  assert.deepEqual(parseRunOutput('exit code 2\nboom\n'), { code: 2, output: 'boom\n' })
  assert.deepEqual(parseRunOutput('terminated (SIGKILL)\nstuck'), { code: null, output: 'stuck' })
})

test('after edits the check really runs in the folder, a failure comes back, and a later pass is said once', async () => {
  fs.writeFileSync(path.join(dir, 'flag.txt'), 'broken')
  const command = `node -e "const fs=require('fs');if(fs.readFileSync('flag.txt','utf8')==='broken'){console.error('src/a.ts(1,1): error TS1: oops');process.exit(2)}"`
  const state = { runs: 0, failing: false }
  const signal = new AbortController().signal
  const first = await checkAfterEdits(dir, settings(command), state, signal)
  assert.ok(first?.failed)
  assert.match(first!.text, /failed \(exit code 2\)[\s\S]*error TS1: oops/)
  fs.writeFileSync(path.join(dir, 'flag.txt'), 'fixed')
  const second = await checkAfterEdits(dir, settings(command), state, signal)
  assert.ok(second && !second.failed && /passes now/.test(second.text))
  assert.equal(await checkAfterEdits(dir, settings(command), state, signal), null, 'passing again is not worth saying')
  assert.equal(state.runs, 3)
})

test('checks that are off, have nothing to run, or have run enough do nothing', async () => {
  const signal = new AbortController().signal
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-bare-'))
  try {
    assert.equal(await checkAfterEdits(dir, settings('exit 3', false), { runs: 0, failing: false }, signal), null, 'off')
    assert.equal(await checkAfterEdits(bare, settings(''), { runs: 0, failing: false }, signal), null, 'no script, no tsc')
    assert.equal(await checkAfterEdits(dir, settings('exit 3'), { runs: 12, failing: false }, signal), null, 'a turn has a limit')
    const aborted = new AbortController()
    aborted.abort()
    assert.equal(await checkAfterEdits(dir, settings('exit 3'), { runs: 0, failing: false }, aborted.signal), null, 'a stopped turn runs nothing')
  } finally {
    fs.rmSync(bare, { recursive: true, force: true })
  }
})
