/**
 * Eaon's account is a Tokn account: signed out, the prompt at the top of
 * Settings signs in with Tokn, says so, and folds away; Settings → Usage then
 * opens the profiles and the Eaon leaderboard, syncs, and signs out, which
 * brings the prompt back.
 *
 * Tokn is a fake on loopback (EAON_TOKN_HOST and EAON_TOKNS_HOST point at
 * it). The harness records the approval page instead of opening a browser;
 * the scenario plays the browser by following Tokn's redirect itself.
 */
import assert from 'node:assert/strict'
import { startFakeTokn } from './fakeTokn.mjs'
import { openSettings, scenario } from './fixtures.mjs'

scenario('Account: sign in with Tokn from Settings, open the profiles, sync and sign out', { timeout: 120_000 }, async (s) => {
  const tokn = await startFakeTokn()
  try {
    // Two Work tasks counted today, so a sync has agents to send.
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const app = await s.launch({
      env: { EAON_TOKN_HOST: tokn.url, EAON_TOKNS_HOST: `${tokn.url}/eaon` },
      seed: { 'agent-runs.json': { version: 1, days: { [today]: { work: { runs: 2, totalMs: 300_000, longestMs: 200_000 } } } } }
    })
    const page = app.page

    // Only Settings has the account; the sidebar's footer stays as it was.
    assert.equal(await page.eval(() => document.querySelector('.sidebar__footer [data-testid="account-entry"]')), null)
    await openSettings(page, 'Usage')
    await page.find('.settings__account [data-testid="account-entry"]', { text: 'Sign in with Tokn' })
    await page.find('.settings__account [data-testid="account-entry"]', { text: 'toknhq.com' })
    await s.shot(page, 'signed-out')
    await page.click('.settings__account [data-testid="account-entry"]')

    // Tokn's approval page, recorded rather than opened. Approve it, as the browser would.
    const authorize = await page.waitFor(
      async () => (await window.api.usage.account()).signIn.url ?? null,
      { message: 'the Tokn approval page', timeout: 15_000 }
    )
    const opened = await app.openedUrls()
    assert.ok(opened.some((url) => url.startsWith(`${tokn.url}/oauth/authorize`)), `opened: ${opened.join(', ')}`)
    const params = new URL(authorize).searchParams
    assert.equal(params.get('client_id'), 'eaon-desktop')
    const redirect = new URL(/** @type {string} */ (params.get('redirect_uri')))
    redirect.searchParams.set('code', 'code_e2e')
    redirect.searchParams.set('state', /** @type {string} */ (params.get('state')))
    const back = await fetch(redirect, { headers: { Connection: 'close' } })
    assert.equal(back.status, 200)

    // "Signed in" for a moment, then the prompt folds away: the account is in Usage now.
    await page.find('.settings__account', { text: 'Signed in as @alex', timeout: 15_000 })
    await s.shot(page, 'signed-in')
    await page.waitFor(() => !document.querySelector('.settings__account'), { message: 'the sign-in prompt to fold away' })

    const pick = (label) => page.click('.settings__inner .btn', { text: label })
    await pick('Eaon profile')
    await pick('Leaderboard')
    await pick('View on Tokn')
    await page.waitFor(async () => (await window.api.usage.account()).sync.state === 'idle', { message: 'the first sync to finish' })
    const before = tokn.syncs.length
    await pick('Sync now')
    const urls = await app.openedUrls()
    assert.ok(urls.includes(`${tokn.url}/eaon/@alex`), `opened: ${urls.join(', ')}`)
    assert.ok(urls.includes(`${tokn.url}/eaon/`), `opened: ${urls.join(', ')}`)
    assert.ok(urls.some((url) => url.endsWith('/profile/alex')), `opened: ${urls.join(', ')}`)

    // Settings → Usage links the Eaon profile.
    await page.find('.settings__inner .row__title', { text: 'Your Eaon profile' })
    await page.find('.usage-tile', { text: 'Longest agent' })
    await page.find('.usage-tile', { text: '3 min' })
    await s.shot(page, 'settings')

    // Signing in synced once, and Sync now again; each carried the day's agents.
    await page.waitFor(async () => (await window.api.usage.account()).sync.state === 'idle', { message: 'Sync now to finish' })
    assert.ok(before >= 1 && tokn.syncs.length > before, `Tokn got ${tokn.syncs.length} syncs`)
    for (const body of tokn.syncs) {
      assert.ok(String(body.cliVersion).startsWith('eaon-desktop/'))
      assert.deepEqual(body.agents, [{ day: today, tool: 'eaon', runs: 2, totalMs: 300_000, longestMs: 200_000 }])
    }

    await pick('Sign out')
    await page.find('.settings__account [data-testid="account-entry"]', { text: 'Sign in with Tokn' })
  } finally {
    await tokn.close()
  }
})
