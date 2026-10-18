import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildGuestLaunch, bwrapArgs, checkGuestRoot, cliPaths, guestRc, guestSandboxSupport, seatbeltProfile } from '../src/main/features/terminals/guestSandbox'

/**
 * Locked terminals for friends (features/terminals/guestSandbox.ts): which
 * folders may be shared, the rules each platform's sandbox gets, and, on a Mac,
 * that the sandbox really holds: a friend can't read your files, write outside
 * the share, leave it, raise privileges, reach the network or see your secrets.
 */

function fixture() {
  // A pretend home with a share inside it and things outside it, all under one
  // temp folder so the checks don't depend on the real home.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guest-sbx-')))
  const home = path.join(base, 'home')
  const root = path.join(home, 'projects', 'shared')
  fs.mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true })
  fs.writeFileSync(path.join(root, 'sub', 'file.txt'), 'inside\n')
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY\n')
  fs.writeFileSync(path.join(home, 'notes.txt'), 'owner secret\n')
  const homes = path.join(base, 'guest-homes')
  return { base, home, root, homes }
}

test('checkGuestRoot refuses the home folder, its parents, system folders and secret folders', () => {
  const f = fixture()
  assert.equal(checkGuestRoot(f.root, { home: f.home }).ok, true)
  assert.match((checkGuestRoot(f.home, { home: f.home }) as { reason: string }).reason, /home folder itself/)
  assert.match((checkGuestRoot(path.dirname(f.home), { home: f.home }) as { reason: string }).reason, /home folder itself/)
  assert.match((checkGuestRoot('/', { home: f.home }) as { reason: string }).reason, /whole disk/)
  assert.match((checkGuestRoot('/usr/bin', { home: f.home }) as { reason: string }).reason, /system folder/)
  assert.match((checkGuestRoot(path.join(f.home, '.ssh'), { home: f.home }) as { reason: string }).reason, /~\/\.ssh/)
  assert.match((checkGuestRoot(path.join(f.root, 'sub', 'file.txt'), { home: f.home }) as { reason: string }).reason, /not a file/)
  assert.match((checkGuestRoot(path.join(f.root, 'missing'), { home: f.home }) as { reason: string }).reason, /isn’t there/)
  // A symlink to a forbidden place is judged by where it points.
  fs.symlinkSync(path.join(f.home, '.ssh'), path.join(f.home, 'innocent'))
  assert.equal(checkGuestRoot(path.join(f.home, 'innocent'), { home: f.home }).ok, false)
})

test('the macOS profile denies by default, refuses privilege tools, and only allows network when asked', () => {
  const off = seatbeltProfile({ network: false, exec: 'shell' })
  assert.match(off, /^\(version 1\)\n\(deny default\)/)
  assert.match(off, /\(deny process-exec [^\n]*"\/usr\/bin\/sudo"/)
  assert.match(off, /"\/usr\/bin\/open"/)
  assert.match(off, /"\/usr\/bin\/security"/)
  assert.match(off, /\(allow file-write\* \(subpath \(param "ROOT"\)\) \(subpath \(param "HOME"\)\)\)/)
  assert.doesNotMatch(off, /network-outbound/)
  assert.doesNotMatch(off, /\/Users/)
  // The refusals come after the folders that would allow them: SBPL takes the last match.
  assert.ok(off.indexOf('(deny process-exec') > off.indexOf('(allow process-exec'))
  const on = seatbeltProfile({ network: true, exec: ['/opt/x/cli'] })
  assert.match(on, /\(allow network-outbound\)/)
  assert.match(on, /\(allow process-exec \(subpath "\/opt\/x\/cli"\)\)/)
  assert.doesNotMatch(on, /"\/usr\/bin"\)/)
})

test('bubblewrap gets a fresh namespace with only the share, the home and the system read-only', () => {
  const args = bwrapArgs({ root: '/home/me/p', home: '/home/me/.eaon/g/1', network: false })
  assert.ok(args.includes('--unshare-all'))
  assert.ok(!args.includes('--share-net'))
  assert.ok(args.includes('--clearenv'))
  assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL'])
  assert.ok(args.join(' ').includes('--bind /home/me/p /home/me/p'))
  assert.ok(!args.join(' ').includes('--bind /home/me /home/me '))
  assert.equal(args.at(-1), '--')
  assert.ok(bwrapArgs({ root: '/r', home: '/h', network: true }).includes('--share-net'))
})

