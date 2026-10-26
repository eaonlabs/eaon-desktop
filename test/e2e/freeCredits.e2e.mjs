/**
 * Eaon Event: models from Eaon for an event, opened only by the event's code.
 * There is nothing to claim without one: a fresh install gets the star popup
 * after half a minute and no other card, and Settings → Model providers →
 * Eaon Event is just the box for a code. A code lists it, a reply goes through
 * it, the day's use shows in Settings, and a used-up day is refused before
 * sending.
 *
 * The gateway here is the fake model server standing in for it, accepting a
 * code of its own: the real one answers only builds that carry the app's
 * signing secret, which a test build doesn't.
 *
 * The Open GitHub button is never pressed here: it would star a real account.
 */
import assert from 'node:assert/strict'
import { openSettings, scenario, sendMessage, waitForReply } from './fixtures.mjs'
import { reply as answer } from './fakeProvider.mjs'

const CODE = 'EAON-TEST-EVNT-0001'

/** The fake model server as Eaon's gateway, with the event's code. */
async function eventGateway(s, limits = { requestsPerDay: 150, tokensPerDay: 2_000_000, requestsPerMinute: 20 }) {
  const fake = await s.fake()
  fake.setModels(['claude-haiku-5-5'])
  fake.addCode(CODE, { name: 'Eaon Hack e2e', endsAt: Date.now() + 2 * 86_400_000, limits })
  return { fake, env: { EAON_FREE_GATEWAY_URL: fake.url } }
}

const utcDay = () => new Date().toISOString().slice(0, 10)

async function openEventSettings(page) {
  await openSettings(page)
  await page.click('.settings__nav .nav-item', { text: /^Model providers$/ })
  await page.click('.provider-row', { text: /^Eaon Event/ })
}

