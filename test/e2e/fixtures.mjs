/**
 * The pieces every scenario shares: `scenario()` (a node:test test that owns
 * its apps and fake provider and cleans them up), and the user flows the
 * scenarios are made of — pointing Eaon at the fake model, sending a message,
 * reading the last reply, opening Settings.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { artifactsDir, launchApp } from './harness.mjs'
import { startFakeProvider } from './fakeProvider.mjs'
import { scaled } from './timing.mjs'

export const FAKE_MODEL = 'fake-model'

/** Platform-dependent scenarios say why they skip; nothing is skipped silently. */
export const isMac = process.platform === 'darwin'

/**
 * @typedef {import('./harness.mjs').App} App
 * @typedef {import('./harness.mjs').Page} Page
 * @typedef {import('./fakeProvider.mjs').FakeProvider} FakeProvider
 */

/**
 * Wall-clock time minus monotonic time. The monotonic clock stops while the
 * machine sleeps and the wall clock does not, so this grows by the length of
 * every sleep.
 */
const clockOffset = () => Date.now() - performance.now()

export class Scenario {
  /** @param {string} slug @param {import('node:test').TestContext} t */
  constructor(slug, t) {
    this.slug = slug
    this.t = t
    this.profileDir = join(artifactsDir, 'profiles', slug, 'profile')
    this.homeDir = join(artifactsDir, 'profiles', slug, 'home')
    /** @type {App[]} */
    this.apps = []
    /** @type {FakeProvider | null} */
    this.fakeProvider = null
    this.shots = 0
  }

  /** The scenario's fake model server, started on first use. */
  async fake() {
    this.fakeProvider ??= await startFakeProvider()
    return this.fakeProvider
  }

  /**
   * Launches Eaon on this scenario's profile.
   * @param {Partial<import('./harness.mjs').LaunchOptions>} [options]
   */
  async launch(options = {}) {
    const app = await launchApp({
      name: `${this.slug}-${this.apps.length + 1}`,
      profileDir: this.profileDir,
      homeDir: this.homeDir,
      ...options
    })
    this.apps.push(app)
    await app.page.waitForApp()
    return app
  }

  /** Starts Eaon again on the same profile after a quit or a kill. */
  async relaunch(app, options = {}) {
    const next = await app.relaunch({ name: `${this.slug}-${this.apps.length + 1}`, ...options })
    this.apps.push(next)
    await next.page.waitForApp()
    return next
  }

  /** A numbered screenshot of the key state: `<scenario>-<n>-<label>.png`. */
  async shot(page, label) {
    this.shots += 1
    const path = await page.screenshot(`${this.slug}-${String(this.shots).padStart(2, '0')}-${label}`)
    this.t.diagnostic(path ? `screenshot: ${path}` : `screenshot "${label}" could not be taken: ${page.app.screenshotFailures.at(-1)}`)
    return path
  }

  async captureFailure() {
    for (const app of this.apps) {
      if (!app.running) continue
      for (const page of app.pagesById.values()) {
        await page.screenshot(`${this.slug}-FAILED-${app.name}-${page.cdp.label.split('/').pop()}`).catch(() => undefined)
      }
      this.t.diagnostic(`${app.name} output (last lines):\n${app.tail(25)}`)
      const errors = app.pageErrors()
      if (errors.length) this.t.diagnostic(`${app.name} page errors:\n${errors.slice(0, 15).join('\n')}`)
    }
  }

  /** @returns {Promise<string[]>} orphaned processes */
  async dispose() {
    // Every app first: they share a profile, so one still running would look
    // like another's orphans.
    for (const app of this.apps) await app.terminate()
    const orphans = []
    for (const app of this.apps) orphans.push(...(await app.orphans()))
    await this.fakeProvider?.close()
    if (!process.env.EAON_E2E_KEEP) rmSync(join(artifactsDir, 'profiles', this.slug), { recursive: true, force: true })
    return orphans
  }
}

/**
 * One end-to-end scenario: a node:test test with a timeout, its own profile
 * and HOME, screenshots on failure, and a check that every process it
 * started is gone afterwards.
 *
 * `todo` keeps a test that exposes a known product bug running and visible
 * without failing the suite; its reason says what is wrong.
 *
 * @param {string} name
 * @param {{ timeout?: number, todo?: string, skip?: string | false }} options
 * @param {(s: Scenario) => Promise<void>} fn
 */
export function scenario(name, options, fn) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  test(name, { timeout: scaled(options.timeout ?? 120_000), todo: options.todo, skip: options.skip || undefined }, async (t) => {
    const s = new Scenario(slug, t)
    let failed = false
    const clockAtStart = clockOffset()
    try {
      await fn(s)
    } catch (error) {
      failed = true
      await s.captureFailure().catch(() => undefined)
      // Timers and the wall clock keep going while a laptop sleeps, so a
      // scenario that was asleep "times out" with nothing wrong in the app.
      const slept = clockOffset() - clockAtStart
      if (slept > 5000 && error instanceof Error) {
        error.message = `The computer slept for about ${Math.round(slept / 1000)} s during this scenario, so this failure is not trustworthy. Run it again. ${error.message}`
      }
      throw error
    } finally {
      const orphans = await s.dispose()
      // A failure already explains itself; orphans after a pass are the failure.
      if (orphans.length && !failed) assert.fail(`processes outlived the app:\n${orphans.join('\n')}`)
      else if (orphans.length) t.diagnostic(`orphans (killed): ${orphans.join('; ')}`)
    }
  })
}

