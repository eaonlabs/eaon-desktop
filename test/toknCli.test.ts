import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { store } from '../src/main/store'
import { installLauncher, removeLauncher, toknCliStatus, trackCodingClisByDefault } from '../src/main/features/toknCli'
import { secrets } from '../src/main/secrets'
import { noteFirstRun } from '../src/main/features/onboarding'

/**
 * The tokn command that ships with Eaon: its launcher on PATH (a temp bin
 * folder, EAON_TOKN_BIN_DIR), its link read from tokn's own config
 * (TOKN_CONFIG_DIR), and the first-run check that decides who sees the
 * setup. Nothing here runs tokn or reaches Tokn; e2e/onboarding does.
 */

let root = ''
const bin = (): string => join(root, 'bin')
const launcher = (): string => join(bin(), process.platform === 'win32' ? 'tokn.cmd' : 'tokn')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eaon-tokn-'))
  // A bundle of our own: just the files Eaon looks for.
  mkdirSync(join(root, 'cli', 'dist'), { recursive: true })
  writeFileSync(join(root, 'cli', 'dist', 'index.js'), 'console.log("tokn")\n')
  writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ name: 'toknhq', version: '9.9.9' }))
  process.env.EAON_TOKN_CLI_DIR = join(root, 'cli')
  process.env.EAON_TOKN_BIN_DIR = bin()
  process.env.TOKN_CONFIG_DIR = join(root, 'config')
})

afterEach(() => {
  delete process.env.EAON_TOKN_CLI_DIR
  delete process.env.EAON_TOKN_BIN_DIR
  delete process.env.TOKN_CONFIG_DIR
  rmSync(root, { recursive: true, force: true })
})

test('the launcher runs the bundled tokn with Eaon’s own Node, and is rewritten only when it changes', () => {
  installLauncher()
  const text = readFileSync(launcher(), 'utf8')
  assert.match(text, /Installed by Eaon Desktop/)
  assert.ok(text.includes(join(root, 'cli', 'dist', 'index.js')), 'it points at the bundle')
  assert.ok(text.includes('ELECTRON_RUN_AS_NODE=1'))
  if (process.platform !== 'win32') assert.equal(statSync(launcher()).mode & 0o111, 0o111, 'it can be run')

  const before = statSync(launcher()).mtimeMs
  installLauncher()
  assert.equal(statSync(launcher()).mtimeMs, before, 'the same text is not written again')

  // Eaon moved: the bundle is somewhere else now.
  rmSync(join(root, 'cli2'), { recursive: true, force: true })
  mkdirSync(join(root, 'cli2', 'dist'), { recursive: true })
  writeFileSync(join(root, 'cli2', 'dist', 'index.js'), '')
  writeFileSync(join(root, 'cli2', 'package.json'), '{"version":"9.9.10"}')
  process.env.EAON_TOKN_CLI_DIR = join(root, 'cli2')
  installLauncher()
  assert.ok(readFileSync(launcher(), 'utf8').includes(join(root, 'cli2')), 'it follows the bundle')

  const status = toknCliStatus()
  assert.equal(status.version, '9.9.10')
  assert.deepEqual(status.command, { kind: 'eaon', path: launcher() })
  assert.equal(status.needsPath, null)
})

test('a tokn that isn’t Eaon’s (from npm) is left alone, and removing takes only Eaon’s', () => {
  mkdirSync(bin(), { recursive: true })
  writeFileSync(launcher(), '#!/usr/bin/env node\n// toknhq from npm\n', { mode: 0o755 })
  installLauncher()
  assert.equal(readFileSync(launcher(), 'utf8'), '#!/usr/bin/env node\n// toknhq from npm\n')
  assert.equal(toknCliStatus().command?.kind, 'other')
  removeLauncher()
  assert.ok(existsSync(launcher()), 'someone else’s tokn is never removed')

  rmSync(launcher())
  installLauncher()
  assert.equal(toknCliStatus().command?.kind, 'eaon')
  removeLauncher()
  assert.equal(existsSync(launcher()), false)
  assert.equal(toknCliStatus().command, null)
})

test('a build without the bundle installs nothing', () => {
  process.env.EAON_TOKN_CLI_DIR = join(root, 'nowhere')
  // The development copy in resources/ would be found otherwise; only check when it isn't there.
  if (toknCliStatus().version !== null) return
  installLauncher()
  assert.equal(existsSync(launcher()), false)
})