test('guest terminals are refused where there is no sandbox', () => {
  assert.equal(guestSandboxSupport('win32').ok, false)
  assert.equal(guestSandboxSupport('linux', () => null).ok, false)
  assert.equal(guestSandboxSupport('linux', () => '/usr/bin/bwrap').ok, true)
})

test('the friend’s shell starts in the share and its cd refuses to leave', () => {
  const rc = guestRc("/tmp/it's here", 'demo', 'zsh')
  assert.match(rc, /export SHARE_ROOT='\/tmp\/it'\\''s here'/)
  assert.match(rc, /outside the shared folder/)
  assert.match(rc, /unset HISTFILE/)
})

test('cliPaths takes in the whole npm package and the runtime its first line names', () => {
  const f = fixture()
  const pkg = path.join(f.base, 'lib', 'node_modules', '@acme', 'cli')
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'bin', 'cli.js'), '#!/usr/bin/env node\n')
  fs.chmodSync(path.join(pkg, 'bin', 'cli.js'), 0o755)
  const paths = cliPaths(path.join(pkg, 'bin', 'cli.js'))
  assert.ok(paths.read.includes(pkg))
  assert.ok(paths.exec.includes('/usr/bin/env'))
})

/* --------------------------------------------- the real sandbox, on a Mac */

const onMac = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')

function runShell(f: ReturnType<typeof fixture>, script: string, network = false) {
  const launch = buildGuestLaunch({ id: 'test-shell', root: f.root, mode: 'shell', network, label: 'shared' }, { homesDir: f.homes, platform: 'darwin' })
  // checkGuestRoot ran against the real home here; the fixture lives in tmp, which is fine for the sandbox itself.
  const r = spawnSync(launch.bin, launch.argv, { cwd: launch.cwd, env: { ...launch.env }, input: script, encoding: 'utf8', timeout: 20_000 })
  return { out: `${r.stdout}\n${r.stderr}`, launch }
}

test('on a Mac, a guest shell stays inside the shared folder', { skip: !onMac }, () => {
  const f = fixture()
  // The real home check would refuse a temp folder as a system folder, so the
  // launch is built against a share under the real home instead.
  const realRoot = fs.mkdtempSync(path.join(os.homedir(), '.eaon-guest-test-'))
  try {
    fs.mkdirSync(path.join(realRoot, 'sub'))
    fs.writeFileSync(path.join(realRoot, 'sub', 'file.txt'), 'inside\n')
    const g = { ...f, root: fs.realpathSync(realRoot) }
    process.env.EAON_TEST_SECRET = 'sk-live-should-not-leak'
    const script = [
      'echo "START $(pwd)"',
      'cd sub && echo "CDSUB_OK" && cd ..',
      'cd .. ; echo "AFTER_CDUP $(pwd)"',
      'cd / ; echo "AFTER_CDROOT $(pwd)"',
      `cat ${f.home}/notes.txt && echo READ_OUTSIDE_LEAK`,
      `cat ${os.homedir()}/.zshrc >/dev/null 2>&1 && echo READ_HOME_LEAK`,
      `ls ${os.homedir()} >/dev/null 2>&1 && echo LIST_HOME_LEAK`,
      `touch ${f.base}/written && echo WRITE_OUTSIDE_LEAK`,
      'touch inside.txt && echo WRITE_INSIDE_OK',
      `ln -s ${os.homedir()} esc 2>/dev/null; ls esc/ >/dev/null 2>&1 && echo SYMLINK_LEAK`,
      'sudo -n true 2>/dev/null && echo SUDO_LEAK',
      'open -a Calculator 2>/dev/null && echo OPEN_LEAK',
      'security find-generic-password -s x >/dev/null 2>&1 && echo KEYCHAIN_LEAK',
      'osascript -e "return 1" >/dev/null 2>&1 && echo OSASCRIPT_LEAK',
      'curl -s -m 5 https://example.com -o /dev/null && echo NETWORK_LEAK',
      'env | grep -q sk-live && echo ENV_LEAK',
      'kill -0 1 2>/dev/null && echo SIGNAL_LEAK',
      'echo "HOME=$HOME"',
      'exit'
    ].join('\n')
    const { out, launch } = runShell(g, script)
    assert.match(out, new RegExp(`START ${g.root}`))
    assert.match(out, /CDSUB_OK/)
    assert.match(out, new RegExp(`AFTER_CDUP ${g.root}\\b`), 'cd .. is refused')
    assert.match(out, new RegExp(`AFTER_CDROOT ${g.root}\\b`), 'cd / is refused')
    assert.match(out, /outside the shared folder/)
    assert.match(out, /WRITE_INSIDE_OK/)
    for (const leak of ['READ_OUTSIDE_LEAK', 'READ_HOME_LEAK', 'LIST_HOME_LEAK', 'WRITE_OUTSIDE_LEAK', 'SYMLINK_LEAK', 'SUDO_LEAK', 'OPEN_LEAK', 'KEYCHAIN_LEAK', 'OSASCRIPT_LEAK', 'NETWORK_LEAK', 'ENV_LEAK', 'SIGNAL_LEAK']) {
      assert.doesNotMatch(out, new RegExp(leak), leak)
    }
    assert.match(out, new RegExp(`HOME=${launch.home}`))
    assert.equal(fs.existsSync(path.join(f.base, 'written')), false)
  } finally {
    delete process.env.EAON_TEST_SECRET
    fs.rmSync(realRoot, { recursive: true, force: true })
  }
})

