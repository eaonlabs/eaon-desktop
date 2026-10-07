/**
 * Chat on Codex: Codex's models in Chat's model picker, a reply from Codex,
 * the same Codex conversation carried on by the next message, a command it
 * wants to run asked in Chat's own approval dialog, and — signed out — the
 * sign-in offered right above the composer. Against the fake Codex
 * (test/fixtures/fake-codex.mjs), found through EAON_CODEX_BIN.
 * Reported in 2026.6.2 Beta 2: "codex provider not available".
 */
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettings, scenario, sendMessage, waitForReply } from './fixtures.mjs'

const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url))

/** The fake Codex as an executable beside the scenario's home (which launch empties), and its state folder. */
function fakeCodex(s, account) {
  const base = join(dirname(s.homeDir), 'codex')
  const bin = join(base, 'bin', 'codex')
  mkdirSync(dirname(bin), { recursive: true })
  copyFileSync(FAKE_CODEX, bin)
  chmodSync(bin, 0o755)
  const state = join(base, 'state')
  mkdirSync(state, { recursive: true })
  return { EAON_CODEX_BIN: bin, FAKE_CODEX_STATE: state, FAKE_CODEX_ACCOUNT: account }
}

/** @param {import('./harness.mjs').Page} page */
async function codexState(page) {
  return page.waitFor(
    async () => {
      const codex = (await window.api.engines.refresh()).find((e) => e.id === 'codex')
      return codex && codex.installed ? codex.auth.state : null
    },
    { message: 'Eaon to find the Codex engine', timeout: 30_000 }
  )
}

scenario('Chat runs on Codex: picked in the model picker, a reply, the same conversation next time, its commands asked in Chat', { timeout: 180_000 }, async (s) => {
  const app = await s.launch({ env: fakeCodex(s, 'chatgpt:plus') })
  const page = app.page
  assert.equal(await codexState(page), 'signed-in')

  // With nothing else connected, the first-run notice offers Codex for Chat.
  await page.find('.model-notice .model-notice__link', { text: /Use Codex in Chat/ })

  // Codex's own tab in the model picker, with its logo.
  await page.click('.chip--model')
  assert.ok(await page.eval(() => Boolean(document.querySelector('.mp__tab[aria-label="Codex"] img'))), 'the Codex tab shows its logo')
  await page.click('.mp__tab[aria-label="Codex"]')
  const rows = await page.waitFor(() => {
    const r = [...document.querySelectorAll('.mp__list .mp__row')].map((row) => row.querySelector('.mp__row-name')?.textContent ?? '')
    return r.length ? r : null
  }, { message: 'Codex’s models' })
  s.t.diagnostic(`Codex tab: ${JSON.stringify(rows)}`)
  await s.shot(page, 'picker-codex-tab')
  await page.click('.mp__list .mp__row', { text: rows[0] })
  await page.waitFor((want) => document.querySelector('.chip--model .chip__model')?.textContent === want, {
    args: [`Codex · ${rows[0]}`],
    message: 'the chip to show the Codex model by name'
  })
  assert.equal((await page.eval(async () => (await window.api.settings.get()).selectedEngine)), 'codex')

  // A reply from Codex, then the same Codex conversation carried on.
  await sendMessage(page, 'hi there')
  await waitForReply(page, { text: 'Hello there.', streaming: false, timeout: 30_000 })
  await sendMessage(page, 'what is in our history')
  await waitForReply(page, { text: /I remember 1 earlier message/, streaming: false, timeout: 30_000 })
  await s.shot(page, 'codex-replies')

  // A command Codex wants to run is asked in Chat's own approval dialog.
  await sendMessage(page, 'run the tests')
  await page.find('.approval-layer[data-state="in"] .approval', { timeout: 30_000 })
  await s.shot(page, 'codex-approval')
  await page.click('.approval-layer[data-state="in"] .approval__approve')
  await waitForReply(page, { text: /Hello there\./, streaming: false, timeout: 30_000 })
  const ran = await page.eval(() => [...document.querySelectorAll('.msg-row')].at(-1)?.textContent ?? '')
  assert.match(ran, /npm test|3 passed|tests/i, 'the command it ran shows in the reply')
  assert.deepEqual(app.pageErrors().filter((e) => /exception/i.test(e)), [])

  // Signed out (another computer, or the sign-in ended): the composer says so and signs in right there.
  await app.quit()
  const again = await s.relaunch(app, { fresh: false, env: { ...fakeCodex(s, 'none'), FAKE_CODEX_LOGIN: 'success' } })
  const page2 = again.page
  assert.equal(await codexState(page2), 'signed-out')

  // Settings → Model providers: Codex has its logo (it showed the letters "Co").
  await openSettings(page2)
  await page2.click('.settings__nav .nav-item', { text: /^Model providers$/ })
  const row = await page2.waitFor(
    () => {
      const r = [...document.querySelectorAll('.provider-row')].find((el) => el.getAttribute('title')?.startsWith('Codex'))
      return r ? { logo: Boolean(r.querySelector('img')), text: r.textContent?.trim() } : null
    },
    { message: 'the Codex row in Model providers' }
  )
  assert.ok(row.logo, `the Codex row shows its logo: ${JSON.stringify(row)}`)
  await s.shot(page2, 'providers-codex-row')
  await page2.click('.settings__back')

  // A worker can run on Codex too: the editor offers it, and signs in right there.
  await page2.click('.mode-switch__option', { text: 'Workers' })
  await page2.click('[aria-label="New worker"]')
  await page2.click('.worker-editor .select', { text: /Eaon \(any provider\)/ })
  await page2.click('[role="menuitem"]', { text: /^Codex/ })
  await page2.find('.worker-editor__engine-note', { text: /isn't signed in/ })
  await page2.find('.worker-editor__engine-note .btn', { text: /Sign in to Codex/ })
  await s.shot(page2, 'worker-editor-codex')
  await page2.click('.modal button', { text: /^Cancel$/ })
  await page2.click('.mode-switch__option', { text: 'Chat' })

  await page2.find('.model-notice', { text: /Sign in to Codex/ })
  await s.shot(page2, 'codex-signed-out')
  await page2.click('.model-notice .btn', { text: /Sign in to Codex/ })
  await page2.waitFor(() => !document.querySelector('.model-notice'), { message: 'the notice to go once signed in', timeout: 30_000 })
})
