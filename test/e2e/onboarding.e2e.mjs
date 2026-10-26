/**
 * The first run: the setup (welcome, Tokn, a model, light or dark, done),
 * then the tour; and both skipped. The harness turns them off for every
 * other scenario (EAON_ONBOARDING=off); these turn them on.
 *
 * Signing in links the tokn command that ships with Eaon to the same Tokn
 * account, with a link code from the fake Tokn, and puts a `tokn` launcher in
 * the scenario's own bin folder (EAON_TOKN_BIN_DIR). Builds without the
 * bundled tokn (resources/tokn-cli, fetched by scripts/fetch-tokn-cli.mjs)
 * check the rest and say so.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { approveToknSignIn, startFakeTokn } from './fakeTokn.mjs'
import { repo } from './harness.mjs'
import { openSettings, scenario } from './fixtures.mjs'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const bundled = existsSync(join(repo, 'resources', 'tokn-cli', 'dist', 'index.js'))

/** @param {import('./harness.mjs').Page} page */
const onboarding = (page) => page.eval(async () => (await window.api.settings.get()).onboarding)

scenario('first run: the setup signs in with Tokn, links tokn, picks dark, and the tour shows the app', { timeout: 150_000 }, async (s) => {
  const tokn = await startFakeTokn()
  const bin = join(s.homeDir, 'bin')
  try {
    const app = await s.launch({
      env: { EAON_ONBOARDING: 'on', EAON_TOKN_CLI: 'on', EAON_TOKN_HOST: tokn.url, EAON_TOKN_BIN_DIR: bin }
    })
    const page = app.page

    // Welcome.
    await page.find('.onboarding .onboarding__title', { text: 'Welcome to Eaon' })
    await page.waitFor(() => !document.querySelector('.onboarding__step [style*="--i"]')?.getAnimations().some((a) => a.playState === 'running'), {
      message: 'the welcome to settle'
    })
    await s.shot(page, 'setup-welcome')
    await page.click('.onboarding .btn--primary', { text: 'Get started' })

    // Tokn: sign in, with the coding CLIs tracked too (the switch starts on).
    await page.find('.onboarding__title', { text: 'Track your usage with Tokn' })
    await sleep(900)
    await s.shot(page, 'setup-tokn')
    // Nothing in the setup scrolls sideways, whatever has focus.
    assert.deepEqual(await page.eval(() => [...document.querySelectorAll('.onboarding, .onboarding *')].filter((el) => el.scrollLeft > 0).map((el) => el.className)), [])
    assert.equal(await page.eval(() => document.querySelector('.onboarding__option .switch')?.getAttribute('aria-checked')), 'true')
    await page.click('.onboarding .btn--primary', { text: 'Sign in with Tokn' })
    await page.find('.onboarding .btn', { text: 'Waiting for your browser' })
    await approveToknSignIn(page)
    await page.find('.onboarding__account', { text: '@alex', timeout: 15_000 })
    await page.waitFor(() => !document.querySelector('.onboarding__account')?.getAnimations().some((a) => a.playState === 'running'), {
      message: 'the account to open in'
    })
    await s.shot(page, 'setup-tokn-signed-in')
    await page.click('.onboarding .btn--primary', { text: 'Continue' })

    if (bundled) {
      // tokn is on "PATH" (the scenario's bin) and linked to @alex with a token of its own.
      await page.waitFor(async () => (await window.api.toknCli.status()).linked?.handle === 'alex', { message: 'tokn to be linked', timeout: 60_000 })
      const config = JSON.parse(readFileSync(join(s.homeDir, '.tokn', 'config.json'), 'utf8'))
      assert.equal(config.token, 'tok_cli_e2e', 'tokn has its own token, not Eaon’s')
      assert.equal(config.user.handle, 'alex')
      assert.ok(tokn.requests.includes('POST /api/cli/link-code') && tokn.requests.includes('POST /api/cli/link'), tokn.requests.join(', '))
      const launcher = join(bin, process.platform === 'win32' ? 'tokn.cmd' : 'tokn')
      assert.match(readFileSync(launcher, 'utf8'), /Installed by Eaon Desktop/)
      if (process.platform !== 'win32') assert.equal(execFileSync(launcher, ['--version'], { encoding: 'utf8', env: { ...process.env, HOME: s.homeDir } }).trim(), '0.1.3')
    } else {
      s.t.diagnostic('resources/tokn-cli is missing (run scripts/fetch-tokn-cli.mjs): the tokn command wasn’t checked')
    }

    // A model: skipped here (the fake profile has none).
    await page.find('.onboarding__title', { text: 'Connect a model' })
    await sleep(700)
    await s.shot(page, 'setup-models')
    await page.click('.onboarding .btn--ghost', { text: 'Not now' })

    // Dark, at once.
    await page.find('.onboarding__title', { text: 'Light or dark?' })
    await page.click('.onboarding__theme', { text: 'Dark' })
    await page.waitFor(() => document.documentElement.dataset.theme === 'dark', { message: 'the dark theme' })
    await sleep(700)
    await s.shot(page, 'setup-look')
    await page.click('.onboarding .btn--primary', { text: 'Continue' })

    await page.find('.onboarding__title', { text: 'You’re all set' })
    await sleep(700)
    await s.shot(page, 'setup-ready')
    await page.click('.onboarding .btn--primary', { text: 'Show me around' })

    // The tour: eight stops across the three tabs, then back to Chat.
    await page.waitFor(() => !document.querySelector('.onboarding'), { message: 'the setup to close' })
    const titles = []
    for (let stop = 1; stop <= 8; stop++) {
      // textContent: the count is drawn in capitals ("1 OF 7").
      await page.waitFor((stop) => document.querySelector('.tour__count')?.textContent === `${stop} of 8`, { args: [stop], message: `stop ${stop}` })
      // Placed for this stop and done gliding there (the tab it's in may take a moment to draw what it points at).
      await page.waitFor(() => {
        const card = document.querySelector('.tour__card[data-settled]')
        return card ? card.getAnimations().every((a) => a.playState !== 'running') : false
      }, { message: 'the card to settle' })
      titles.push(await page.eval(() => document.querySelector('.tour__title')?.textContent ?? ''))
      // The plan meter can be turned off in Settings; then its card sits in the middle.
      const spot = await page.eval(() => Boolean(document.querySelector('.tour__spot')))
      if (titles.at(-1) !== 'Your plan’s limits') assert.ok(spot, `stop ${stop} (${titles.at(-1)}) points at something`)
      if (stop === 1 || stop >= 5) await s.shot(page, `tour-${stop}`)
      await page.click('.tour__card .btn--primary')
    }
    assert.deepEqual(titles, ['Three places to work', 'Ask, or hand over a task', 'Pick a model', 'Your chats', 'Automations', 'The ADE', 'Your plan’s limits', 'Settings'])
    await page.waitFor(() => !document.querySelector('.tour'), { message: 'the tour to close' })
    // A fresh install starts on this release, so its what's new never shows on top of the tour.
    assert.deepEqual({ ...(await onboarding(page)), finishedAt: null }, { setup: 'done', tour: 'done', finishedAt: null, whatsNew: '2026.7' })
    assert.equal(await page.eval(() => document.querySelector('.mode-switch__option[aria-selected="true"]')?.textContent?.trim()), 'Chat')

    // Not again on the next launch.
    await app.quit()
    const again = await s.relaunch(app)
    await again.page.find('.composer')
    await sleep(800)
    assert.equal(await again.page.eval(() => Boolean(document.querySelector('.onboarding'))), false)
  } finally {
    await tokn.close()
  }
})

