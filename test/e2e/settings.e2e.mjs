/**
 * Settings → General: every control there does something (a setting saved,
 * a page or menu opened, a link opened), and the software update section
 * copes with being offline.
 *
 * Links are recorded by the harness instead of opening the real browser, and
 * "Launch at login" writes its LaunchAgent into the scenario's own HOME.
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openSettings, scenario } from './fixtures.mjs'

/**
 * The page's controls, in order, as the user sees them: buttons, switches and
 * the custom selects (which are buttons too). Disabled ones are listed apart:
 * a disabled control is fine when it says why (that is the ui stream's
 * audit), it just can't be clicked here.
 * @param {import('./harness.mjs').Page} page
 */
function listControls(page) {
  return page.eval(() => {
    const root = document.querySelector('.settings__inner') ?? document.querySelector('.settings__body')
    const controls = [...(root?.querySelectorAll('button, [role="switch"], select, input, a[href]') ?? [])]
    return controls.map((el, index) => {
      const row = el.closest('.row')
      const title = row?.querySelector('.row__title')?.textContent?.trim() ?? ''
      const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim()
      return {
        index,
        kind: el.getAttribute('role') === 'switch' ? 'switch' : el.classList.contains('select') ? 'select' : el.tagName.toLowerCase(),
        label: `${title ? `${title} › ` : ''}${label}`.slice(0, 80),
        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true'
      }
    })
  })
}

scenario('Settings → General: every control does something', { timeout: 150_000 }, async (s) => {
  const app = await s.launch()
  const page = app.page
  await openSettings(page, 'General')
  await s.shot(page, 'general')
  const controls = await listControls(page)
  s.t.diagnostic(`controls: ${controls.map((c) => `${c.kind}:${c.label}${c.disabled ? ' (disabled)' : ''}`).join(' | ')}`)
  assert.ok(controls.length > 5, 'Settings → General has hardly any controls; did the page render?')

  await app.recordIpc()
  const dead = []
  const results = []
  for (const control of controls) {
    if (control.disabled) continue
    await app.takeIpc()
    const openedBefore = (await app.openedUrls()).length
    // Watch the whole document: a menu or dialog opens in a portal.
    await page.eval(() => {
      window.__e2eMutations = 0
      window.__e2eObserver?.disconnect()
      window.__e2eObserver = new MutationObserver((records) => {
        window.__e2eMutations += records.filter((r) => !(r.type === 'attributes' && r.attributeName === 'style' && r.target instanceof HTMLTextAreaElement)).length
      })
      window.__e2eObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    })
    // Found again by its row title and label rather than by position: a click
    // earlier in the loop can add controls (a failed update check adds an
    // "Update didn't finish" row), and every index after that would point at
    // the wrong element.
    const clicked = await page
      .eval((label) => {
        const root = document.querySelector('.settings__inner') ?? document.querySelector('.settings__body')
        const all = [...(root?.querySelectorAll('button, [role="switch"], select, input, a[href]') ?? [])]
        const el = all.find((candidate) => {
          const row = candidate.closest('.row')
          const title = row?.querySelector('.row__title')?.textContent?.trim() ?? ''
          const text = (candidate.getAttribute('aria-label') || candidate.textContent || candidate.getAttribute('title') || '').trim()
          return `${title ? `${title} › ` : ''}${text}`.slice(0, 80) === label
        })
        if (!el) return 'gone'
        el.scrollIntoView({ block: 'center' })
        const rect = el.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }, control.label)
    if (clicked === 'gone') continue
    await page.mouse(clicked.x, clicked.y)
    // Up to 1.5 s for anything to happen: an IPC call, a link, a DOM change.
    let effect = null
    const deadline = Date.now() + 1500
    while (!effect && Date.now() < deadline) {
      const ipc = await app.main(() => [...(globalThis.__e2eIpc ?? [])])
      const opened = (await app.openedUrls()).slice(openedBefore)
      const mutations = await page.eval(() => window.__e2eMutations)
      const calls = ipc.filter((c) => !/:(get|list|status|statuses|version)$/.test(c))
      if (opened.length) effect = `opened ${opened.join(', ')}`
      else if (calls.length) effect = `ipc ${[...new Set(calls)].join(', ')}`
      else if (mutations > 0) effect = `${mutations} DOM changes`
      else await new Promise((resolve) => setTimeout(resolve, 100))
    }
    results.push(`${control.kind}:${control.label} → ${effect ?? 'NOTHING'}`)
    if (!effect) dead.push(`${control.kind} "${control.label}"`)
    // Close whatever opened (a select's menu) before the next control.
    if (await page.eval(() => Boolean(document.querySelector('[role="menuitem"]')))) {
      await page.press('Escape')
      await page.waitFor(() => !document.querySelector('[role="menuitem"]'), { timeout: 3000, message: 'the menu to close' })
    }
  }
  s.t.diagnostic(`results:\n${results.join('\n')}`)
  await page.eval(() => window.__e2eObserver?.disconnect())
  await s.shot(page, 'general-after-clicks')

  // A select really changes its setting: Open on launch → Workers, saved in main.
  const select = await page.eval(() => [...document.querySelectorAll('.settings__inner .select')].findIndex((el) => /Chat|Workers|ADE|Where I left off/.test(el.textContent ?? '')))
  if (select !== -1) {
    await page.click('.settings__inner .select', { text: /^(Chat|ADE|Where I left off)$/ })
    await page.click('[role="menuitem"]', { text: /^Workers$/ })
    await page.waitFor(async () => (await window.api.settings.get()).general.launchMode === 'workers', { message: 'Open on launch to be saved as Workers' })
  }
  assert.deepEqual(app.pageErrors().filter((e) => /exception/.test(e)), [], 'clicking through General threw in the page')

  await s.t.test('no control on General is dead', () => {
    assert.deepEqual(dead, [])
  })
})

