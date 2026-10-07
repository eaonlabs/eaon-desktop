import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { UpdateStatus } from '@shared/types'
import { compareVersions, isNewerBeta, isPrerelease, UpdateController, type UpdaterLike } from '../src/main/updates'

/**
 * Stable and beta updates are separate tracks (main/updates.ts). The updater
 * is a script here: a check emits what the GitHub feed would have said.
 */

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true
  allowPrerelease = false
  /** What the next check finds: a version, or null for nothing, or an Error. */
  feed: string | null | Error = null
  /** Flags as they were when the check ran, to see what the controller asked for. */
  checks: { autoDownload: boolean; allowPrerelease: boolean }[] = []
  downloads = 0
  installed = 0
  async checkForUpdates(): Promise<void> {
    this.checks.push({ autoDownload: this.autoDownload, allowPrerelease: this.allowPrerelease })
    this.emit('checking-for-update')
    if (this.feed instanceof Error) {
      this.emit('error', this.feed)
      throw this.feed
    }
    if (this.feed === null) return void this.emit('update-not-available', {})
    this.emit('update-available', { version: this.feed })
    // electron-updater's own download when it is allowed to.
    if (this.autoDownload) await this.downloadUpdate()
  }
  async downloadUpdate(): Promise<void> {
    this.downloads++
    this.emit('download-progress', { percent: 41.6 })
    this.emit('update-downloaded', { version: this.feed })
  }
  quitAndInstall(): void {
    this.installed++
  }
}

function setup(version: string, beta = true) {
  const updater = new FakeUpdater()
  const stable: UpdateStatus[] = []
  const betas: UpdateStatus[] = []
  const dialogs: unknown[] = []
  const controller = new UpdateController({
    updater,
    version,
    betaEnabled: () => beta,
    publishStable: (s) => void stable.push(s),
    publishBeta: (s) => void betas.push(s),
    interactiveResult: (r) => void dialogs.push(r)
  })
  controller.attach()
  return { updater, controller, stable, betas, dialogs }
}

test('versions compare the way semver does: a release beats its betas, betas order by number', () => {
  assert.equal(isPrerelease('2026.7.0-beta.1'), true)
  assert.equal(isPrerelease('2026.7.0'), false)
  assert.ok(compareVersions('2026.7.0', '2026.7.0-beta.9') > 0)
  assert.ok(compareVersions('2026.7.0-beta.10', '2026.7.0-beta.2') > 0, 'beta.10 is after beta.2, not before')
  assert.ok(compareVersions('2026.7.0-rc.1', '2026.7.0-beta.5') > 0)
  assert.ok(compareVersions('2026.6.1', '2026.7.0-beta.1') < 0)
  assert.equal(compareVersions('2026.6.1+eaon', '2026.6.1'), 0)
  assert.equal(isNewerBeta('2026.7.0-beta.1', '2026.6.1'), true)
  assert.equal(isNewerBeta('2026.6.1-beta.3', '2026.6.1'), false, 'a beta of the version you have is older than it')
  assert.equal(isNewerBeta('2026.7.0', '2026.6.1'), false, 'a stable release is not a beta')
})

test('a stable check downloads by itself, as it always did, and leaves the beta track alone', async () => {
  const { updater, controller, stable, betas } = setup('2026.6.1')
  updater.feed = '2026.6.2'
  await controller.checkStable()
  assert.deepEqual(updater.checks, [{ autoDownload: true, allowPrerelease: false }])
  assert.deepEqual(stable.map((s) => s.state), ['checking', 'available', 'downloading', 'downloaded'])
  assert.deepEqual(controller.stable, { state: 'downloaded', version: '2026.6.2' })
  assert.deepEqual(betas, [], 'nothing on the beta track')
})

test('a beta check says a newer beta exists but never downloads it, and puts the flags back', async () => {
  const { updater, controller, stable, betas } = setup('2026.6.1')
  updater.feed = '2026.7.0-beta.1'
  await controller.checkBeta()
  assert.deepEqual(updater.checks, [{ autoDownload: false, allowPrerelease: true }], 'asked for prereleases, without downloading')
  assert.equal(updater.downloads, 0)
  assert.deepEqual(controller.beta, { state: 'available', version: '2026.7.0-beta.1' })
  assert.deepEqual(betas.map((s) => s.state), ['checking', 'available'])
  assert.deepEqual(stable, [], 'the stable status did not move')
  assert.deepEqual({ d: updater.autoDownload, p: updater.allowPrerelease }, { d: true, p: false }, 'flags back for the next stable check')
})

test('a stable release that came out after the beta is not offered as a beta', async () => {
  const { updater, controller } = setup('2026.6.1')
  updater.feed = '2026.7.0'
  await controller.checkBeta()
  assert.deepEqual(controller.beta, { state: 'not-available' })
  updater.feed = '2026.6.1-beta.4'
  await controller.checkBeta()
  assert.deepEqual(controller.beta, { state: 'not-available' }, 'nor a beta older than what is installed')
  updater.feed = null
  await controller.checkBeta()
  assert.deepEqual(controller.beta, { state: 'not-available' })
})

test('downloading the beta is the user’s button: it looks again, downloads, and reports on the beta track only', async () => {
  const { updater, controller, stable, betas } = setup('2026.6.1')
  updater.feed = '2026.7.0-beta.2'
  await controller.checkBeta()
  updater.checks.length = 0
  const before = betas.length
  await controller.downloadBeta()
  assert.deepEqual(updater.checks, [{ autoDownload: false, allowPrerelease: true }])
  assert.equal(updater.downloads, 1)
  assert.deepEqual(betas.slice(before).map((s) => s.state), ['downloading', 'downloading', 'downloaded'], 'starts at once, reports progress, ends downloaded')
  assert.deepEqual(betas[before], { state: 'downloading', percent: 0 })
  assert.deepEqual(controller.beta, { state: 'downloaded', version: '2026.7.0-beta.2' })
  assert.deepEqual(stable, [])
})

