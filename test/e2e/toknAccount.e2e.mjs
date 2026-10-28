/**
 * Eaon's account is a Tokn account: signed out, the prompt at the top of
 * Settings signs in with Tokn, says so, and folds away; Settings → Usage then
 * opens the Tokn profile, shows Claude Code's use from its log next to Eaon's,
 * syncs, and signs out, which brings the prompt back.
 *
 * Tokn is a fake on loopback (EAON_TOKN_HOST points at it). The harness records the approval page instead of opening a browser;
 * the scenario plays the browser by following Tokn's redirect itself.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeTokn } from './fakeTokn.mjs'
import { openSettings, scenario } from './fixtures.mjs'

scenario('Account: sign in with Tokn from Settings, open the profile, see Claude Code’s use, sync and sign out', { timeout: 120_000 }, async (s) => {
  const tokn = await startFakeTokn()
  try {
    // Two Work tasks counted today, so a sync has agents to send.
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    // And Claude Code used today in a terminal: its log, where Claude Code keeps it.
    const claudeDir = mkdtempSync(join(tmpdir(), 'eaon-e2e-claude-'))
    mkdirSync(join(claudeDir, 'projects', '-work-app'), { recursive: true })
    const response = (id) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        requestId: `req_${id}`,
        message: { id: `msg_${id}`, model: 'claude-opus-5', usage: { input_tokens: 2000, output_tokens: 4000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
      })
    writeFileSync(join(claudeDir, 'projects', '-work-app', 'session.jsonl'), [response('a'), response('b'), response('a')].join('\n') + '\n')
    const app = await s.launch({
      env: { EAON_TOKN_HOST: tokn.url, CLAUDE_CONFIG_DIR: claudeDir },
      seed: {
        'agent-runs.json': { version: 1, days: { [today]: { work: { runs: 2, totalMs: 300_000, longestMs: 200_000 } } } },
        'tokn-pricing.json': { fetchedAt: Date.now(), models: { 'claude-opus-5': { input: 5, output: 25 } } },
        'usage-ledger.json': { version: 1, days: { [today]: { anthropic: { 'claude-opus-5': { requests: 3, input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 } } } }, sources: {} }
      }
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
    await pick('View on Tokn')
    await page.waitFor(async () => (await window.api.usage.account()).sync.state === 'idle', { message: 'the first sync to finish' })
    const before = tokn.syncs.length
    await pick('Sync now')
    const urls = await app.openedUrls()
    assert.ok(urls.some((url) => url.endsWith('/profile/alex')), `opened: ${urls.join(', ')}`)

    // No Eaon profile or leaderboard: that site is gone.
    assert.equal(await page.eval(() => [...document.querySelectorAll('.settings__inner .row__title')].some((el) => /Eaon profile/.test(el.textContent ?? ''))), false)

    // Claude Code's log is in the daily chart and the calendar, its response counted once though the log repeats it.
    await page.find('.usage-chart__legend', { text: 'Claude Code' })
    await page.find('.usage-table[aria-label="Usage by tool"] .usage-table__row', { text: /Claude Code\s*2\b/ })
    const summary = await page.eval(() => window.api.usage.summary(7))
    assert.equal(summary.chart.at(-1).tools['claude-code'].requests, 2)
    assert.ok(summary.activity.activeDays >= 1, 'a day of Claude Code is an active day')
    // The calendar and streaks are the profile's, as toknhq.com shows them.
    await page.waitFor(async () => (await window.api.usage.summary(7)).activityFrom.source === 'tokn', { message: 'the profile to be read from Tokn' })
    assert.equal((await page.eval(() => window.api.usage.summary(7))).activity.allTime.requests, 9)
    await page.find('.usage-heat__foot', { text: 'Your Tokn profile' })
    assert.equal(summary.totals.requests, 3, 'Eaon’s own tiles stay Eaon’s')
    assert.equal(summary.chart.at(-1).requests, 5, 'the chart has both')
    await page.eval(() => document.querySelector('.usage-chart__legend')?.scrollIntoView({ block: 'center' }))
    await s.shot(page, 'daily-chart')
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
