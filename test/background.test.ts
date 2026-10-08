import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_FLAG, backgroundCommand, launchAgentPlist, launchedInBackground, LAUNCH_AGENT_LABEL } from '../src/main/background'

/** How Eaon asks the OS to start it at login, without a window, for scheduled tasks. */

test('a packaged app starts itself; a dev build starts Electron with its absolute entry script', () => {
  assert.deepEqual(backgroundCommand(['/App/Eaon'], '/App/Eaon', true), ['/App/Eaon', BACKGROUND_FLAG])
  const dev = backgroundCommand(['/x/electron', 'out/main/index.js'], '/x/electron', false)
  assert.equal(dev[0], '/x/electron')
  assert.ok(dev[1].startsWith('/') && dev[1].endsWith('out/main/index.js'), 'relative script made absolute for launchd')
  assert.equal(dev[2], BACKGROUND_FLAG)
})

test('a test profile stays a test profile', () => {
  const command = backgroundCommand(['/App/Eaon', '--user-data-dir=/tmp/profile'], '/App/Eaon', true)
  assert.deepEqual(command, ['/App/Eaon', BACKGROUND_FLAG, '--user-data-dir=/tmp/profile'])
  assert.equal(launchedInBackground(command), true)
  assert.equal(launchedInBackground(['/App/Eaon']), false)
})

test('the LaunchAgent escapes its arguments and runs once at login', () => {
  const plist = launchAgentPlist(['/Applications/Eaon & Co.app/Contents/MacOS/Eaon', BACKGROUND_FLAG])
  assert.match(plist, new RegExp(`<string>${LAUNCH_AGENT_LABEL}</string>`))
  assert.match(plist, /Eaon &amp; Co\.app/)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/)
})

test('the LaunchAgent is a property list macOS accepts', { skip: process.platform !== 'darwin' }, () => {
  const path = join(mkdtempSync(join(tmpdir(), 'eaon-plist-')), 'agent.plist')
  writeFileSync(path, launchAgentPlist(['/Applications/Eaon.app/Contents/MacOS/Eaon', BACKGROUND_FLAG, '--user-data-dir=/a b/<c>']))
  assert.match(execFileSync('plutil', ['-lint', path]).toString(), /OK/)
  const parsed = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path]).toString())
  assert.deepEqual(parsed.ProgramArguments, ['/Applications/Eaon.app/Contents/MacOS/Eaon', BACKGROUND_FLAG, '--user-data-dir=/a b/<c>'])
})

test('the agent bundled for SMAppService starts this app in the background, attributed to Eaon', async () => {
  const { readFileSync } = await import('node:fs')
  const { AGENT_SERVICE } = await import('../src/main/background')
  const { join } = await import('node:path')
  const plist = readFileSync(join(process.cwd(), 'resources', 'mac', 'LaunchAgents', AGENT_SERVICE), 'utf8')
  assert.match(plist, new RegExp(`<key>Label</key>\\s*<string>${LAUNCH_AGENT_LABEL}</string>`))
  // Relative to the app bundle, wherever the app is moved; the flag skips the window.
  assert.match(plist, /<key>BundleProgram<\/key>\s*<string>Contents\/MacOS\/Eaon<\/string>/)
  assert.match(plist, new RegExp(`<string>${BACKGROUND_FLAG}</string>`))
  assert.match(plist, /<key>AssociatedBundleIdentifiers<\/key>\s*<string>dev\.eaon\.desktop<\/string>/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/)
  // A development build's file names the app it belongs to too.
  assert.match(launchAgentPlist(['/x/Electron', BACKGROUND_FLAG]), /<key>AssociatedBundleIdentifiers<\/key>\s*<string>dev\.eaon\.desktop<\/string>/)
})
