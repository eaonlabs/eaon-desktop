/**
 * Eaon Event with an event code (a hackathon's), against a local copy of the
 * gateway (`npm run dev:cf:gateway` in the gateway's repo, with a fake
 * upstream), never the real one:
 *
 *   EAON_E2E_GATEWAY=http://127.0.0.1:18902 EAON_E2E_GATEWAY_PASSWORD=… npm run test:e2e -- freeCode
 *
 * The code is made on that gateway's admin API, redeemed in Settings →
 * Model providers → Eaon Event, and a message then goes through it, counted
 * by the gateway against this device.
 */
import assert from 'node:assert/strict'
import { openSettings, scenario, sendMessage, waitForReply } from './fixtures.mjs'

const gateway = process.env.EAON_E2E_GATEWAY
const password = process.env.EAON_E2E_GATEWAY_PASSWORD

async function adminSession() {
  const login = await fetch(`${gateway}/_admin/login`, { method: 'POST', headers: { origin: gateway, 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
  assert.equal(login.status, 200, 'signed in to the local gateway')
  const cookie = login.headers.get('set-cookie').split(';')[0]
  return async (path, method = 'GET', body) => {
    const r = await fetch(`${gateway}${path}`, { method, headers: { origin: gateway, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return r.json()
  }
}

scenario(
  'Eaon Event code: redeemed in Settings, a reply through it, counted per device',
  { timeout: 120_000, skip: gateway && password ? false : 'needs a local gateway: set EAON_E2E_GATEWAY and EAON_E2E_GATEWAY_PASSWORD' },
  async (s) => {
    const admin = await adminSession()
    const made = await admin('/_admin/codes', 'POST', { name: 'Eaon Hack e2e', endsAt: Date.now() + 2 * 86_400_000, requestsPerDay: 150, tokensPerDay: 2_000_000, requestsPerMinute: 20 })
    const code = made.code.token
    assert.match(code, /^EAON-/)

    const app = await s.launch({
      env: { EAON_FREE_GATEWAY_URL: `${gateway}/v1` },
      seed: { 'settings.json': { selectedProviderId: 'eaon-free', selectedModelId: 'claude-haiku-5-5' }, 'store-meta.json': { schema: 4 } }
    })
    const page = app.page
    await openSettings(page)
    await page.click('.settings__nav .nav-item', { text: /^Model providers$/ })
    await page.click('.provider-row', { text: /^Eaon Event/ })
    await page.find('.provider-detail__section-title', { text: /^Event code$/ })

    // A wrong code first: the gateway's own words.
    await page.fill('.free-code input', 'EAON-AAAA-BBBB-CCCC')
    await page.click('.free-code button', { text: /^Redeem$/ })
    await page.find('.free-code .provider-status', { text: /That code isn't valid/ })
    await s.shot(page, 'wrong-code')

    await page.fill('.free-code input', code.toLowerCase())
    await page.click('.free-code button', { text: /^Redeem$/ })
    await page.find('.provider-detail__section-desc', { text: /The code “Eaon Hack e2e” gives this computer 150 requests and 2M tokens a day/ })
    assert.equal(await page.eval(() => document.querySelectorAll('.free-code').length), 0, 'no box once a code is in use')
    await page.find('.free-usage__note', { text: /midnight UTC/ })
    await s.shot(page, 'code-redeemed')

    const status = await page.eval(() => window.api.freeCredits.status())
    assert.equal(status.code.name, 'Eaon Hack e2e')

    await page.click('.settings__back')
    await page.waitFor(() => document.querySelector('.chip__model')?.textContent === 'Claude Haiku 5.5', { message: 'the composer on the event’s model' })
    await sendMessage(page, 'Hello from the hackathon')
    const reply = await waitForReply(page, { streaming: false, timeout: 60_000 })
    assert.equal(reply.error, '', 'the code got the message through')
    await s.shot(page, 'reply-through-code')

    const listed = (await admin('/_admin/codes')).codes.find((c) => c.name === 'Eaon Hack e2e')
    assert.ok(listed.today.requests >= 1, `the gateway counted it (${listed.today.requests})`)
    assert.equal(listed.today.devices, 1, 'against one device')
    await admin(`/_admin/codes/${listed.id}`, 'DELETE')
  }
)