/* ------------------------------------------------------------------ flows */

/**
 * Points the keyless LM Studio provider at the fake server and selects its
 * model, the way the smoke tests do: no key, so nothing touches the vault.
 * Waits until the model is really listed (sending before that answers "No
 * model selected"), then reloads so the composer starts from the saved state.
 * @param {Page} page @param {FakeProvider} fake
 */
export async function useFakeModel(page, fake, modelId = FAKE_MODEL) {
  await page.eval(
    async (url, modelId) => {
      await window.api.providers.update('lm-studio', { baseUrl: url, enabled: true })
      await window.api.providers.refreshModels('lm-studio')
      await window.api.settings.patch({ selectedProviderId: 'lm-studio', selectedModelId: modelId })
    },
    fake.url,
    modelId
  )
  await page.waitFor(
    async (modelId) => (await window.api.providers.list()).some((p) => p.id === 'lm-studio' && p.models.some((m) => m.id === modelId)),
    { args: [modelId], message: 'LM Studio to list the fake model' }
  )
  await page.reload()
  await page.waitFor(
    async (modelId) => {
      const model = (await window.api.providers.list()).find((p) => p.id === 'lm-studio')?.models.find((m) => m.id === modelId)
      return Boolean(model) && document.querySelector('.chip__model')?.textContent === model.label
    },
    { args: [modelId], message: 'the composer to show the fake model' }
  )
}

/**
 * Checks no local runtime other than the ones the harness set up can be
 * reached: a new built-in local provider must be added to LOCAL_RUNTIME_IDS.
 * @param {App} app
 */
export async function checkIsolated(app, allowed = /** @type {string[]} */ ([])) {
  const leaks = await app.page.eval(
    async (offline, allowed) =>
      (await window.api.providers.list())
        .filter((p) => p.local && p.id !== 'eaon-local' && !allowed.includes(p.id) && p.baseUrl && !p.baseUrl.includes(`:${offline}`))
        .map((p) => `${p.id} → ${p.baseUrl}`),
    app.offlinePort,
    allowed
  )
  assert.deepEqual(leaks, [], 'a local provider is not isolated by the harness; add its id to LOCAL_RUNTIME_IDS in test/e2e/harness.mjs')
}

/** Types into the chat composer and presses Enter. @param {Page} page */
export async function sendMessage(page, text) {
  await page.click('.composer__input')
  await page.type(text)
  await page.press('Enter')
}

/**
 * Reads the last reply in the open chat as shown, or null if it does not
 * match. Runs in the page. A reply row is any `.msg-row` that is not the
 * user's; an empty one shows only its status ("Thinking", "No response") or
 * its error.
 */
function replyProbe(pattern, streaming, error) {
  const rows = [...document.querySelectorAll('.msg-row')].filter((row) => !row.matches('.msg-user-block, .msg-row--mail'))
  const row = rows.at(-1)
  if (!row) return null
  const body = row.querySelector('.msg--assistant')
  const reply = {
    count: rows.length,
    text: (body?.textContent ?? '').trim(),
    streaming: Boolean(body?.hasAttribute('data-streaming')) || Boolean(row.querySelector('.loading-state, [data-loading]')),
    error: (row.querySelector('.msg__error')?.textContent ?? '').trim(),
    status: (row.querySelector('.msg__status')?.textContent ?? '').trim(),
    all: (row.textContent ?? '').trim().slice(0, 400)
  }
  if (pattern && !new RegExp(pattern.source, pattern.flags).test(reply.text)) return null
  if (streaming !== null && reply.streaming !== streaming) return null
  if (error !== null && Boolean(reply.error) !== error) return null
  return reply
}

/**
 * The last reply in the open chat, as shown.
 * @param {Page} page
 */
export function lastReply(page) {
  return page.eval(replyProbe, null, null, null)
}

/**
 * Waits for the last reply to match: `text` (substring or RegExp), whether
 * it is still streaming, whether it shows an error.
 * @param {Page} page
 * @param {{ text?: string | RegExp, streaming?: boolean, error?: boolean, timeout?: number }} want
 */
export async function waitForReply(page, { text, streaming, error, timeout = 20_000 } = {}) {
  const pattern = text instanceof RegExp ? { source: text.source, flags: text.flags } : text === undefined ? null : { source: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags: '' }
  return page.waitFor(replyProbe, {
    args: [pattern, streaming ?? null, error ?? null],
    timeout,
    message: `the last reply to be ${JSON.stringify({ text: String(text ?? ''), streaming, error })}`
  })
}

/**
 * Opens Settings from the sidebar, then one of its pages by its nav label.
 * (⌘, is a menu accelerator; DevTools key events don't go through the menu.)
 * @param {Page} page
 */
export async function openSettings(page, label) {
  await page.click('.sidebar .nav-item', { text: /^Settings$/ })
  await page.find('.settings__nav')
  if (label) {
    await page.click('.settings__nav .nav-item', { text: new RegExp(`^${label}$`) })
    await page.waitFor((label) => document.querySelector('.settings__h1')?.textContent?.trim() === label, { args: [label], message: `Settings → ${label}` })
  }
}

/** The worker list as main has it. @param {Page} page */
export function workers(page) {
  return page.eval(() => window.api.workers.list())
}