scenario('first run: skipping the setup, and the tour from Settings', { timeout: 90_000 }, async (s) => {
  const app = await s.launch({ env: { EAON_ONBOARDING: 'on' } })
  const page = app.page
  await page.find('.onboarding__title', { text: 'Welcome to Eaon' })
  await page.click('.onboarding__skip', { text: 'Skip setup' })
  await page.waitFor(() => !document.querySelector('.onboarding'), { message: 'the setup to close' })
  assert.equal((await onboarding(page)).setup, 'skipped')
  assert.equal(await page.eval(() => Boolean(document.querySelector('.tour'))), false, 'skipping the setup skips the tour')

  await openSettings(page, 'General')
  await page.click('.settings button', { text: /^Take the tour$/ })
  await page.find('.tour__title', { text: 'Three places to work' })
  await page.press('ArrowRight')
  await page.find('.tour__title', { text: 'Ask, or hand over a task' })
  await page.press('Escape')
  await page.waitFor(() => !document.querySelector('.tour'), { message: 'Escape to end the tour' })
  assert.equal((await onboarding(page)).tour, 'skipped')
})

/** The what's-new tour's titles, stop by stop, pressing Next on each. */
async function walkWhatsNew(s, page, shots) {
  const titles = []
  for (let stop = 1; stop <= 10; stop++) {
    await page.waitFor((stop) => document.querySelector('.tour__count')?.textContent === `${stop} of 10`, { args: [stop], message: `stop ${stop}` })
    await page.waitFor(() => {
      const card = document.querySelector('.tour__card[data-settled]')
      return card ? card.getAnimations().every((a) => a.playState !== 'running') : false
    }, { message: 'the card to settle' })
    titles.push(await page.eval(() => document.querySelector('.tour__title')?.textContent ?? ''))
    if (shots) await s.shot(page, `whats-new-${stop}`)
    await page.click('.tour__card .btn--primary')
  }
  await page.waitFor(() => !document.querySelector('.tour'), { message: 'the tour to close' })
  return titles
}

