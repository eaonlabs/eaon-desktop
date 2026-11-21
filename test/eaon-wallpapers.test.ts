import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WALLPAPERS, wallpaperFile, wallpaperOf, wallpaperSource } from '../src/shared/wallpaper'

/**
 * Eaon's own wallpapers for See-through: each ships dark and light, and the
 * picture comes from the desktop only where the OS says what it shows.
 */

test('every Eaon wallpaper ships in a dark and a light version', () => {
  const dir = join(process.cwd(), 'resources', 'wallpapers')
  const missing = WALLPAPERS.flatMap(({ id }) => [wallpaperFile(id, false), wallpaperFile(id, true)]).filter((file) => !existsSync(join(dir, file)))
  assert.deepEqual(missing, [])
})

test('an unknown or unset wallpaper is the first', () => {
  assert.equal(wallpaperOf(undefined).id, WALLPAPERS[0].id)
  assert.equal(wallpaperOf('gone').id, WALLPAPERS[0].id)
  assert.equal(wallpaperFile('tide', true), 'tide-light.jpg')
  assert.equal(wallpaperFile('../x', false), `${WALLPAPERS[0].id}-dark.jpg`)
})

test('the picture comes from the desktop only where the OS says which it is', () => {
  const desktop = { source: 'desktop' as const, custom: null }
  assert.equal(wallpaperSource(desktop, 'darwin'), 'desktop')
  assert.equal(wallpaperSource(desktop, 'win32'), 'desktop')
  assert.equal(wallpaperSource(desktop, 'linux'), 'eaon')
  assert.equal(wallpaperSource({ source: 'eaon', custom: null }, 'darwin'), 'eaon')
  assert.equal(wallpaperSource({ source: 'custom', custom: '/w/wallpaper-1.jpg' }, 'linux'), 'custom')
  // Custom with nothing chosen yet shows what it would without it.
  assert.equal(wallpaperSource({ source: 'custom', custom: null }, 'darwin'), 'desktop')
  assert.equal(wallpaperSource({ source: 'custom', custom: null }, 'linux'), 'eaon')
})