scenario('Eaon Event: a fresh install gets the star popup and nothing after it, and Eaon Event is only a box for a code', { timeout: 150_000 }, async (s) => {
  // No GitHub token from this shell: "already starred" must not be read from a real account.
  const app = await s.launch({ env: { EAON_OFFERS: 'on', GH_TOKEN: '', GITHUB_TOKEN: '', ...(await eventGateway(s)).env } })
  const page = app.page
  const listed = async () => page.eval(async () => (await window.api.providers.list()).some((p) => p.id === 'eaon-free'))
  assert.equal(await listed(), false, 'no Eaon Event without a code')

  // No focus faked: the first ask counts time with the window on screen, focused or not.
  await page.find('.star-card', { text: /Welcome to Eaon/, timeout: 90_000 })
  const star = await page.eval(() => document.querySelector('.star-card')?.textContent ?? '')
  assert.ok(!/credit|free AI|Haiku/i.test(star), 'the star popup promises nothing')
  await page.click('.star-card button', { text: /^Later$/ })
  await page.waitFor(() => !document.querySelector('.star-card'), { message: 'the star popup to close' })
  await new Promise((resolve) => setTimeout(resolve, 3000))
  assert.equal(await page.eval(() => document.querySelectorAll('.star-card, .free-card').length), 0, 'no offer follows it')
  assert.equal(await page.eval(() => window.api.star.shouldAsk()), false, 'no second star popup this run')

  await openEventSettings(page)
  await page.find('.provider-detail__section-title', { text: /^Event code$/ })
  const text = await page.eval(() => document.querySelector('.providers-detail')?.textContent ?? '')
  assert.ok(!/Get free credits|free week|Free AI credits/i.test(text), 'nothing to claim')
  assert.match(text, /Eaon Lite/, 'it points to Eaon Lite for free models any time')
  await s.shot(page, 'event-without-code')

  // A wrong code: the gateway's own words, and nothing listed.
  await page.fill('.free-code input', 'EAON-AAAA-BBBB-CCCC')
  await page.click('.free-code button', { text: /^Redeem$/ })
  await page.find('.free-code .provider-status', { text: /That code isn't valid/ })
  assert.equal(await listed(), false)
})

scenario('Eaon Event: a code lists it, a reply goes through it, and Settings shows the day’s use', { timeout: 150_000 }, async (s) => {
  const { fake, env } = await eventGateway(s)
  fake.route(() => answer.text('event code works', { usage: { input: 40, output: 4 } }))
  // Chosen already, from an earlier code: the new one keeps it. (A profile from this version: the update from Eaon Free has run.)
  const app = await s.launch({ env, seed: { 'settings.json': { selectedProviderId: 'eaon-free', selectedModelId: 'claude-haiku-5-5' }, 'store-meta.json': { schema: 4 } } })
  const page = app.page

  await openEventSettings(page)
  await page.fill('.free-code input', CODE.toLowerCase())
  await page.click('.free-code button', { text: /^Redeem$/ })
  await page.find('.provider-detail__section-desc', { text: /The code “Eaon Hack e2e” gives this computer 150 requests and 2M tokens a day/ })
  await page.find('.free-usage__note', { text: /midnight UTC/ })
  assert.equal(await page.eval(() => document.querySelectorAll('.free-code').length), 0, 'no box once a code is in use')
  const status = await page.eval(() => window.api.freeCredits.status())
  assert.equal(status.code.name, 'Eaon Hack e2e')
  await s.shot(page, 'code-redeemed')

  await page.click('.settings__back')
  await page.waitFor(() => document.querySelector('.chip__model')?.textContent === 'Claude Haiku 5.5', { message: 'the composer on the event’s model' })
  await sendMessage(page, 'Reply with exactly these words and nothing else: event code works')
  const reply = await waitForReply(page, { text: /event code works/i, streaming: false, timeout: 90_000 })
  assert.equal(reply.error, '')
  const used = await page.eval(() => window.api.freeCredits.status())
  assert.ok(used.requests >= 1, `requests counted (${used.requests})`)
  assert.ok(used.tokens > 0, `tokens counted (${used.tokens})`)
  await s.shot(page, 'reply-through-code')
})

scenario('Eaon Event: a used-up day is refused with when it starts over, and nothing is sent', { timeout: 120_000 }, async (s) => {
  const { fake, env } = await eventGateway(s)
  const app = await s.launch({
    env,
    seed: {
      'settings.json': { selectedProviderId: 'eaon-free', selectedModelId: 'claude-haiku-5-5' },
      'free-credits.json': { day: utcDay(), requests: 150, tokens: 900_000, recent: [] },
      'store-meta.json': { schema: 4 }
    }
  })
  const page = app.page
  await openEventSettings(page)
  await page.fill('.free-code input', CODE)
  await page.click('.free-code button', { text: /^Redeem$/ })
  await page.find('.free-usage', { text: /150 of 150/ })
  await page.click('.settings__back')

  await page.waitFor(() => document.querySelector('.chip__model')?.textContent === 'Claude Haiku 5.5', { message: 'the composer on the event’s model' })
  const before = fake.chats.length
  await sendMessage(page, 'Hello')
  const refused = await waitForReply(page, { error: true, streaming: false, timeout: 30_000 })
  assert.match(refused.error, /used today's credits from the code "Eaon Hack e2e" \(150 requests a day\)/)
  assert.match(refused.error, /start over at/)
  assert.equal(fake.chats.length, before, 'nothing reached the gateway')
  assert.equal((await page.eval(() => window.api.freeCredits.status())).requests, 150, 'the refused message took nothing')
  await s.shot(page, 'day-used-up')
})

scenario('Eaon Event: updating from Eaon Free’s week moves its choice back to Eaon Lite', { timeout: 90_000 }, async (s) => {
  const app = await s.launch({
    seed: {
      'settings.json': {
        freeCredits: { claimed: true, claimedAt: Date.now() - 86_400_000, offered: 1, lastOfferedAt: Date.now() - 86_400_000 },
        selectedProviderId: 'eaon-free',
        selectedModelId: 'claude-haiku-5-5'
      },
      'store-meta.json': { schema: 3 }
    }
  })
  const page = app.page
  const settings = await page.eval(() => window.api.settings.get())
  assert.deepEqual([settings.selectedProviderId, settings.selectedModelId], [null, null], 'back to the default')
  assert.equal(await page.eval(async () => (await window.api.providers.list()).some((p) => p.id === 'eaon-free')), false)
  assert.equal(await page.eval(() => Boolean(document.querySelector('.model-notice'))), false, 'no "unavailable" notice')
})
