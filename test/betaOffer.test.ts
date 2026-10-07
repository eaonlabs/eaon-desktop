import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BETA_WARNING, betaDialogText, isOfferable, isPrerelease } from '../src/main/betaOffer'

/** What a stable build offers, and the words it uses. The real updater is exercised separately, against a fake GitHub. */

test('the warning is the one the user asked for, and the dialog repeats that nothing installs unasked', () => {
  assert.equal(BETA_WARNING, 'UPDATE IF YOU WANT YOUR APP TO BE UNSTABLE, BETA UPDATE ONLY')
  const text = betaDialogText('2026.6.2-beta.4')
  assert.equal(text.message, BETA_WARNING)
  assert.match(text.detail, /2026\.6\.2-beta\.4 is a beta/)
  assert.match(text.detail, /Nothing is installed unless you choose Update to beta/)
})

test('a stable build is offered a prerelease of a newer version, and nothing else', () => {
  assert.equal(isOfferable('2026.6.1', '2026.6.2-beta.4'), true)
  assert.equal(isOfferable('2026.6.1', '2026.7.0-rc.1'), true)
  assert.equal(isOfferable('2026.6.1', '2027.1.0-beta.1'), true)
  // Not newer: a prerelease of this version comes before the stable one; older ones are behind.
  assert.equal(isOfferable('2026.6.1', '2026.6.1-beta.2'), false)
  assert.equal(isOfferable('2026.6.1', '2026.6.0-rc.1'), false)
  // A newer stable release is the normal update, not an offer.
  assert.equal(isOfferable('2026.6.1', '2026.6.2'), false)
  // Nothing found, or nonsense.
  for (const found of [null, undefined, '', 'beta', 'v-x']) assert.equal(isOfferable('2026.6.1', found), false, String(found))
  // A beta build follows its own feed; it is never "offered" one.
  assert.equal(isOfferable('2026.6.2-beta.3', '2026.6.2-beta.4'), false)
  assert.equal(isPrerelease('2026.6.2-beta.4'), true)
  assert.equal(isPrerelease('2026.6.1'), false)
})
