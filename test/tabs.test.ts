import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeTab, APP_TABS, shownTabs, sideOfChat, splitsChats, tabsPromptDue } from '../src/shared/tabs'

/**
 * The top bar's tabs, as Settings → General → Tabs sets them: which are
 * there and in what order, and how Chat and the IDE share the chats.
 */

test('the tabs shown are the setting cleaned up, or all four', () => {
  assert.deepEqual(shownTabs(undefined), ['chat', 'workers', 'ide', 'ade'])
  assert.deepEqual(shownTabs([]), [...APP_TABS], 'none left is every tab, never an empty bar')
  assert.deepEqual(shownTabs(['ide', 'chat']), ['ide', 'chat'], 'in the order picked')
  assert.deepEqual(shownTabs(['ade', 'ade', 'code', 7, null, 'workers']), ['ade', 'workers'], 'unknown and repeated tabs dropped')
})

test('Chat and the IDE split the chats only when both are tabs', () => {
  assert.equal(splitsChats(['chat', 'ide']), true)
  assert.equal(splitsChats(['chat', 'workers']), false)
  assert.equal(splitsChats(['ide', 'ade']), false)
  assert.equal(sideOfChat({ projectId: 'p1' }), 'ide', 'a chat in a project is the IDE’s')
  assert.equal(sideOfChat({ projectId: null }), 'chat')
  assert.equal(sideOfChat({}), 'chat')
})

test('the tab in front follows the workspace, and the side for the chat workspace', () => {
  const all = shownTabs(undefined)
  assert.equal(activeTab('workers', 'ide', all), 'workers')
  assert.equal(activeTab('code', null, all), 'ade')
  assert.equal(activeTab('chat', 'ide', all), 'ide')
  assert.equal(activeTab('chat', 'chat', all), 'chat')
  assert.equal(activeTab('chat', undefined, all), 'chat', 'unset is Chat')
  // One of the two alone has every chat, whichever side was last in front.
  assert.equal(activeTab('chat', 'chat', ['ide', 'ade']), 'ide')
  assert.equal(activeTab('chat', 'ide', ['chat', 'workers']), 'chat')
})

test('an install set up before the IDE tab is asked its tabs once, after the setup and what’s new', () => {
  const updated = { onboarding: { setup: 'done', tour: 'done', finishedAt: 1, whatsNew: '2026.7' } } as const
  assert.equal(tabsPromptDue(updated), true, 'updated into four tabs it never chose')
  assert.equal(tabsPromptDue({ ...updated, general: {} }), true)
  assert.equal(tabsPromptDue({ onboarding: { ...updated.onboarding, setup: 'skipped' } }), true)
  assert.equal(tabsPromptDue({ onboarding: { ...updated.onboarding, tabsAsked: true } }), false, 'asked already, here or in the setup')
  assert.equal(tabsPromptDue({ ...updated, general: { tabs: ['chat', 'ide'] } }), false, 'picked in Settings')
  assert.equal(tabsPromptDue({ onboarding: { ...updated.onboarding, setup: 'pending' } }), false, 'the setup has its own Tabs step')
  assert.equal(tabsPromptDue({ onboarding: { ...updated.onboarding, whatsNew: null } }), false, 'after the what’s-new tour')
  assert.equal(tabsPromptDue(null), false, 'settings not loaded')
})
