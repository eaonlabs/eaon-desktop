/**
 * Eaon Free: on a fresh install, after half a minute of use, the star popup
 * comes up first and the free-credits offer follows it whatever the answer
 * (here "Later"). The offer asks for nothing; claimed, it lasts a week, the
 * free model is selected, answers a message, and Settings shows the day's
 * use. A used-up day, and a finished week, are refused before sending.
 *
 * Eaon offers the week only while its gateway serves the free model, so the
 * gateway here is the fake model server standing in for it: the real one
 * answers only builds that carry the app's signing secret, which a test
 * build doesn't.
 *
 * The Open GitHub button is never pressed here: it would star a real account.
 */
import assert from 'node:assert/strict'
import { openSettings, scenario, sendMessage, waitForReply } from './fixtures.mjs'
import { reply as answer } from './fakeProvider.mjs'

/** The environment for a gateway that serves Eaon Free's model: the scenario's fake model server. */
async function servedGateway(s) {
  const fake = await s.fake()
  fake.setModels(['claude-haiku-5-5'])
  return { EAON_FREE_GATEWAY_URL: fake.url }
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const WEEK_MS = 7 * 24 * 3_600_000

scenario('Eaon Free: a fresh install gets the star popup, then the offer; claiming needs no star; a live reply', { timeout: 240_000 }, async (s) => {
  // No GitHub token from this shell: "already starred" must not be read from a real account.
  const app = await s.launch({ env: { EAON_OFFERS: 'on', GH_TOKEN: '', GITHUB_TOKEN: '', ...(await servedGateway(s)) } })
  ;(await s.fake()).route(() => answer.text('free credits work', { usage: { input: 40, output: 4 } }))
  const page = app.page
  const listed = async () => page.eval(async () => (await window.api.providers.list()).some((p) => p.id === 'eaon-free'))
  assert.equal(await listed(), false, 'not offered as a provider before it is claimed')

  // No focus faked: the cards count time with the window on screen, focused or not.
  await page.find('.star-card', { text: /Welcome to Eaon/, timeout: 90_000 })
  const star = await page.eval(() => document.querySelector('.star-card')?.textContent ?? '')
  assert.match(star, /star it on GitHub/)
  assert.ok(!/credit|free AI|Haiku/i.test(star), 'the star popup promises nothing')
  assert.equal(await page.eval(() => Boolean(document.querySelector('.free-card'))), false, 'one card at a time')
  await s.shot(page, 'star-first')

  await page.click('.star-card button', { text: /^Later$/ })
  await page.find('.free-card', { text: /Free AI credits/ })
  const offer = await page.eval(() => document.querySelector('.free-card')?.textContent ?? '')
  assert.match(offer, /free for 7 days/)
  assert.match(offer, /150 requests and 2M tokens a day/)
  assert.ok(!/\bstars?\b|github/i.test(offer), 'the offer asks for nothing in return')
  await s.shot(page, 'offer')

  await page.click('.free-card button', { text: /Get free credits/ })
  await page.find('.free-card', { text: /Your free week has started/ })
  const started = await page.eval(() => document.querySelector('.free-card')?.textContent ?? '')
  assert.match(started, /in your model picker until \w+ \d+/)
  await s.shot(page, 'claimed')
  await page.click('.free-card button', { text: /^Done$/ })
  await page.waitFor(() => !document.querySelector('.free-card'), { message: 'the card to close' })

  assert.equal(await listed(), true)
  const settings = await page.eval(() => window.api.settings.get())
  assert.equal(settings.freeCredits.claimed, true)
  assert.ok(Math.abs(settings.freeCredits.claimedAt - Date.now()) < 120_000, `the week starts now (${settings.freeCredits.claimedAt})`)
  assert.equal(settings.starPrompt.status, 'pending', 'nothing was starred')
  assert.equal(settings.starPrompt.asked, 1, 'the star popup counts as asked')
  assert.equal(typeof settings.starPrompt.lastAskedAt, 'number', 'and waits a week before asking again')
  assert.equal(await page.eval(() => window.api.star.shouldAsk()), false, 'no second star popup this run')
  assert.deepEqual([settings.selectedProviderId, settings.selectedModelId], ['eaon-free', 'claude-haiku-5-5'], 'a fresh install starts on the free model')

  // A reply through the gateway (its stand-in).
  await page.waitFor(() => document.querySelector('.chip__model')?.textContent === 'Claude Haiku 5.5', { message: 'the composer to show the free model' })
  await sendMessage(page, 'Reply with exactly these words and nothing else: free credits work')
  const reply = await waitForReply(page, { text: /free credits work/i, streaming: false, timeout: 90_000 })
  assert.equal(reply.error, '')
  await s.shot(page, 'live-reply')
  const used = await page.eval(() => window.api.freeCredits.status())
  assert.ok(used.requests >= 1, `requests counted (${used.requests})`)
  assert.ok(used.tokens > 0, `tokens counted (${used.tokens})`)

  await openSettings(page)
  await page.click('.settings__nav .nav-item', { text: /^Model providers$/ })
  await page.click('.provider-row', { text: /^Eaon Free/ })
  await page.find('.free-usage', { text: /of 150/ })
  const usage = await page.eval(() => document.querySelector('.free-usage')?.textContent ?? '')
  assert.match(usage, /Starts over at midnight/)
  await page.find('.provider-detail__section-desc', { text: /requests a minute, until \w+ \d+\./ })
  assert.equal(await page.eval(() => document.querySelectorAll('.key-field').length), 0, 'no key to enter')
  await s.shot(page, 'settings-usage')
})

scenario('Eaon Free: a used-up day is refused with when it starts over, and nothing is sent', { timeout: 90_000 }, async (s) => {
  const app = await s.launch({
    seed: {
      'settings.json': {
        freeCredits: { claimed: true, claimedAt: Date.now(), offered: 1, lastOfferedAt: Date.now() },
        selectedProviderId: 'eaon-free',
        selectedModelId: 'claude-haiku-5-5'
      },
      'free-credits.json': { day: today(), requests: 150, tokens: 900_000, recent: [] }
    }
  })
  const page = app.page
  await page.waitFor(() => document.querySelector('.chip__model')?.textContent === 'Claude Haiku 5.5', { message: 'the composer to show the free model' })
  await sendMessage(page, 'Hello')
  const refused = await waitForReply(page, { error: true, streaming: false, timeout: 30_000 })
  assert.match(refused.error, /used today's free Eaon credits \(150 requests a day\)/)
  assert.match(refused.error, /midnight/)
  const after = await page.eval(() => window.api.freeCredits.status())
  assert.equal(after.requests, 150, 'the refused message took nothing')
  await s.shot(page, 'day-used-up')

  // No offer for someone who has it already.
  assert.equal(await page.eval(() => window.api.freeCredits.shouldOffer().then((p) => p.offer)), false)
})

scenario('Eaon Free: after its week a message is refused, nothing is sent, and Settings says it ended', { timeout: 90_000 }, async (s) => {
  const claimedAt = Date.now() - WEEK_MS - 3_600_000
  const app = await s.launch({
    seed: {
      'settings.json': { freeCredits: { claimed: true, claimedAt, offered: 1, lastOfferedAt: claimedAt }, selectedProviderId: 'eaon-free', selectedModelId: 'claude-haiku-5-5' },
      'free-credits.json': { day: today(), requests: 2, tokens: 9_000, recent: [] }
    }
  })
  const page = app.page
  await page.waitFor(() => document.querySelector('.chip__model')?.textContent === 'Claude Haiku 5.5', { message: 'the composer to show the free model' })
  await sendMessage(page, 'Hello')
  const refused = await waitForReply(page, { error: true, streaming: false, timeout: 30_000 })
  assert.match(refused.error, /Your free week of Eaon credits ended on \w+ \d+\. Pick another model/)
  const after = await page.eval(() => window.api.freeCredits.status())
  assert.equal(after.ended, true)
  assert.equal(after.requests, 2, 'the refused message took nothing')
  await s.shot(page, 'week-over')

  await openSettings(page)
  await page.click('.settings__nav .nav-item', { text: /^Model providers$/ })
  await page.click('.provider-row', { text: /^Eaon Free/ })
  await page.find('.provider-detail__section-desc', { text: /Your free week ended on \w+ \d+\./ })
  assert.equal(await page.eval(() => document.querySelectorAll('.free-usage').length), 0, 'no meters for a week that is over')
  assert.equal(await page.eval(() => window.api.freeCredits.shouldOffer().then((p) => p.offer)), false, 'and it is not offered again')
  await s.shot(page, 'week-over-settings')
})

scenario('Eaon Free: claimed from Settings before the cards come up, the star popup still shows once, and no offer follows', { timeout: 120_000 }, async (s) => {
  const app = await s.launch({ env: { EAON_OFFERS: 'on', GH_TOKEN: '', GITHUB_TOKEN: '', ...(await servedGateway(s)) } })
  const page = app.page
  await openSettings(page)
  await page.click('.settings__nav .nav-item', { text: /^Model providers$/ })
  await page.click('.provider-row', { text: /^Eaon Free/ })
  await page.click('button', { text: /^Get free credits$/ })
  await page.waitFor(async () => (await window.api.settings.get()).freeCredits.claimed, { message: 'the credits to be claimed' })

  await page.find('.star-card', { text: /Welcome to Eaon/, timeout: 90_000 })
  await s.shot(page, 'star-after-settings-claim')
  await page.click('.star-card button', { text: /^Later$/ })
  await page.waitFor(() => !document.querySelector('.star-card'), { message: 'the star card to close' })
  await new Promise((r) => setTimeout(r, 2_500))
  assert.equal(await page.eval(() => Boolean(document.querySelector('.free-card'))), false, 'no offer for credits already claimed')
  const settings = await page.eval(() => window.api.settings.get())
  assert.equal(settings.starPrompt.asked, 1)
  assert.equal(settings.freeCredits.offered, 0)
})

scenario('Eaon Free: while the gateway doesn’t serve its model, Settings doesn’t start the week', { timeout: 60_000 }, async (s) => {
  const fake = await s.fake()
  fake.setModels(['some-other-model'])
  const app = await s.launch({ env: { EAON_FREE_GATEWAY_URL: fake.url } })
  const page = app.page
  await openSettings(page)
  await page.click('.settings__nav .nav-item', { text: /^Model providers$/ })
  await page.click('.provider-row', { text: /^Eaon Free/ })
  await page.find('.provider-credits', { text: /isn’t available right now/ })
  assert.equal(await page.eval(() => [...document.querySelectorAll('.provider-credits button')].some((b) => /Get free credits/.test(b.textContent ?? ''))), false, 'no button to claim it')
  // Asked directly, the claim is refused too, and nothing changes.
  assert.equal((await page.eval(() => window.api.freeCredits.claim())).claimed, false)
  assert.equal((await page.eval(() => window.api.settings.get())).freeCredits.claimed, false)
  await s.shot(page, 'not-served')
})

scenario('Eaon Free: the offer card’s “Have an event code?” opens the code box in the card, claiming nothing', { timeout: 150_000 }, async (s) => {
  const app = await s.launch({ env: { EAON_OFFERS: 'on', GH_TOKEN: '', GITHUB_TOKEN: '', ...(await servedGateway(s)) } })
  const page = app.page
  await page.find('.star-card', { text: /Welcome to Eaon/, timeout: 90_000 })
  await page.click('.star-card button', { text: /^Later$/ })
  await page.find('.free-card', { text: /Free AI credits/ })
  await page.click('.free-card__code', { text: /Have an event code\?/ })

  // At an event the code is the way in, so it opens right there, with nothing else to find.
  await page.find('.free-card .free-code__title', { text: /Have an event code\?/ })
  assert.ok(await page.eval(() => Boolean(document.querySelector('.free-card .free-code input[aria-label="Event code"]'))), 'the card has the code box')
  assert.equal((await page.eval(() => window.api.settings.get())).freeCredits.claimed, false, 'nothing claimed on the way')
  await s.shot(page, 'code-box')
})