scenario('software update: checking while offline shows a failure, not a crash or a hang', { timeout: 120_000 }, async (s) => {
  // On Linux electron-updater only updates an AppImage and skips the check
  // without APPIMAGE; pretending to be one gets the real check to run.
  const app = await s.launch(process.platform === 'linux' ? { env: { APPIMAGE: join(s.homeDir, 'Eaon.AppImage') } } : {})
  const page = app.page
  // A built-from-source app has no update feed and checkForUpdates() returns
  // early (updater.ts), so the real electron-updater is pointed at a feed on
  // a closed port and the app is told it is packaged for this check only.
  const feed = join(s.homeDir, 'dev-app-update.yml')
  writeFileSync(feed, `provider: generic\nurl: http://127.0.0.1:${app.offlinePort}/updates\nupdaterCacheDirName: eaon-e2e-updater\n`)
  const wired = await app.main((feed) => {
    const { app } = require('electron')
    const { autoUpdater } = require('electron-updater')
    // The app's own instance has its listeners; a second copy would have none.
    const listeners = autoUpdater.listenerCount('error')
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.updateConfigPath = feed
    globalThis.__e2eIsPackaged = Object.getOwnPropertyDescriptor(app, 'isPackaged')
    Object.defineProperty(app, 'isPackaged', { configurable: true, get: () => true })
    return listeners
  }, feed)
  assert.ok(wired > 0, "the harness reached a different electron-updater instance than the app's")

  await openSettings(page, 'General')
  const button = await page.find('.settings__inner button', { text: /Check for updates/ })
  assert.ok(button)
  const started = Date.now()
  await page.click('.settings__inner button', { text: /Check for updates/ })
  const failed = await page.waitFor(
    () => {
      const row = [...document.querySelectorAll('.settings__inner .row')].find((r) => /^Update (check failed|didn.t finish)$/.test(r.querySelector('.row__title')?.textContent ?? ''))
      return row ? (row.querySelector('.row__desc')?.textContent ?? '').trim() || '(no description)' : null
    },
    { timeout: 30_000, message: 'the update failure row in Settings → General' }
  )
  s.t.diagnostic(`offline update check failed after ${Date.now() - started} ms with: ${JSON.stringify(failed)}`)
  await s.shot(page, 'update-offline')
  assert.ok(failed.length > 0, 'the failure says nothing')
  await s.t.test('the offline update failure is short and readable', () => {
    assert.doesNotMatch(failed, /net::ERR_|ECONN|ENOTFOUND|HttpError|status code/i, 'a raw error code instead of words')
    assert.match(failed, /couldn.t|can.t|offline|internet|update server/i)
    assert.ok(failed.length < 160, `${failed.length} characters`)
  })
  // The button is usable again and the window is alive.
  await page.find('.settings__inner button', { text: /Check for updates/, enabled: true })
  assert.equal(await page.eval(() => document.querySelector('.settings__h1')?.textContent), 'General')
  await app.main(() => {
    const { app } = require('electron')
    if (globalThis.__e2eIsPackaged) Object.defineProperty(app, 'isPackaged', globalThis.__e2eIsPackaged)
    return app.isPackaged
  })
})

scenario('a beta build can go back to the stable version, after asking; a stable build isn’t offered it', { timeout: 120_000 }, async (s) => {
  const app = await s.launch()
  const page = app.page
  await openSettings(page, 'General')
  assert.equal(await page.eval(() => [...document.querySelectorAll('.settings__inner .row__title')].some((t) => t.textContent === 'Go back to the stable version')), false, 'not offered on a stable build')

  // Pretend to be a beta: the version is read from main each time Settings opens.
  await app.main(async () => {
    const { app } = require('electron')
    app.getVersion = () => '2026.6.2-beta.3'
    return true
  })
  await page.reload()
  await openSettings(page, 'General')
  await page.click('.settings__inner button', { text: /^Switch to stable$/ })
  await page.find('.modal__title', { text: 'Go back to the stable version?' })
  await s.shot(page, 'switch-to-stable-confirm')
  // Declining changes nothing.
  await app.recordIpc()
  await page.click('.modal button', { text: /^Stay on the beta$/ })
  await page.waitFor(() => !document.querySelector('.modal'), { message: 'the dialog to close' })
  assert.deepEqual((await app.takeIpc()).filter((c) => /updater:/.test(c)), [], 'nothing was downloaded')
  // Accepting asks the updater (a dev build can't update, so main refuses; the page stays alive).
  await page.click('.settings__inner button', { text: /^Switch to stable$/ })
  await page.click('.modal button', { text: /^Download the stable version$/ })
  const seen = []
  const deadline = Date.now() + 10_000
  while (!seen.includes('updater:switch-to-stable') && Date.now() < deadline) {
    seen.push(...(await app.takeIpc()))
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(seen.includes('updater:switch-to-stable'), `accepting asks the updater (saw ${JSON.stringify(seen)})`)
  assert.deepEqual(app.pageErrors().filter((e) => /exception/i.test(e)), [])
})
