import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { externalUrl, lockWebview, openExternalSafely, sameAppPage } from '../src/main/externalLinks'
import { couldRun } from '../src/main/features/library'

/**
 * Links Eaon hands to the operating system: only the web and email leave
 * the app, its window never navigates away, and the browser panel's
 * <webview> can't be given Node or a preload.
 */

test('only web and email links are opened outside Eaon', async () => {
  for (const ok of ['https://example.com/a?b=c', 'http://localhost:1337/docs', 'mailto:hi@example.com']) assert.ok(externalUrl(ok), ok)
  for (const bad of [
    'file:///Applications/Calculator.app',
    'javascript:alert(1)',
    'smb://evil.example/share',
    'zoommtg://zoom.us/join?confno=1',
    'vscode://file/etc/passwd',
    'x-apple.systempreferences:com.apple.preference.security',
    'data:text/html,<script>1</script>',
    'https://',
    '',
    'not a url',
    42
  ]) {
    assert.equal(externalUrl(bad), null, String(bad))
  }
  const opened: string[] = []
  ;(globalThis as { __eaonOpenExternal?: (url: string) => void }).__eaonOpenExternal = (url) => void opened.push(url)
  try {
    await openExternalSafely('https://example.com/')
    await assert.rejects(() => openExternalSafely('file:///etc/passwd'), /only opens web and email links/)
    assert.deepEqual(opened, ['https://example.com/'])
  } finally {
    delete (globalThis as { __eaonOpenExternal?: unknown }).__eaonOpenExternal
  }
})

test("the app's window stays on the app's own page", () => {
  assert.ok(sameAppPage('http://localhost:5173/', 'http://localhost:5173/#/settings'))
  assert.ok(!sameAppPage('http://localhost:5173/', 'https://evil.example/'))
  assert.ok(sameAppPage('file:///Applications/Eaon.app/Contents/Resources/app.asar/out/renderer/index.html', 'file:///Applications/Eaon.app/Contents/Resources/app.asar/out/renderer/index.html#x'))
  assert.ok(!sameAppPage('file:///Applications/Eaon.app/Contents/Resources/app.asar/out/renderer/index.html', 'file:///etc/passwd'))
  assert.ok(!sameAppPage('file:///a/index.html', 'http://a/index.html'))
})

test('a webview gets no Node, no preload and only web pages', () => {
  const prefs: Record<string, unknown> = { preload: '/tmp/evil.js', nodeIntegration: true, contextIsolation: false, sandbox: false }
  assert.equal(lockWebview(prefs, { src: 'https://example.com' }), true)
  assert.deepEqual(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true })
  assert.equal(lockWebview({}, { src: 'file:///etc/passwd' }), false)
  assert.equal(lockWebview({}, { src: 'about:blank' }), true)
})

test('the Library reveals anything that could run instead of opening it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaon-library-'))
  const script = join(dir, 'build-tool')
  writeFileSync(script, '#!/bin/sh\necho hi\n')
  chmodSync(script, 0o755)
  const note = join(dir, 'notes.txt')
  writeFileSync(note, 'hello')
  assert.equal(await couldRun(script), true, 'an executable with no extension runs in Terminal when opened')
  assert.equal(await couldRun(note), false)
  for (const name of ['setup.command', 'Thing.prefPane', 'invoice.js', 'run.vbs', 'app.desktop', 'X.AppImage']) assert.equal(await couldRun(join(dir, name)), true, name)
})
