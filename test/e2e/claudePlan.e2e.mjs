/**
 * Claude in Eaon follows Anthropic's rules for apps: Settings → Model
 * providers → Anthropic offers no Claude sign-in, explains why, shows how a
 * Max or Team plan's monthly API credits reach Eaon through an API key, and
 * refuses a Claude login token pasted as a key. Nothing is saved or sent.
 */
import assert from 'node:assert/strict'
import { openSettings, scenario } from './fixtures.mjs'

scenario('Anthropic in Settings: no Claude sign-in, the plan’s API credits explained, a login token refused', { timeout: 90_000 }, async (s) => {
  const app = await s.launch()
  const page = app.page
  await openSettings(page)
  await page.click('.settings__nav .nav-item', { text: /^Model providers$/ })
  await page.click('.provider-row', { text: /^Anthropic/ })
  const credits = await page.find('.provider-credits', { text: /monthly API credits/ })
  assert.ok(credits)
  const text = await page.eval(() => document.body.textContent ?? '')
  assert.match(text, /doesn’t allow other apps to sign in with a Claude account/)
  assert.match(text, /Link organization/)
  assert.ok(!/Sign in with Claude/i.test(text), 'no Claude sign-in offered')
  await s.shot(page, 'anthropic-plan-credits')

  await page.fill('.key-field input', 'sk-ant-oat01-thisIsALoginTokenNotAnApiKey0000')
  await page.click('button', { text: /^Save$/ })
  await page.find('.provider-status[data-tone="error"]', { text: /Claude subscription login token/ })
  const stored = await page.eval(async () => (await window.api.providers.list()).find((p) => p.id === 'anthropic')?.hasKey)
  assert.equal(stored, false, 'nothing was saved')
  // The main process refuses it too, whatever sends it.
  const direct = await page.eval(() => window.api.keys.set('anthropic', 'sk-ant-oat01-thisIsALoginTokenNotAnApiKey0000').then(() => 'saved', (e) => String(e.message)))
  assert.match(direct, /Claude subscription login token/)
  await s.shot(page, 'login-token-refused')
})
