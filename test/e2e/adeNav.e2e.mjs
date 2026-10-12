/**
 * The ADE's sidebar holds only what coding needs (New session, Pull requests,
 * Linear, Settings); Trading, Models and Plugins are in the Chat sidebar, and
 * a session over SSH starts from the New session dialog.
 */
import assert from 'node:assert/strict'
import { scenario } from './fixtures.mjs'


scenario('ADE sidebar: only what coding needs; the rest is in Chat, SSH is in New session', { timeout: 90_000 }, async (s) => {
  const app = await s.launch({})
  const page = app.page
  const workspaces = await page.eval(() => window.api.workspaces.get())
  const ade = workspaces.find((w) => w.kind === 'code')
  const chat = workspaces.find((w) => w.kind === 'chat')

  await page.eval((id) => window.api.settings.patch({ activeWorkspaceId: id }), ade.id)
  await page.reload()
  await page.find('.sidebar .nav-item', { text: /^New session$/ })
  const adeItems = await page.eval(() => [...document.querySelectorAll('.sidebar .nav-item')].map((n) => n.textContent?.trim()).filter((t) => ['New session', 'Session over SSH', 'Pull requests', 'Linear', 'Trading', 'Models', 'Plugins', 'Settings'].includes(t)))
  assert.deepEqual(adeItems, ['New session', 'Pull requests', 'Linear', 'Settings'])
  await s.shot(page, 'ade-sidebar')

  // SSH from the New session dialog.
  await page.click('.sidebar .nav-item', { text: /^New session$/ })
  await page.click('.modal .ade-dialog__ssh', { text: /On another machine \(SSH\)/ })
  await page.find('.modal', { text: /Session over SSH/ })
  await s.shot(page, 'ssh-from-new-session')
  await page.click('.modal button', { text: /^Cancel$/ })

  // Trading, Models and Plugins in Chat.
  await page.eval((id) => window.api.settings.patch({ activeWorkspaceId: id }), chat.id)
  await page.reload()
  await page.find('.sidebar .nav-item', { text: /^New chat$/ })
  const chatItems = await page.eval(() => [...document.querySelectorAll('.sidebar .nav-item')].map((n) => n.textContent?.trim()))
  for (const item of ['Models', 'Library', 'Trading', 'Plugins', 'Settings']) assert.ok(chatItems.includes(item), `${item} in Chat: ${JSON.stringify(chatItems)}`)
  await page.click('.sidebar .nav-item', { text: /^Trading$/ })
  await page.waitFor(() => Boolean(document.querySelector('.tr-desk, .trading, [class*="tr-"]')), { message: 'the Trading page' })
})
