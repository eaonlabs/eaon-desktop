import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STAR_REPO, STAR_REPO_URL } from '@shared/star'
import type { Settings } from '@shared/types'
import { alreadyStarred, ASK_EVERY_MS, MAX_ASKS, MIN_LAUNCHES, shouldAsk, starRepository, type Gh } from '../src/main/starPrompt'

/**
 * The "star Eaon on GitHub" popup: when it asks, and what pressing the button
 * does. The GitHub CLI is a stand-in; nothing here can star a real account.
 */

const base = (over: Partial<Settings['starPrompt']> = {}): Settings['starPrompt'] => ({ status: 'pending', launches: MIN_LAUNCHES, asked: 0, lastAskedAt: null, ...over })
const NOW = 1_800_000_000_000

test('it does not ask on the first launches, and asks once there have been enough', () => {
  assert.equal(shouldAsk(base({ launches: 0 }), NOW), false)
  assert.equal(shouldAsk(base({ launches: MIN_LAUNCHES - 1 }), NOW), false)
  assert.equal(shouldAsk(base({ launches: MIN_LAUNCHES }), NOW), true)
})

test('it waits a week after a Later, and asks three times at most', () => {
  assert.equal(shouldAsk(base({ asked: 1, lastAskedAt: NOW - ASK_EVERY_MS + 1000 }), NOW), false, 'not yet')
  assert.equal(shouldAsk(base({ asked: 1, lastAskedAt: NOW - ASK_EVERY_MS }), NOW), true)
  assert.equal(shouldAsk(base({ asked: MAX_ASKS, lastAskedAt: NOW - 10 * ASK_EVERY_MS }), NOW), false, 'three asks is enough')
})

test('it never asks again once they have starred it or said no thanks', () => {
  assert.equal(shouldAsk(base({ status: 'starred' }), NOW), false)
  assert.equal(shouldAsk(base({ status: 'declined' }), NOW), false)
})

test('Star on GitHub opens the repository and stars it through the signed-in GitHub CLI', async () => {
  const calls: string[][] = []
  const opened: string[] = []
  const gh: Gh = async (args) => (calls.push(args), { ok: true })
  const result = await starRepository(async (url) => void opened.push(url), gh)
  assert.deepEqual(result, { starred: true })
  assert.deepEqual(opened, ['https://github.com/eaonlabs/eaon-desktop'])
  assert.equal(STAR_REPO_URL, opened[0])
  assert.deepEqual(calls, [['api', '--method', 'PUT', `/user/starred/${STAR_REPO}`]], 'one request, to star this repository and nothing else')
})

test('without the GitHub CLI, or signed out, the page still opens and the person is told why', async () => {
  for (const reason of ['no-gh', 'not-signed-in', 'failed'] as const) {
    const opened: string[] = []
    const result = await starRepository(async (url) => void opened.push(url), async () => ({ ok: false, reason }))
    assert.deepEqual(result, { starred: false, reason })
    assert.equal(opened.length, 1, `the page opens (${reason})`)
  }
})

test('a page that cannot be opened does not stop the star, or throw', async () => {
  const result = await starRepository(async () => {
    throw new Error('no browser')
  }, async () => ({ ok: true }))
  assert.deepEqual(result, { starred: true })
})

test('someone who already starred it is recognised, and a 404 means not yet', async () => {
  assert.equal(await alreadyStarred(async (args) => (assert.deepEqual(args, ['api', `/user/starred/${STAR_REPO}`]), { ok: true })), true)
  assert.equal(await alreadyStarred(async () => ({ ok: false, reason: 'failed' })), false)
  assert.equal(await alreadyStarred(async () => ({ ok: false, reason: 'no-gh' })), false)
})

test('in a session it asks after 10 to 20 minutes of use, from the first launch', async () => {
  const { askAfterMs, ASK_AFTER_MIN_MS, ASK_AFTER_MAX_MS } = await import('@shared/star')
  assert.equal(ASK_AFTER_MIN_MS, 10 * 60_000)
  assert.equal(ASK_AFTER_MAX_MS, 20 * 60_000)
  for (const r of [0, 0.25, 0.5, 0.999, 1, -1, 2]) {
    const wait = askAfterMs(r)
    assert.ok(wait >= ASK_AFTER_MIN_MS && wait < ASK_AFTER_MAX_MS, `${r}: ${wait}`)
  }
  assert.equal(shouldAsk(base({ launches: 1 }), NOW), true, 'the first session can be the one')
})
