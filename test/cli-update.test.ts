import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The CLI's updater: version order, which tag an install follows, how it
 * was installed (and so what updates it), the background check's caching,
 * and the popup's flow. Nothing here reaches the network or runs npm.
 */

process.env.EAON_CLI_HOME = mkdtempSync(join(tmpdir(), 'eaon-cli-update-'))
delete process.env.CI
delete process.env.EAON_NO_UPDATE_CHECK
delete process.env.NO_UPDATE_NOTIFIER

const update = await import('../cli/src/core/update')
const { UpdateModal } = await import('../cli/src/tui/update')

test('versions: semver order with prereleases', () => {
  const { compareVersions } = update
  const ordered = ['0.1.0-beta.1', '0.1.0-beta.2', '0.1.0-beta.10', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0-beta.1', '1.0.0']
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(compareVersions(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`)
    assert.equal(compareVersions(ordered[i + 1], ordered[i]), 1)
  }
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2.3+build.5', '1.2.3'), 0)
})

test('channels: a beta follows beta and latest; a stable version only latest', () => {
  const { newerVersion } = update
  assert.equal(newerVersion('0.1.0-beta.1', { latest: '0.1.0-beta.1' }), null)
  assert.equal(newerVersion('0.1.0-beta.1', { latest: '0.1.0-beta.1', beta: '0.1.0-beta.3' }), '0.1.0-beta.3')
  assert.equal(newerVersion('0.1.0-beta.3', { latest: '0.1.0', beta: '0.1.0-beta.3' }), '0.1.0', 'the release beats the beta it came from')
  assert.equal(newerVersion('0.1.0', { latest: '0.1.0', beta: '0.2.0-beta.1' }), null, 'stable installs don’t get betas')
  assert.equal(newerVersion('0.1.0', { latest: '0.1.1' }), '0.1.1')
  assert.equal(newerVersion('0.1.0', { latest: 'garbage' }), null)
})

test('installs: the package manager and prefix come from where the bundle runs', () => {
  const { detectInstall, updateCommand, manualUpdate } = update
  const mac = detectInstall('/opt/homebrew/lib/node_modules/eaon/eaon.mjs', 'darwin')
  assert.deepEqual(mac, { kind: 'npm', prefix: '/opt/homebrew', dir: '/opt/homebrew/lib/node_modules/eaon' })
  assert.deepEqual(updateCommand(mac, '0.1.0-beta.2', {}), { command: 'npm', args: ['install', '--global', '--prefix', '/opt/homebrew', 'eaon@0.1.0-beta.2'] })
  const nvm = detectInstall('/home/ada/.nvm/versions/node/v22.11.0/lib/node_modules/eaon/eaon.mjs', 'linux')
  assert.equal(nvm.prefix, '/home/ada/.nvm/versions/node/v22.11.0')
  const win = detectInstall('C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\eaon\\eaon.mjs', 'win32')
  assert.deepEqual(win, { kind: 'npm', prefix: 'C:\\Users\\Ada\\AppData\\Roaming\\npm', dir: 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\eaon' })
  assert.match(manualUpdate(win, '1.0.0'), /^npm install --global --prefix C:\\Users\\Ada\\AppData\\Roaming\\npm eaon@1\.0\.0$/)
  assert.equal(detectInstall('/home/ada/.npm/_npx/1a2b/node_modules/eaon/eaon.mjs', 'linux').kind, 'npx')
  assert.equal(detectInstall('/home/ada/.bun/install/global/node_modules/eaon/eaon.mjs', 'linux').kind, 'bun')
  assert.equal(detectInstall('/home/ada/.local/share/pnpm/global/5/node_modules/eaon/eaon.mjs', 'linux').kind, 'pnpm')
  assert.equal(detectInstall('/Users/ada/src/eaon-desktop/out/cli/eaon.mjs', 'darwin').kind, 'source')
  assert.equal(updateCommand({ kind: 'source' }, '1.0.0'), null)
  // A mirror (or a test registry) is used for the install too.
  assert.deepEqual(updateCommand(mac, '1.0.0', { EAON_UPDATE_REGISTRY: 'http://127.0.0.1:4873/' })!.args, ['install', '--global', '--prefix', '/opt/homebrew', '--registry', 'http://127.0.0.1:4873', 'eaon@1.0.0'])
})

test('check: asks the registry at most every few hours, remembers the tags, and stays off in CI', async () => {
  const { checkForUpdate, readUpdateState, knownUpdate } = update
  let asked = 0
  const fetchImpl = (async (url: string) => {
    asked++
    assert.match(String(url), /\/-\/package\/eaon\/dist-tags$/)
    return new Response(JSON.stringify({ latest: '0.1.0-beta.1', beta: '0.1.0-beta.2' }), { status: 200 })
  }) as typeof fetch
  const t0 = Date.parse('2026-10-05T12:00:00Z')
  assert.deepEqual(await checkForUpdate({ now: t0, current: '0.1.0-beta.1', fetchImpl }), { current: '0.1.0-beta.1', latest: '0.1.0-beta.2' })
  assert.equal(asked, 1)
  assert.equal(readUpdateState().tags.beta, '0.1.0-beta.2')
  // An hour later it answers from what it knows.
  assert.deepEqual(await checkForUpdate({ now: t0 + 3_600_000, current: '0.1.0-beta.1', fetchImpl }), { current: '0.1.0-beta.1', latest: '0.1.0-beta.2' })
  assert.equal(asked, 1)
  assert.equal(knownUpdate('0.1.0-beta.1'), '0.1.0-beta.2')
  assert.equal(knownUpdate('0.1.0-beta.2'), null)
  // Offline: what was known stays, and it tries again within the hour rather than at once.
  const offline = (async () => {
    asked++
    throw new Error('offline')
  }) as typeof fetch
  await checkForUpdate({ now: t0 + 7 * 3_600_000, current: '0.1.0-beta.1', fetchImpl: offline })
  assert.equal(asked, 2)
  assert.equal(readUpdateState().tags.beta, '0.1.0-beta.2')
  await checkForUpdate({ now: t0 + 7 * 3_600_000 + 60_000, current: '0.1.0-beta.1', fetchImpl: offline })
  assert.equal(asked, 2)
  process.env.CI = '1'
  assert.equal(await checkForUpdate({ force: true, current: '0.1.0-beta.1', fetchImpl }), null)
  assert.equal(asked, 2)
  delete process.env.CI
})

test('popup: later and skip are remembered; ⏎ installs and then offers to quit; failures say what to do', async () => {
  const { shouldOffer, saveUpdateState } = update
  saveUpdateState({ checkedAt: Date.now(), tags: { latest: '0.1.0-beta.2' } })
  const toasts: string[] = []
  let quit = 0
  let installedAs: string | null = null
  const host = {
    invalidate() {},
    toast: (t: string) => void toasts.push(t),
    quit: async () => void quit++,
    ownsEngines: () => true,
    onInstalled: (v: string) => void (installedAs = v)
  }
  const offer = { current: '0.1.0-beta.1', latest: '0.1.0-beta.2' }
  const install = { kind: 'npm' as const, prefix: '/usr/local', dir: '/usr/local/lib/node_modules/eaon' }
  const settle = async (): Promise<void> => new Promise((r) => setTimeout(r, 750))
  const key = (modal: InstanceType<typeof UpdateModal>, name: string, ch?: string): void => modal.onEvent({ type: 'key', name, ch, ctrl: false, meta: false, shift: false } as never)
  const { Screen } = await import('../cli/src/tui/screen')
  const draw = (modal: InstanceType<typeof UpdateModal>): string => Screen.snapshot(100, 30, (c) => modal.draw(c)).text

  // What it says.
  const asking = draw(new UpdateModal(host, offer, { install }))
  assert.match(asking, /Eaon CLI 0\.1\.0-beta\.2 is out\. You have 0\.1\.0-beta\.1\./)
  assert.match(asking, /npm install --global --prefix \/usr\/local eaon@0\.1\.0-beta\.2/)
  assert.match(asking, /update now/)
  assert.match(asking, /skip this version/)

  // Later: not offered again today.
  let closed = 0
  const later = new UpdateModal(host, offer, { install, run: async () => ({ ok: true, installed: '0.1.0-beta.2', output: '' }) })
  later.close = () => void closed++
  ;(later as unknown as { shownAt: number }).shownAt = Date.now()
  key(later, 'l', 'l')
  assert.equal(closed, 0, 'keys typed as it appears are ignored')
  await settle()
  key(later, 'l', 'l')
  assert.equal(closed, 1)
  assert.equal(shouldOffer('0.1.0-beta.2'), false)
  assert.equal(shouldOffer('0.1.0-beta.2', Date.now() + 25 * 3_600_000), true)

  // Skip: never this version, but the next one is offered.
  saveUpdateState({ checkedAt: Date.now(), tags: { latest: '0.1.0-beta.2' } })
  const skip = new UpdateModal(host, offer, { install })
  skip.close = () => {}
  ;(skip as unknown as { shownAt: number }).shownAt = Date.now() - 1000
  key(skip, 's', 's')
  assert.equal(shouldOffer('0.1.0-beta.2', Date.now() + 30 * 3_600_000), false)
  assert.equal(shouldOffer('0.1.0-beta.3'), true)

  // Update now: runs the installer for that version, then offers to quit.
  const ran: string[] = []
  const now = new UpdateModal(host, offer, {
    install,
    run: async (version, onOutput) => {
      ran.push(version)
      onOutput?.('added 2 packages in 3s')
      return { ok: true, installed: version, output: 'added 2 packages in 3s' }
    }
  })
  now.close = () => {}
  ;(now as unknown as { shownAt: number }).shownAt = Date.now() - 1000
  key(now, 'enter')
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(ran, ['0.1.0-beta.2'])
  assert.equal(now.installed, true)
  assert.equal(installedAs, '0.1.0-beta.2')
  assert.match(draw(now), /Eaon CLI 0\.1\.0-beta\.2 is installed/)
  assert.match(draw(now), /quit now/)
  assert.equal(shouldOffer('0.1.0-beta.2'), true, 'an update clears skip and later')
  key(now, 'q', 'q')
  assert.equal(quit, 1)

  // A failure keeps the hint and can be tried again.
  let tries = 0
  const failing = new UpdateModal(host, offer, {
    install,
    run: async () => {
      tries++
      return { ok: false, installed: '0.1.0-beta.1', output: 'npm error code EACCES', hint: 'npm couldn’t write to /usr/local. Run it yourself with sudo:', command: 'sudo npm install --global --prefix /usr/local eaon@0.1.0-beta.2' }
    }
  })
  failing.close = () => {}
  ;(failing as unknown as { shownAt: number }).shownAt = Date.now() - 1000
  key(failing, 'enter')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(failing.installed, false)
  const failed = draw(failing)
  assert.match(failed, /npm couldn’t write to \/usr\/local\. Run it yourself with sudo:/)
  assert.match(failed, /│\s+sudo npm install --global --prefix \/usr\/local eaon@0\.1\.0-beta\.2\s/, 'the command gets a line of its own')
  key(failing, 'enter')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(tries, 2)

  // A source checkout is told how, never run.
  const source = new UpdateModal(host, offer, { install: { kind: 'source' }, run: async () => assert.fail('a source checkout isn’t updated by npm') })
  source.close = () => {}
  ;(source as unknown as { shownAt: number }).shownAt = Date.now() - 1000
  assert.equal(source.managed, false)
  key(source, 'enter')
})

test('runUpdate: streams the package manager’s output and reads the installed version back', async () => {
  const { runUpdate } = update
  const { EventEmitter } = await import('node:events')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const dir = join(process.env.EAON_CLI_HOME!, 'prefix', 'lib', 'node_modules', 'eaon')
  mkdirSync(dir, { recursive: true })
  const calls: { command: string; args: string[] }[] = []
  const fakeSpawn = (command: string, args: string[]) => {
    calls.push({ command, args })
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('changed 1 package in 2s\n'))
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'eaon', version: '0.1.0-beta.2' }))
      child.emit('close', 0)
    }, 5)
    return child as never
  }
  const lines: string[] = []
  const result = await runUpdate('0.1.0-beta.2', (l) => lines.push(l), { kind: 'npm', prefix: join(process.env.EAON_CLI_HOME!, 'prefix'), dir }, fakeSpawn)
  assert.equal(result.ok, true)
  assert.equal(result.installed, '0.1.0-beta.2')
  assert.deepEqual(lines, ['changed 1 package in 2s'])
  assert.equal(calls[0].command, 'npm')
  assert.deepEqual(calls[0].args.slice(-1), ['eaon@0.1.0-beta.2'])

  const denied = await runUpdate('0.1.0-beta.2', () => {}, { kind: 'npm', prefix: '/usr/local', dir }, ((() => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setTimeout(() => {
      child.stderr.emit('data', Buffer.from('npm error code EACCES\nnpm error syscall rename\n'))
      child.emit('close', 243)
    }, 5)
    return child
  }) as never))
  assert.equal(denied.ok, false)
  assert.match(denied.hint!, /couldn’t write to \/usr\/local/)
  assert.equal(denied.command, 'sudo npm install --global --prefix /usr/local eaon@0.1.0-beta.2')
})
