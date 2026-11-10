import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { store } from '../src/main/store'
import { docPath, storeDir } from '../src/main/storeFiles'
import { noteFirstRun } from '../src/main/features/onboarding'
import { WHATS_NEW_RELEASE } from '@shared/whatsNew'

/**
 * Which installs get the first-run setup and which tour, decided at startup
 * from what's on disk (main/features/onboarding.ts).
 */

/** A profile with these store files, and nothing else. */
async function profile(files: Record<string, unknown>): Promise<void> {
  await store.flushWrites()
  rmSync(storeDir(), { recursive: true, force: true })
  mkdirSync(storeDir(), { recursive: true })
  for (const [name, value] of Object.entries(files)) writeFileSync(join(storeDir(), name), JSON.stringify(value))
}

const onboarding = (): unknown => {
  const { finishedAt, ...rest } = store.getSettings().onboarding
  return { ...rest, finished: finishedAt !== null }
}

test('a fresh install gets the setup and the tour of the app, and nothing is new to it', async () => {
  delete process.env.EAON_ONBOARDING
  await profile({})
  noteFirstRun()
  // `fresh`: the star card may welcome it to Eaon; an updated install is never marked.
  assert.deepEqual(onboarding(), { setup: 'pending', tour: 'pending', whatsNew: WHATS_NEW_RELEASE, fresh: true, finished: false })
  // Quitting halfway: the next launch sees its own settings, and changes nothing.
  noteFirstRun()
  assert.deepEqual(onboarding(), { setup: 'pending', tour: 'pending', whatsNew: WHATS_NEW_RELEASE, fresh: true, finished: false })
})

test('an install updated from 2026.6 gets the setup, then what’s new', async () => {
  delete process.env.EAON_ONBOARDING
  await profile({ 'settings.json': { activeWorkspaceId: 'work', appearance: { mode: 'dark' } }, 'chats.json': [] })
  noteFirstRun()
  assert.deepEqual(onboarding(), { setup: 'pending', tour: 'done', whatsNew: null, finished: false })
  // Its own settings are untouched.
  assert.equal(store.getSettings().appearance.mode, 'dark')
  // The next launch, before it's been through the setup, leaves it due.
  noteFirstRun()
  assert.deepEqual(onboarding(), { setup: 'pending', tour: 'done', whatsNew: null, finished: false })
})

test('an install with chats but no settings counts as updated, not fresh', async () => {
  delete process.env.EAON_ONBOARDING
  await profile({ 'chats.json': [] })
  noteFirstRun()
  assert.deepEqual(onboarding(), { setup: 'pending', tour: 'done', whatsNew: null, finished: false })
})

test('a 2026.7 beta that marked the setup done without showing it gets the setup now', async () => {
  delete process.env.EAON_ONBOARDING
  await profile({ 'settings.json': { onboarding: { setup: 'done', tour: 'done', finishedAt: null } } })
  noteFirstRun()
  assert.deepEqual(onboarding(), { setup: 'pending', tour: 'done', whatsNew: null, finished: false })
})

test('a 2026.7 beta that went through the setup gets only what’s new', async () => {
  delete process.env.EAON_ONBOARDING
  await profile({ 'settings.json': { onboarding: { setup: 'skipped', tour: 'skipped', finishedAt: 1_760_000_000_000 } } })
  noteFirstRun()
  assert.deepEqual(onboarding(), { setup: 'skipped', tour: 'skipped', whatsNew: null, finished: true })
})

test('an install that has seen this release’s what’s new isn’t shown it again; one from an earlier release’s is', async () => {
  delete process.env.EAON_ONBOARDING
  await profile({ 'settings.json': { onboarding: { setup: 'done', tour: 'done', finishedAt: 1_760_000_000_000, whatsNew: WHATS_NEW_RELEASE } } })
  noteFirstRun()
  assert.deepEqual(onboarding(), { setup: 'done', tour: 'done', whatsNew: WHATS_NEW_RELEASE, finished: true })

  await profile({ 'settings.json': { onboarding: { setup: 'done', tour: 'done', finishedAt: 1_760_000_000_000, whatsNew: '2026.1' } } })
  noteFirstRun()
  assert.deepEqual(onboarding(), { setup: 'done', tour: 'done', whatsNew: null, finished: true })
})

test('EAON_ONBOARDING=off skips the setup and both tours, even on an updated install', async () => {
  process.env.EAON_ONBOARDING = 'off'
  try {
    await profile({ 'settings.json': { activeWorkspaceId: 'work' } })
    noteFirstRun()
    assert.deepEqual(onboarding(), { setup: 'done', tour: 'done', whatsNew: WHATS_NEW_RELEASE, finished: false })
    await profile({ 'settings.json': { onboarding: { setup: 'done', tour: 'done', finishedAt: 1_760_000_000_000 } } })
    noteFirstRun()
    assert.deepEqual(onboarding(), { setup: 'done', tour: 'done', whatsNew: WHATS_NEW_RELEASE, finished: true })
  } finally {
    delete process.env.EAON_ONBOARDING
    await store.flushWrites()
    rmSync(docPath('settings.json'), { force: true })
  }
})
