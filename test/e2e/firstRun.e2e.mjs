/**
 * A fresh install with no model anywhere: no keys, and every local runtime
 * unreachable (the harness points them at a closed port).
 *
 * The composer's "no usable model" state is being redesigned (2026.6.2,
 * models stream), so this checks what must hold whatever it looks like: the
 * user is told how to get a model, and a message can't start a reply that
 * would never come. What it shows exactly is recorded in the test output.
 */
import assert from 'node:assert/strict'
import { checkIsolated, scenario } from './fixtures.mjs'

/** Wording that points somewhere useful: a model, a provider, a key, Settings. */
const SETUP_HINT = /model|provider|api key|settings|download|sign in|connect/i

scenario('fresh install with no model: a setup hint, and no reply that can never come', { timeout: 90_000 }, async (s) => {
  const app = await s.launch()
  await checkIsolated(app)
  const page = app.page
  await page.find('.composer__input')
  const providers = await page.eval(async () => (await window.api.providers.list()).filter((p) => p.models.length > 0 && (p.local ? true : p.hasKey)).map((p) => p.id))
  assert.deepEqual(providers, [], 'a fresh profile should have no usable provider')

  const home = await page.eval(() => ({
    composer: document.querySelector('.composer-stack')?.textContent?.trim() ?? '',
    main: (document.querySelector('.main') ?? document.body).textContent?.trim().slice(0, 600) ?? ''
  }))
  s.t.diagnostic(`composer with no model: ${JSON.stringify(home.composer)}`)
  assert.match(home.composer + home.main, SETUP_HINT, 'nothing on the home screen says a model is needed')
  await s.shot(page, 'no-model-home')

  // Try to send anyway.
  await page.click('.composer__input')
  await page.type('Hello, is anyone there?')
  const sendDisabled = await page.eval(() => Boolean(document.querySelector('.send')?.disabled))
  s.t.diagnostic(`Send with text and no model is ${sendDisabled ? 'disabled' : 'enabled'}`)
  await page.press('Enter')

  // Whatever happens, it settles: either nothing was sent, or the reply says
  // what to do. Never a reply left thinking forever.
  const outcome = await page.waitFor(
    () => {
      const rows = [...document.querySelectorAll('.msg-row')].filter((row) => !row.matches('.msg-user-block'))
      const row = rows.at(-1)
      if (row?.querySelector('[data-streaming], .loading-state')) return null
      const visible = (document.querySelector('.main') ?? document.body).textContent ?? ''
      return { sent: Boolean(row), reply: row?.textContent?.trim() ?? '', visible: visible.trim().slice(0, 800) }
    },
    { timeout: 10_000, message: 'sending without a model to settle' }
  )
  s.t.diagnostic(`after Enter with no model: ${outcome.sent ? `reply ${JSON.stringify(outcome.reply)}` : 'nothing was sent'}`)
  await s.shot(page, 'no-model-after-send')
  if (outcome.sent) assert.match(outcome.reply, SETUP_HINT, `the reply doesn't say how to get a model: ${outcome.reply}`)
  else assert.match(outcome.visible, SETUP_HINT, 'nothing was sent and nothing says why')
  assert.equal(await page.eval(() => document.querySelectorAll('[aria-label="Stop"]').length), 0, 'a Stop button for a reply that never started')
})
