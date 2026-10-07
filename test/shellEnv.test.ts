import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { leaveAppImageEnv, loginShellPath } from '../src/main/shellEnv'

/**
 * The login shell's PATH is looked up once at startup, and everything that
 * spawns waits for it, so the lookup has to finish whatever the user's rc
 * files do. Each "shell" here is a script standing in for one.
 */

const dir = mkdtempSync(join(tmpdir(), 'eaon-shell-'))
test.after(() => rmSync(dir, { recursive: true, force: true }))

function fakeShell(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

test('an rc file that waits for input gets none, instead of holding the lookup', { skip: process.platform === 'win32' }, async () => {
  const shell = fakeShell('reads', `read answer\nprintf '__EAON_PATH__/after/read__EAON_PATH__'`)
  assert.equal(await loginShellPath(shell, 3000), '/after/read')
})

test('a background process holding stdout open does not hold the lookup', { skip: process.platform === 'win32' }, async () => {
  const shell = fakeShell('daemon', `sleep 3 &\nprintf '__EAON_PATH__/from/shell__EAON_PATH__'`)
  const started = Date.now()
  assert.equal(await loginShellPath(shell, 300), '/from/shell', 'what was printed before giving up still counts')
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`)
})

test('a shell that never answers is given up on', { skip: process.platform === 'win32' }, async () => {
  const shell = fakeShell('hangs', `trap '' TERM\nsleep 3`)
  const started = Date.now()
  assert.equal(await loginShellPath(shell, 300), null)
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`)
})

test('an AppImage’s own entries leave the environment; the rest, and APPIMAGE itself, stay', () => {
  const env: NodeJS.ProcessEnv = {
    APPIMAGE: '/home/me/Eaon.AppImage',
    APPDIR: '/tmp/.mount_EaonX1/',
    PATH: '/tmp/.mount_EaonX1:/tmp/.mount_EaonX1/usr/sbin:/usr/local/bin:/usr/bin::.',
    LD_LIBRARY_PATH: '/tmp/.mount_EaonX1/usr/lib:',
    XDG_DATA_DIRS: './share/:/tmp/.mount_EaonX1/usr/share:/usr/local/share/:/usr/share/',
    GSETTINGS_SCHEMA_DIR: '/tmp/.mount_EaonX1/usr/share/glib-2.0/schemas',
    HOME: '/home/me'
  }
  leaveAppImageEnv(env)
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin')
  assert.equal(env.XDG_DATA_DIRS, '/usr/local/share/:/usr/share/')
  assert.equal('LD_LIBRARY_PATH' in env, false, 'emptied lists are unset, not left blank')
  assert.equal('GSETTINGS_SCHEMA_DIR' in env, false)
  assert.equal(env.APPIMAGE, '/home/me/Eaon.AppImage')
  assert.equal(env.APPDIR, '/tmp/.mount_EaonX1/')
  assert.equal(env.HOME, '/home/me')

  // Outside an AppImage nothing is touched.
  const plain: NodeJS.ProcessEnv = { PATH: '/usr/bin::.', LD_LIBRARY_PATH: '/opt/lib' }
  leaveAppImageEnv(plain)
  assert.deepEqual(plain, { PATH: '/usr/bin::.', LD_LIBRARY_PATH: '/opt/lib' })
})