test('who tokn is linked to comes from its own config', () => {
  assert.equal(toknCliStatus().linked, null)
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'config.json'), JSON.stringify({ host: 'https://toknhq.com' }))
  assert.equal(toknCliStatus().linked, null, 'no token, not linked')
  writeFileSync(join(root, 'config', 'config.json'), JSON.stringify({ host: 'https://toknhq.com', token: 'tok_x', user: { id: 'u', handle: 'alex' } }))
  assert.deepEqual(toknCliStatus().linked, { handle: 'alex' })
  writeFileSync(join(root, 'config', 'config.json'), '{ not json')
  assert.equal(toknCliStatus().linked, null)
})

/* ------------------------------------------------------------ first run */

const storeDir = (): string => join(app.getPath('userData'), 'store')
function freshStore(files: Record<string, unknown> = {}): void {
  rmSync(storeDir(), { recursive: true, force: true })
  mkdirSync(storeDir(), { recursive: true })
  for (const [name, value] of Object.entries(files)) writeFileSync(join(storeDir(), name), JSON.stringify(value))
}

test('first run: a fresh install gets the setup, and so does one from before 2026.7 (test/onboarding.test.ts has the rest)', async () => {
  const env = process.env.EAON_ONBOARDING
  delete process.env.EAON_ONBOARDING
  try {
    freshStore()
    noteFirstRun()
    assert.equal(store.getSettings().onboarding.setup, 'pending', 'nothing on disk: a fresh install')

    freshStore({ 'settings.json': { appearance: { mode: 'dark' } } })
    noteFirstRun()
    assert.deepEqual(store.getSettings().onboarding, { setup: 'pending', tour: 'done', finishedAt: null, whatsNew: null }, 'settings from an older Eaon: the setup, then what’s new')

    freshStore({ 'chats.json': [] })
    noteFirstRun()
    assert.equal(store.getSettings().onboarding.whatsNew, null, 'chats but no settings: not new, so what’s new is due')

    // Halfway through the setup when Eaon quit: it is offered again.
    freshStore({ 'settings.json': { onboarding: { setup: 'pending', tour: 'pending', finishedAt: null } } })
    noteFirstRun()
    assert.equal(store.getSettings().onboarding.setup, 'pending')

    process.env.EAON_ONBOARDING = 'off'
    freshStore()
    noteFirstRun()
    assert.equal(store.getSettings().onboarding.setup, 'done', 'off: never shown')
  } finally {
    if (env === undefined) delete process.env.EAON_ONBOARDING
    else process.env.EAON_ONBOARDING = env
    await store.flushWrites()
  }
})

test('first run: when the setup finished is kept as a time', () => {
  freshStore()
  store.patchSettings({ onboarding: { setup: 'done', tour: 'skipped', finishedAt: 1_760_000_000_000 } })
  assert.equal(store.getSettings().onboarding.finishedAt, 1_760_000_000_000)
  assert.equal(store.getSettings().onboarding.tour, 'skipped')
  // An unknown state goes back to the default rather than wedging the app.
  writeFileSync(join(storeDir(), 'settings.json'), JSON.stringify({ onboarding: { setup: 'sideways', tour: 'done', finishedAt: 'later' } }))
  const onboarding = store.getSettings().onboarding
  assert.equal(onboarding.setup, 'pending')
  assert.equal(onboarding.tour, 'done')
})

test('the coding CLIs are tracked by default', () => {
  freshStore()
  assert.equal(store.getSettings().toknCli.sync, true)
})

test('from an older Eaon: tracking goes on, except where Eaon is signed in to Tokn with it off', async () => {
  const signedIn = { account: { id: 'u_1', handle: 'alex', name: 'Alex', profileUrl: 'https://tokn.test/alex' } }
  try {
    // Never signed in: off was only the old default (or a setup skipped without signing in).
    freshStore({ 'settings.json': { toknCli: { install: true, sync: false } } })
    trackCodingClisByDefault()
    assert.equal(store.getSettings().toknCli.sync, true)
    trackCodingClisByDefault()
    assert.equal(store.getSettings().toknCli.sync, true, 'running it again changes nothing')

    // Signed in with it off: that may have been the person's no, so it stays.
    secrets.set('oauth::tokn', JSON.stringify(signedIn))
    freshStore({ 'settings.json': { toknCli: { install: true, sync: false } } })
    trackCodingClisByDefault()
    assert.equal(store.getSettings().toknCli.sync, false)

    // Signed in with it on: as it was.
    freshStore({ 'settings.json': { toknCli: { install: false, sync: true } } })
    trackCodingClisByDefault()
    assert.deepEqual(store.getSettings().toknCli, { install: false, sync: true })
  } finally {
    secrets.set('oauth::tokn', '')
    await store.flushWrites()
  }
})