test('on a Mac, a guest shell reaches the network only when allowed', { skip: !onMac }, () => {
  const f = fixture()
  const realRoot = fs.mkdtempSync(path.join(os.homedir(), '.eaon-guest-test-'))
  try {
    const g = { ...f, root: fs.realpathSync(realRoot) }
    const { out } = runShell(g, 'curl -s -m 8 -o /dev/null -w "HTTP_%{http_code}\\n" https://example.com\nexit', true)
    assert.match(out, /HTTP_200/)
  } finally {
    fs.rmSync(realRoot, { recursive: true, force: true })
  }
})

test('on a Mac, one-CLI mode can’t start any other program', { skip: !onMac || !process.execPath }, () => {
  const f = fixture()
  const realRoot = fs.mkdtempSync(path.join(os.homedir(), '.eaon-guest-test-'))
  try {
    const root = fs.realpathSync(realRoot)
    fs.writeFileSync(path.join(root, 'readme.md'), 'hello from the share\n')
    // A pretend CLI: an npm-style package whose script tries to escape.
    const pkg = path.join(f.base, 'lib', 'node_modules', 'fakecli')
    fs.mkdirSync(pkg, { recursive: true })
    const cli = path.join(pkg, 'cli.js')
    fs.writeFileSync(
      cli,
      [
        `#!${process.execPath}`,
        "const fs = require('fs'); const cp = require('child_process')",
        "console.log('READ_SHARE', fs.readFileSync('readme.md', 'utf8').trim())",
        `try { fs.readFileSync(${JSON.stringify(path.join(f.home, 'notes.txt'))}); console.log('READ_OUTSIDE_LEAK') } catch { console.log('READ_OUTSIDE_DENIED') }`,
        "try { cp.execFileSync('/bin/ls', ['/']); console.log('EXEC_LEAK') } catch { console.log('EXEC_DENIED') }",
        "try { cp.execFileSync('/bin/zsh', ['-c', 'echo hi']); console.log('SHELL_LEAK') } catch { console.log('SHELL_DENIED') }"
      ].join('\n')
    )
    fs.chmodSync(cli, 0o755)
    const launch = buildGuestLaunch({ id: 'test-cli', root, mode: 'cli', program: cli, network: false, label: 'shared' }, { homesDir: f.homes, platform: 'darwin' })
    const r = spawnSync(launch.bin, launch.argv, { cwd: launch.cwd, env: launch.env, encoding: 'utf8', timeout: 20_000 })
    const out = `${r.stdout}\n${r.stderr}`
    assert.match(out, /READ_SHARE hello from the share/)
    assert.match(out, /READ_OUTSIDE_DENIED/)
    assert.match(out, /EXEC_DENIED/)
    assert.match(out, /SHELL_DENIED/)
  } finally {
    fs.rmSync(realRoot, { recursive: true, force: true })
  }
})
