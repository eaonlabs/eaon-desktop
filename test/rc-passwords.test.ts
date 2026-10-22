import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkNothing, checkPassword, fromBase32, hashPassword, passwordProblem, seal, toBase32, totpCode, totpStep, unseal } from '../cloud/rc/src/password'

/**
 * Password sign-in on Eaon Remote (cloud/rc/src/password.ts): hashing, the
 * rules for a new password, and 2-step codes. The sign-in flow itself
 * (lockouts, sessions) runs in Durable Objects and is checked against
 * `wrangler dev`.
 */

test('a password checks against its own hash only, and needs the same pepper', async () => {
  const stored = await hashPassword('pepper-a', 'plum ferry cactus lantern')
  assert.equal(await checkPassword('pepper-a', 'plum ferry cactus lantern', stored), true)
  assert.equal(await checkPassword('pepper-a', 'plum ferry cactus lanterN', stored), false)
  assert.equal(await checkPassword('pepper-b', 'plum ferry cactus lantern', stored), false)
  // Same password, new salt: a different hash.
  assert.notEqual((await hashPassword('pepper-a', 'plum ferry cactus lantern')).hash, stored.hash)
  assert.equal(await checkNothing('pepper-a', 'plum ferry cactus lantern'), false)
})

test('a new password: long enough, not repetitive, without the username', () => {
  assert.match(passwordProblem('short', 'alice') ?? '', /12 characters/)
  assert.match(passwordProblem('aaaaaaaaaaaaaaaa', 'alice') ?? '', /repeats/)
  assert.match(passwordProblem('my-Alice-password-1', 'alice') ?? '', /username/)
  assert.equal(passwordProblem('plum ferry cactus lantern', 'alice'), null)
})

test('2-step codes match RFC 6238, allow one step of clock drift, and never work twice', async () => {
  // RFC 6238's SHA-1 key, at T = 59s (step 1): 94287082, of which an app shows the last 6 digits.
  const rfc = new TextEncoder().encode('12345678901234567890')
  assert.equal(await totpCode(rfc, 1), '287082')
  assert.deepEqual(fromBase32(toBase32(rfc)), rfc)

  const now = 1_800_000_000_000
  const step = Math.floor(now / 30_000)
  const code = await totpCode(rfc, step)
  assert.equal(await totpStep(rfc, code, now, 0), step)
  assert.equal(await totpStep(rfc, await totpCode(rfc, step - 1), now, 0), step - 1)
  assert.equal(await totpStep(rfc, await totpCode(rfc, step - 2), now, 0), null)
  assert.equal(await totpStep(rfc, code, now, step), null, 'a used step')
  assert.equal(await totpStep(rfc, 'abcdef', now, 0), null)
})

test('a sealed 2-step secret opens only with the same pepper', async () => {
  const secret = crypto.getRandomValues(new Uint8Array(20))
  const sealed = await seal('pepper-a', secret)
  assert.deepEqual(await unseal('pepper-a', sealed), secret)
  await assert.rejects(unseal('pepper-b', sealed))
})
