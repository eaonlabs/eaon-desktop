/**
 * Claude Agent, live: Chat and a worker each run a turn on the user's own
 * signed-in Claude Code through Anthropic's Agent SDK, and each uses one of
 * Eaon's tools (read_file) to answer. Nothing here is faked.
 *
 * Skipped unless EAON_E2E_CLAUDE_LIVE=1, because it needs Claude Code
 * installed and signed in with a Claude plan, and it uses a little of that
 * plan (Haiku, two short turns). Claude Code keeps its sign-in under the real
 * HOME (the keychain entry is tied to it), so this scenario runs Eaon with the
 * real HOME instead of the scenario's own; the profile is still its own. The
 * worker's folder it creates under ~/Eaon/Workers is removed afterwards.
 *
 *   EAON_E2E_CLAUDE_LIVE=1 npm run test:e2e -- claudeAgentLive
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { scenario, waitForReply, workers } from './fixtures.mjs'

const live = process.env.EAON_E2E_CLAUDE_LIVE === '1'
const MODEL = process.env.EAON_E2E_CLAUDE_MODEL || 'haiku'
const WORKER = `Clara ${randomBytes(2).toString('hex')}`

/** The Claude Agent provider as main has it. @param {import('./harness.mjs').Page} page */
const claudeAgent = (page) => page.eval(async () => (await window.api.providers.list()).find((p) => p.id === 'claude-agent'))

scenario(
  'Claude Agent, live: Chat and a worker answer on the Claude plan, using Eaon’s tools',
  { timeout: 300_000, skip: live ? false : 'needs a signed-in Claude Code; set EAON_E2E_CLAUDE_LIVE=1' },
  async (s) => {
    const secret = randomBytes(6).toString('hex')
    const file = join(homedir(), 'Eaon', `claude-agent-check-${secret}.txt`)
    writeFileSync(file, `The code word is ${secret}.\n`)
    /** The worker's own folder, as Eaon named it (not always its name). */
    let folder = null
    try {
      const app = await s.launch({ env: { HOME: homedir() } })
      const page = app.page

      // Claude Code's own list for this account, read once Eaon has seen it signed in.
      await page.eval(() => window.api.providers.refreshModels('claude-agent'))
      await page.waitFor(async (model) => (await window.api.providers.list()).find((p) => p.id === 'claude-agent')?.models.some((m) => m.id === model), {
        args: [MODEL],
        timeout: 60_000,
        message: `Claude Agent to list ${MODEL}`
      })
      const provider = await claudeAgent(page)
      assert.equal(provider.enabled, true)

      // ---- Chat ----
      await page.eval((model) => window.api.settings.patch({ selectedProviderId: 'claude-agent', selectedModelId: model, approvalMode: 'auto' }), MODEL)
      await page.reload()
      await page.waitFor(() => /Haiku|Claude/i.test(document.querySelector('.chip__model')?.textContent ?? ''), { message: 'the composer to show the Claude Agent model' })
      await s.shot(page, 'chat-on-claude-agent')
      await page.click('.composer__input')
      await page.type(`Use your read_file tool on ${file} and reply with only the code word in it.`)
      await page.click('.send[aria-label="Send"]')
      await waitForReply(page, { text: secret, streaming: false, timeout: 120_000 })
      await s.shot(page, 'chat-answered')

      // ---- A worker, pinned to the same model ----
      await page.eval(
        (name, model) =>
          window.api.workers.save({
            name,
            color: '#D97757',
            personality: 'Brief.',
            purpose: 'Checks files for the end-to-end suite.',
            engine: 'native',
            model: { providerId: 'claude-agent', modelId: model }
          }),
        WORKER,
        MODEL
      )
      const saved = (await workers(page)).find((w) => w.name === WORKER)
      folder = saved?.folder ?? null
      assert.deepEqual(saved?.model, { providerId: 'claude-agent', modelId: MODEL }, 'the worker keeps its Claude Agent model')
      await page.click('.mode-switch__option', { text: 'Workers' })
      await page.click('.nav-item--worker', { text: WORKER })
      await page.waitFor((name) => document.querySelector('.worker-profile__name')?.textContent?.trim() === name, { args: [WORKER], message: 'the worker’s page' })
      await page.click('.composer__input')
      await page.type(`Read ${file} with your read_file tool and reply with only the code word in it.`)
      await page.click('.send[aria-label="Send"]')
      await waitForReply(page, { text: secret, streaming: false, timeout: 150_000 })
      await s.shot(page, 'worker-answered')
      const ran = (await workers(page)).find((w) => w.name === WORKER)
      assert.notEqual(ran?.status, 'error', `the worker ended in error: ${JSON.stringify(ran?.lastError ?? null)}`)
    } finally {
      rmSync(file, { force: true })
      if (folder && folder.startsWith(join(homedir(), 'Eaon', 'Workers')) && existsSync(folder)) rmSync(folder, { recursive: true, force: true })
    }
  }
)
