/**
 * Two Eaon windows on one chat (File → New Window). Each window runs its own
 * renderer and store, so what one does has to reach the other: a reply being
 * written, a settings change, an approval being answered. See the brain note
 * "Several Eaon windows: how chats and settings stay in step".
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { reply } from './fakeProvider.mjs'
import { openSettings, scenario, sendMessage, useFakeModel, waitForReply } from './fixtures.mjs'

scenario('two windows on one chat: the reply streams in both, settings and approvals stay in step', { timeout: 150_000 }, async (s) => {
  const fake = await s.fake()
  const app = await s.launch()
  const a = app.page
  await useFakeModel(a, fake)

  // A chat both windows can open.
  fake.route(() => reply.text('First answer, written before the second window opened.'))
  await sendMessage(a, 'Shared chat')
  await waitForReply(a, { text: 'First answer', streaming: false })
  // The reply is saved a moment after it ends (250 ms debounce). A window that
  // loads the chat before that gets it without the reply and, if the save's
  // broadcast lands while the window is still starting, never catches up: seen
  // once with the machine at a load average of 300 ("No response" in the new
  // window), not reproducible on a quiet one. The scenario waits for the save
  // so it checks streaming and settings sync, not that race.
  await a.waitFor(async () => (await window.api.chats.get()).some((c) => JSON.stringify(c.messages).includes('First answer')), {
    message: 'the first reply to be saved in main'
  })

  const b = await app.openWindow()
  const sizes = await app.main(() => require('electron').BrowserWindow.getAllWindows().map((w) => w.getBounds()))
  s.t.diagnostic(`windows: ${JSON.stringify(sizes)}`)
  await b.click('.nav-item', { text: 'Shared chat' })
  await waitForReply(b, { text: 'First answer', streaming: false })

  // A reply written in A shows in B as it streams.
  fake.route(() => reply.hold('Streaming into both windows: '))
  await sendMessage(a, 'Write slowly')
  const held = await fake.nextHeld()
  held.write('alpha ')
  await waitForReply(a, { text: 'alpha', streaming: true })
  const inB = await waitForReply(b, { text: 'alpha' })
  held.write('beta ')
  await waitForReply(b, { text: 'beta' })
  s.t.diagnostic(`window B while A streams: ${JSON.stringify(inB)}`)
  await s.shot(a, 'window-a-streaming')
  await s.shot(b, 'window-b-streaming')
  await s.t.test('window B shows the reply as still being written', {
    todo: 'Bug (multi-window chat, renderer state/store.ts): a window watching another window\'s reply gets the text but not the streaming state (streamingMessageId is per window), so the reply looks finished while it is still being written.'
  }, async () => {
    const shown = await waitForReply(b, { text: 'beta', timeout: 2000 })
    assert.equal(shown.streaming, true)
  })
  // B watches; only A can stop its own reply.
  held.finish('gamma.')
  await waitForReply(a, { text: 'gamma.', streaming: false })
  await waitForReply(b, { text: 'gamma.', streaming: false })
  assert.equal(await b.eval(() => document.querySelectorAll('[data-streaming], .loading-state').length), 0, 'B still shows the finished reply as streaming')

  // A settings change in A reaches B without a reload.
  const before = await b.eval(() => getComputedStyle(document.body).backgroundColor)
  const mode = await a.eval(async () => (await window.api.settings.get()).appearance.mode)
  const target = mode === 'light' ? 'Dark' : 'Light'
  await openSettings(a, 'Appearance')
  await a.click('.theme-card', { text: target })
  await b.waitFor((before) => getComputedStyle(document.body).backgroundColor !== before, { args: [before], message: `window B to switch to ${target}` })
  const bMode = await b.eval(() => document.documentElement.dataset.theme ?? document.documentElement.className ?? '')
  s.t.diagnostic(`theme ${mode} → ${target}; B's background ${before} → ${await b.eval(() => getComputedStyle(document.body).backgroundColor)} (${bMode})`)
  await s.shot(b, 'window-b-after-theme-change')
  await a.click('.settings__back')

  // An approval answered in A is gone from both.
  await a.eval(() => window.api.settings.patch({ approvalMode: 'ask' }))
  await a.click('.nav-item', { text: 'Shared chat' })
  fake.route((req) =>
    req.toolResultsSinceUser === 0 ? reply.tool('write_file', { path: 'two-windows.txt', content: 'ok\n' }) : reply.text('Wrote it from the first window.')
  )
  await sendMessage(a, 'Write two-windows.txt')
  await a.find('.approval-layer[data-state="in"] .approval__approve')
  // B follows the run: the call shows in its transcript too.
  await b.waitFor(() => /two-windows\.txt/.test(document.querySelector('.thread, .main')?.textContent ?? ''), { message: 'window B to show the pending call' })
  const bPrompt = await b.eval(() => Boolean(document.querySelector('.approval-layer[data-state="in"]')))
  s.t.diagnostic(`window B ${bPrompt ? 'also shows' : 'does not show'} the approval prompt (only the window that started a reply answers its approvals)`)
  await s.shot(b, 'window-b-while-a-is-asked')
  await a.click('.approval-layer .approval__approve')
  await waitForReply(a, { text: 'Wrote it from the first window', streaming: false })
  await waitForReply(b, { text: 'Wrote it from the first window', streaming: false })
  for (const [name, page] of [['A', a], ['B', b]]) {
    await page.waitFor(() => !document.querySelector('.approval-layer'), { message: `window ${name}'s approval prompt to close` })
    const waiting = await page.eval(() => /Waiting for approval/i.test(document.querySelector('.main')?.textContent ?? ''))
    assert.equal(waiting, false, `window ${name} still says "Waiting for approval" after it was answered`)
  }
  assert.ok(existsSync(join(s.homeDir, 'Eaon', 'two-windows.txt')))
  await s.shot(b, 'window-b-after-approval')

  // Closing one window leaves the other working.
  await app.main((targetId) => {
    const { webContents, BrowserWindow } = require('electron')
    BrowserWindow.fromWebContents(webContents.fromDevToolsTargetId(targetId))?.close()
  }, b.targetId)
  await app.waitForWindowCount(1)
  fake.route(() => reply.text('Still here after the other window closed.'))
  await sendMessage(a, 'Still there?')
  await waitForReply(a, { text: 'Still here', streaming: false })
})
