import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrerelease, updateChannelFor } from '../src/main/updateChannel'

/**
 * Which update channel a build follows. A custom prerelease tag (rc) pinned the
 * 2026.6.0 release candidate to rc releases, so it never saw 2026.6.0 or
 * 2026.6.1; such builds follow "beta", which moves on to the next stable.
 */

test('a release candidate follows beta, so it moves on to the next stable release', () => {
  assert.equal(updateChannelFor('2026.6.0-rc.1'), 'beta')
  assert.equal(updateChannelFor('2026.7.0-preview.3'), 'beta')
})

test("stable, alpha and beta builds keep electron-updater's own choice", () => {
  assert.equal(updateChannelFor('2026.6.1'), null)
  assert.equal(updateChannelFor('2026.6.0-beta.1'), null)
  assert.equal(updateChannelFor('2026.6.0-alpha.2'), null)
})

test('only a prerelease build is offered the way back to stable', () => {
  for (const beta of ['2026.6.2-beta.3', '2026.6.0-rc.1', '2026.7.0-alpha.2', '2026.7.0-preview.3']) assert.equal(isPrerelease(beta), true, beta)
  for (const stable of ['2026.6.0', '2026.6.1', '2026.6.2', '', 'x']) assert.equal(isPrerelease(stable), false, stable)
})
