import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS_PAGES, SETTINGS_ROWS } from '../src/shared/settingsIndex'
// @ts-expect-error the generator is plain JavaScript
import { buildSettingsIndex, renderSettingsIndex } from '../scripts/settings-index.mjs'

/** The index of Settings pages and rows that search and the palette read is made from the pages' source. */

// The tests run from the repository root (npm run test:main).
const root = process.cwd()

test('the index matches the pages: run `node scripts/settings-index.mjs` after adding or renaming a setting', () => {
  const current = readFileSync(join(root, 'src/shared/settingsIndex.ts'), 'utf8')
  assert.equal(current, renderSettingsIndex(buildSettingsIndex(root)))
})

test('every row belongs to a page that exists, and has a name', () => {
  const pages = new Set(SETTINGS_PAGES.map((page) => page.id))
  assert.equal(pages.size, SETTINGS_PAGES.length, 'a page id is used twice')
  for (const row of SETTINGS_ROWS) {
    assert.ok(pages.has(row.page), `${row.title} is on a page that is not listed: ${row.page}`)
    assert.ok(row.title.trim(), 'a row with no name')
  }
  for (const page of SETTINGS_PAGES) if (page.parent) assert.ok(pages.has(page.parent), `${page.id} is a tab of a page that is not listed`)
})

test('the pages and rows people look for are there', () => {
  assert.ok(SETTINGS_PAGES.some((page) => page.id === 'appearance' && page.label === 'Appearance'))
  assert.ok(SETTINGS_PAGES.some((page) => page.id === 'payments' && page.parent === 'workers'), 'a Workers tab is listed with its page')
  assert.ok(SETTINGS_ROWS.some((row) => row.page === 'appearance' && row.title === 'Font smoothing' && /anti-aliasing/.test(row.description)))
  assert.ok(SETTINGS_ROWS.some((row) => row.page === 'general' && row.title === 'Suggested prompts' && row.section === 'General'))
  assert.ok(SETTINGS_ROWS.some((row) => row.page === 'email' && row.title === 'Tell me about new mail'), 'a row on a Workers tab is on that tab’s page')
})

test('a title built at run time is left out rather than guessed', () => {
  assert.ok(!SETTINGS_ROWS.some((row) => row.title.includes('${')))
  assert.ok(!SETTINGS_ROWS.some((row) => /^What’s new in /.test(row.title)))
})
