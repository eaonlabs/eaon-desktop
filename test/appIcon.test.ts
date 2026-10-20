import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appIconFile } from '../src/main/appIcon'
import { defaultSettings, store } from '../src/main/store'
import { APP_ICON_BACKGROUNDS } from '../src/shared/types'

/**
 * The app icon picked in Settings → Appearance: which image each platform
 * shows, packaged and in development.
 */

const packaged = (platform: NodeJS.Platform) => ({ platform, packaged: true, resourcesPath: '/App/Resources', devResources: '/repo/resources' })
const dev = (platform: NodeJS.Platform) => ({ platform, packaged: false, resourcesPath: '/electron', devResources: '/repo/resources' })

test('a packaged Mac app keeps its own Liquid Glass icon unless the agent is picked', () => {
  assert.equal(appIconFile('default', packaged('darwin')), null)
  assert.equal(appIconFile('agent', packaged('darwin')), join('/App/Resources', 'icons', 'agent.png'))
})

test('Windows takes the .ico files, Linux the PNGs, both shipped under icons/', () => {
  assert.equal(appIconFile('default', packaged('win32')), join('/App/Resources', 'icons', 'default.ico'))
  assert.equal(appIconFile('agent', packaged('win32')), join('/App/Resources', 'icons', 'agent.ico'))
  assert.equal(appIconFile('default', packaged('linux')), join('/App/Resources', 'icons', 'default.png'))
  assert.equal(appIconFile('agent', packaged('linux')), join('/App/Resources', 'icons', 'agent.png'))
})

test('dev runs read the images straight from resources/, including the Mac default', () => {
  assert.equal(appIconFile('default', dev('darwin')), join('/repo/resources', 'icon.png'))
  assert.equal(appIconFile('agent', dev('darwin')), join('/repo/resources', 'icon-agent.png'))
  assert.equal(appIconFile('agent', dev('win32')), join('/repo/resources', 'icon-agent.ico'))
})

test('the Disc E is the default, so existing installs keep the icon they have', () => {
  assert.equal(defaultSettings.appearance.appIcon, 'default')
})

test('the Disc E on another background is shown on every platform, the Mac Dock included', () => {
  for (const icon of APP_ICON_BACKGROUNDS) {
    assert.equal(appIconFile(icon, packaged('darwin')), join('/App/Resources', 'icons', `${icon}.png`))
    assert.equal(appIconFile(icon, packaged('win32')), join('/App/Resources', 'icons', `${icon}.ico`))
    assert.equal(appIconFile(icon, packaged('linux')), join('/App/Resources', 'icons', `${icon}.png`))
    assert.equal(appIconFile(icon, dev('darwin')), join('/repo/resources', 'app-icons', `${icon}.png`))
  }
})

test('every background has its images built: Dock and window, Windows, and its tile in Settings', () => {
  const root = process.cwd()
  for (const icon of APP_ICON_BACKGROUNDS) {
    for (const file of [join('resources', 'app-icons', `${icon}.png`), join('resources', 'app-icons', `${icon}.ico`), join('src', 'renderer', 'src', 'assets', 'app-icons', `${icon}.png`)]) {
      assert.ok(existsSync(join(root, file)), `${file} exists (python3 scripts/make-icon.py --variants)`)
    }
  }
})

test('a background picked in Settings is kept, and an unknown icon goes back to the Disc E', () => {
  for (const icon of APP_ICON_BACKGROUNDS) assert.equal(store.patchSettings({ appearance: { appIcon: icon } } as never).appearance.appIcon, icon)
  assert.equal(store.patchSettings({ appearance: { appIcon: 'neon' } } as never).appearance.appIcon, 'default')
})
