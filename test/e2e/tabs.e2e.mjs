/**
 * Chat and the IDE as tabs: the IDE only ever has the chats in a project,
 * whether Chat is a tab beside it or not. Plain chats in the IDE would make
 * it a second Chat.
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openSettings, scenario } from './fixtures.mjs'

/** @param {string} id @param {string | null} projectId @param {string} title @param {number} at */
const chat = (id, projectId, title, at) => ({
  id,
  workspaceId: 'work',
  projectId,
  title,
  messages: [{ id: `${id}-1`, role: 'user', parts: [{ type: 'text', text: title }], createdAt: at }],
  createdAt: at,
  updatedAt: at,
  archived: false,
  pinned: false,
  unread: false,
  modelId: null,
  effort: 'medium'
})

/** The sidebar's headings and whether each chat is listed. @param {import('./harness.mjs').Page} page */
const sidebar = (page) =>
  page.eval(() => {
    const side = document.querySelector('.sidebar')
    const text = side?.textContent ?? ''
    return {
      heads: [...(side?.querySelectorAll('.sidebar-head__label, .sidebar-head') ?? [])].map((h) => h.textContent?.trim().split('\n')[0]).filter(Boolean),
      plain: text.includes('A plain question'),
      project: text.includes('shop-app'),
      models: [...(side?.querySelectorAll('.nav-item') ?? [])].some((item) => item.textContent?.trim() === 'Models')
    }
  })

scenario('the IDE lists only project chats, with Chat beside it or not', { timeout: 120_000 }, async (s) => {
  // Started clean here rather than by the launch, which would clear the lists written below.
  rmSync(s.profileDir, { recursive: true, force: true })
  rmSync(s.homeDir, { recursive: true, force: true })
  const folder = join(s.homeDir, 'shop-app')
  mkdirSync(folder, { recursive: true })
  const now = Date.now()
  // Lists, which the launch's seed (merged as objects) can't write.
  const store = join(s.profileDir, 'store')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'projects.json'), JSON.stringify([{ id: 'p-shop', workspaceId: 'work', name: 'shop-app', instructions: '', createdAt: now - 60_000, folder }]))
  writeFileSync(join(store, 'chats.json'), JSON.stringify([chat('c-plain', null, 'A plain question', now - 30_000), chat('c-code', 'p-shop', 'Fix the checkout', now - 20_000)]))
  const app = await s.launch({
    fresh: false,
    seed: { 'settings.json': { activeWorkspaceId: 'work', chatSide: 'chat', general: { tabs: ['chat', 'ide', 'ade'] } } }
  })
  const page = app.page
  await page.find('.mode-switch__option[data-tab="chat"][data-active]')

  // Chat beside the IDE: each has its own.
  await page.waitFor(() => document.querySelector('.sidebar')?.textContent?.includes('A plain question'), { message: 'Chat lists the plain chat' })
  let seen = await sidebar(page)
  assert.equal(seen.project, false, 'Chat has no projects')
  await page.click('.sidebar [role="button"]', { text: /A plain question/ })
  await page.click('.mode-switch__option[data-tab="ide"]')
  await page.find('.mode-switch__option[data-tab="ide"][data-active]')
  seen = await sidebar(page)
  assert.equal(seen.plain, false, 'the IDE has no plain chats')
  assert.equal(seen.project, true, 'the IDE lists its project')
  assert.equal(seen.heads.includes('Chats'), false, 'no Chats heading in the IDE')

  // Chat hidden, with its plain chat open: the IDE still has none, and moves off it.
  await page.click('.mode-switch__option[data-tab="chat"]')
  await page.click('.sidebar [role="button"]', { text: /A plain question/ })
  await page.waitFor(() => document.querySelector('.sidebar [aria-current="page"]')?.textContent?.includes('A plain question'), { message: 'the plain chat open' })
  await openSettings(page, 'General')
  await page.click('.settings [role="switch"][aria-label="Show Chat"]')
  await page.waitFor(async () => (await window.api.settings.get()).general.tabs?.join() === 'ide,ade', { message: 'Chat hidden' })
  await page.click('.settings__back')
  await page.find('.mode-switch__option[data-tab="ide"][data-active]')
  seen = await sidebar(page)
  assert.equal(seen.plain, false, 'the IDE alone still has no plain chats')
  assert.equal(seen.project, true)
  assert.equal(seen.heads.includes('Chats'), false)
  assert.equal(seen.models, true, 'Models, the Library and Plugins come to the IDE when Chat is not a tab')
  assert.equal(await page.eval(() => document.querySelector('.main')?.textContent?.includes('A plain question') ?? false), false, 'the plain chat closed')
  assert.equal(await page.eval(() => Boolean(document.querySelector('.temp-toggle'))), false, 'no temporary chats in the IDE')
  await s.shot(page, 'ide-alone')

  // Chat alone has every chat again, as before the IDE had a tab.
  await openSettings(page, 'General')
  await page.click('.settings [role="switch"][aria-label="Show Chat"]')
  await page.click('.settings [role="switch"][aria-label="Show IDE"]')
  await page.waitFor(async () => (await window.api.settings.get()).general.tabs?.join() === 'ade,chat', { message: 'only Chat and the ADE' })
  await page.click('.settings__back')
  await page.click('.mode-switch__option[data-tab="chat"]')
  seen = await sidebar(page)
  assert.equal(seen.plain, true)
  assert.equal(seen.project, true, 'Chat without the IDE has the projects too')
})
