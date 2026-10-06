import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { appIconFile } from '../src/main/appIcon'
import { defaultSettings } from '../src/main/store'

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
