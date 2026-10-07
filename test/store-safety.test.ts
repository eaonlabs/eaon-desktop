import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { store } from '../src/main/store'
import { crashLogPath } from '../src/main/crashGuard'

/**
 * A store file that can't be read must never be replaced by the defaults read
 * in its place, and a write that fails must not take its caller down with it.
 */

const dir = (): string => join(app.getPath('userData'), 'store')
// The store keeps a damaged file as `<name>.corrupt-<time>` (storeFiles.ts).
const asides = (name: string): string[] => readdirSync(dir()).filter((file) => file.startsWith(`${name}.corrupt-`))
const log = (): string => (existsSync(crashLogPath()) ? readFileSync(crashLogPath(), 'utf8') : '')

function reset(): void {
  rmSync(dir(), { recursive: true, force: true })
  mkdirSync(dir(), { recursive: true })
}

test('a damaged chats.json is moved aside, not overwritten by the next save', async () => {
  reset()
  writeFileSync(join(dir(), 'chats.json'), '[{"id":"c1","title":"half a ch')
  assert.deepEqual(store.getChats(), [])
  const [aside] = asides('chats.json')
  assert.ok(aside, 'the damaged file was kept')
  store.saveChats([])
  await store.flushWrites()
  assert.equal(readFileSync(join(dir(), aside), 'utf8'), '[{"id":"c1","title":"half a ch')
})

test('a damaged settings.json reads as defaults and survives the next save', () => {
  reset()
  writeFileSync(join(dir(), 'settings.json'), '')
  assert.equal(store.getSettings().appearance.mode, 'dark')
  store.patchSettings({ planMode: true })
  assert.equal(asides('settings.json').length, 1)
  assert.equal(store.getSettings().planMode, true)
})

test('a file that is simply not there yet is the fallback, with nothing moved or logged', () => {
  reset()
  const before = log()
  assert.deepEqual(store.getJson('never-written.json', { fresh: true }), { fresh: true })
  assert.deepEqual(asides('never-written.json'), [])
  assert.equal(log(), before)
})

test('setJson logs a write that fails instead of throwing into its caller', () => {
  reset()
  // A folder where the file should be: the rename onto it fails.
  mkdirSync(join(dir(), 'blocked.json', 'inside'), { recursive: true })
  assert.doesNotThrow(() => store.setJson('blocked.json', { a: 1 }))
  assert.ok(existsSync(join(dir(), 'blocked.json', 'inside')), 'and nothing was written over what is there')
})

test('on Windows, a rename refused while another process holds the file is tried again', async () => {
  reset()
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')
  const { renameSync } = fs
  const { rename } = fs.promises
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let refusals = 0
  const locked = (): NodeJS.ErrnoException => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  fs.renameSync = ((from: string, to: string) => {
    if (refusals++ < 2) throw locked()
    renameSync(from, to)
  }) as typeof fs.renameSync
  fs.promises.rename = (async (from: string, to: string) => {
    if (refusals++ < 4) throw locked()
    await rename(from, to)
  }) as typeof fs.promises.rename
  syncBuiltinESMExports()
  try {
    store.setJson('locked.json', { saved: 'sync' })
    assert.deepEqual(JSON.parse(readFileSync(join(dir(), 'locked.json'), 'utf8')), { saved: 'sync' })
    assert.equal(refusals, 3)
    store.setJsonAsync('locked-async.json', { saved: 'async' })
    await store.flushWrites()
    assert.deepEqual(JSON.parse(readFileSync(join(dir(), 'locked-async.json'), 'utf8')), { saved: 'async' })
    // Two more refusals, then it went through (the store may rename once more afterwards).
    assert.ok(refusals >= 5, String(refusals))
  } finally {
    Object.defineProperty(process, 'platform', platform)
    fs.renameSync = renameSync
    fs.promises.rename = rename
    syncBuiltinESMExports()
  }
})