test('the beta is gone or superseded by a stable release by the time it is downloaded: nothing is installed', async () => {
  const { updater, controller } = setup('2026.6.1')
  updater.feed = '2026.7.0-beta.1'
  await controller.checkBeta()
  updater.feed = '2026.7.0' // released in between
  await controller.downloadBeta()
  assert.equal(updater.downloads, 0)
  assert.deepEqual(controller.beta, { state: 'not-available' })
})

test('a stable update on its way is not replaced by a beta download', async () => {
  const { updater, controller } = setup('2026.6.1')
  updater.feed = '2026.7.0-beta.1'
  await controller.checkBeta()
  updater.feed = '2026.6.2'
  await controller.checkStable() // downloads, ready to install
  assert.equal(controller.stable.state, 'downloaded')
  const downloads = updater.downloads
  await controller.downloadBeta()
  assert.equal(updater.downloads, downloads, 'no second download over it')
  assert.equal(controller.beta.state, 'error')
  assert.match((controller.beta as { message: string }).message, /Restart to install it first/)
  assert.equal(controller.stable.state, 'downloaded', 'the stable update is still ready')
})

test('beta failures stay on the beta track: no stable error, no dialog', async () => {
  const { updater, controller, stable, dialogs } = setup('2026.6.1')
  updater.feed = new Error('offline')
  await assert.doesNotReject(controller.checkBeta())
  assert.deepEqual(controller.beta, { state: 'error', message: 'offline' })
  assert.deepEqual(stable, [])
  assert.deepEqual(dialogs, [])
})

test('a stable check the user asked for answers with a dialog; a background one does not', async () => {
  const { updater, controller, dialogs } = setup('2026.6.1')
  await controller.checkStable()
  assert.deepEqual(dialogs, [])
  await controller.checkStable({ interactive: true })
  assert.deepEqual(dialogs, [{ kind: 'up-to-date' }])
  updater.feed = new Error('no network')
  await controller.checkStable({ interactive: true })
  assert.deepEqual(dialogs[1], { kind: 'error', message: 'no network' })
  await controller.checkStable()
  assert.equal(dialogs.length, 2, 'the next background failure stays quiet')
})

test('only one job at a time: a check during a download is ignored', async () => {
  const { updater, controller } = setup('2026.6.1')
  updater.feed = '2026.6.2'
  const first = controller.checkStable()
  await controller.checkStable()
  await controller.checkBeta()
  await first
  assert.equal(updater.checks.length, 1)
})

test('with beta updates off there is nothing to look for, and what was found is forgotten', async () => {
  const off = setup('2026.6.1', false)
  off.updater.feed = '2026.7.0-beta.1'
  await off.controller.checkBeta()
  assert.equal(off.updater.checks.length, 0)

  const on = setup('2026.6.1')
  on.updater.feed = '2026.7.0-beta.1'
  await on.controller.checkBeta()
  on.controller.clearBeta()
  assert.deepEqual(on.controller.beta, { state: 'idle' })
  await on.controller.checkBeta()
  await on.controller.downloadBeta()
  on.controller.clearBeta()
  assert.equal(on.controller.beta.state, 'downloaded', 'a downloaded beta is not thrown away by the switch')
})

test('a beta build already follows betas and stable releases, so it has no separate beta track', async () => {
  const { updater, controller, betas } = setup('2026.7.0-beta.1')
  updater.feed = '2026.7.0-beta.2'
  await controller.checkBeta()
  assert.equal(updater.checks.length, 0)
  assert.deepEqual(betas, [])
  await controller.checkStable()
  assert.deepEqual(updater.checks, [{ autoDownload: true, allowPrerelease: true }], 'its normal check sees prereleases')
  assert.equal(controller.stable.state, 'downloaded')
})

test('Switch to stable on a beta: the latest stable release, older or not, shown as the update, and no beta afterwards', async () => {
  const { updater, controller, stable } = setup('2026.6.2-beta.6')
  const flags = updater as FakeUpdater & { channel?: string | null; allowDowngrade?: boolean }
  updater.feed = '2026.6.0'
  await controller.switchToStable()
  assert.deepEqual(updater.checks, [{ autoDownload: true, allowPrerelease: false }], 'prereleases off for the check')
  assert.equal(flags.channel, 'latest')
  assert.equal(flags.allowDowngrade, true, 'going back to an older version is the point')
  assert.deepEqual(stable.map((s) => s.state), ['checking', 'available', 'downloading', 'downloaded'], 'its progress shows like any update')
  assert.deepEqual(controller.stable, { state: 'downloaded', version: '2026.6.0' })

  // The background check that comes later must not swap a beta back in.
  updater.feed = null
  await controller.checkStable()
  assert.deepEqual(updater.checks.at(-1), { autoDownload: true, allowPrerelease: false })
})

test('Switch to stable is refused on a stable build, and while a check is running', async () => {
  const onStable = setup('2026.6.0')
  await assert.rejects(onStable.controller.switchToStable(), /isn’t a beta build/)
  assert.deepEqual(onStable.updater.checks, [])

  const { updater, controller } = setup('2026.6.2-beta.6')
  updater.feed = '2026.6.2-beta.7'
  const running = controller.checkStable()
  await assert.rejects(controller.switchToStable(), /checking for updates right now/)
  await running
})