const WHATS_NEW_TITLES = [
  'What’s new in Eaon 2026.7',
  'Free models with Eaon Lite',
  'A new message box',
  'Work in a project',
  'A dock beside your agents',
  'Workers that keep going for hours',
  'Automations',
  'A worker computer, and more chat apps',
  'Plan limits, up top',
  'And in Settings'
]

scenario('an update from 2026.6: the setup again, then the tour of what’s new', { timeout: 120_000 }, async (s) => {
  // What 2026.6 left: settings with no word of the setup.
  const app = await s.launch({ env: { EAON_ONBOARDING: 'on' }, seed: { 'settings.json': { activeWorkspaceId: 'work', appearance: { mode: 'light' } } } })
  const page = app.page

  await page.find('.onboarding .onboarding__title', { text: 'Eaon 2026.7 is here' })
  assert.equal(await page.eval(() => document.querySelector('.onboarding__brand-name')?.textContent), 'Set up Eaon 2026.7')
  await s.shot(page, 'update-welcome')
  await page.click('.onboarding .btn--primary', { text: 'Get started' })
  await page.find('.onboarding__title', { text: 'Track your usage with Tokn' })
  await page.click('.onboarding .btn--ghost', { text: 'Not now' })
  await page.find('.onboarding__title', { text: 'Connect a model' })
  await page.click('.onboarding .btn--ghost', { text: 'Not now' })
  await page.find('.onboarding__title', { text: 'Light or dark?' })
  await page.click('.onboarding .btn--primary', { text: 'Continue' })
  await page.find('.onboarding__title', { text: 'You’re all set' })
  await s.shot(page, 'update-ready')
  await page.click('.onboarding .btn--primary', { text: 'See what’s new' })

  await page.waitFor(() => !document.querySelector('.onboarding'), { message: 'the setup to close' })
  assert.deepEqual(await walkWhatsNew(s, page, true), WHATS_NEW_TITLES)
  const done = await onboarding(page)
  assert.equal(done.setup, 'done')
  assert.equal(done.whatsNew, '2026.7')
  assert.equal(done.tour, 'done', 'the tour of the app stays done: this install knows the app')

  // Not again on the next launch.
  await app.quit()
  const again = await s.relaunch(app)
  await again.page.find('.composer')
  await sleep(1_200)
  assert.equal(await again.page.eval(() => Boolean(document.querySelector('.onboarding, .tour'))), false)
})

scenario('an update from a 2026.7 beta that went through the setup: only what’s new, and it’s in Settings', { timeout: 90_000 }, async (s) => {
  const app = await s.launch({
    env: { EAON_ONBOARDING: 'on' },
    seed: { 'settings.json': { onboarding: { setup: 'done', tour: 'skipped', finishedAt: Date.now() - 86_400_000 } } }
  })
  const page = app.page
  await page.find('.tour__title', { text: 'What’s new in Eaon 2026.7' })
  assert.equal(await page.eval(() => Boolean(document.querySelector('.onboarding'))), false, 'no setup again')
  // Shown once, whether or not it's finished.
  await page.waitFor(async () => (await window.api.settings.get()).onboarding.whatsNew === '2026.7', { message: 'what’s new to count as seen' })
  await page.press('Escape')
  await page.waitFor(() => !document.querySelector('.tour'), { message: 'Escape to end the tour' })
  assert.equal((await onboarding(page)).tour, 'skipped', 'the tour of the app is left as it was')

  await openSettings(page, 'General')
  await page.click('.settings button', { text: /^Show me$/ })
  assert.deepEqual(await walkWhatsNew(s, page, false), WHATS_NEW_TITLES)
})
