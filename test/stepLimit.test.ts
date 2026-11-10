import { test } from 'node:test'
import assert from 'node:assert/strict'
import { store } from '../src/main/store'
import { noStepLimitByDefault, OLD_DEFAULT_STEPS } from '../src/main/agent/stepLimit'

/** The migration that takes installs off the old default step limit. */

const steps = (): number => store.getSettings().codeIndex.maxToolRounds
const set = (n: number): void => void store.patchSettings({ codeIndex: { ...store.getSettings().codeIndex, maxToolRounds: n } })

test('a new install has no step limit', () => {
  assert.equal(steps(), 0)
})

test('the old default becomes no limit; a number picked by hand stays', () => {
  set(OLD_DEFAULT_STEPS)
  noStepLimitByDefault()
  assert.equal(steps(), 0)
  set(80)
  noStepLimitByDefault()
  assert.equal(steps(), 80)
  set(0)
  noStepLimitByDefault()
  assert.equal(steps(), 0)
})
