/**
 * Codex accounts in the real app: the ADE's usage meter lists every Codex
 * account with its limits and when each resets, switching is one click, and
 * Eaon's own Codex engine follows the switch; Settings → Accounts shows the
 * same figures with their reset times.
 *
 * Both accounts are folders in the scenario's scratch space, answered by the
 * fake Codex (test/fixtures/fake-codex.mjs), which keeps a login per
 * CODEX_HOME. EAON_CODEX_BIN and EAON_CLAUDE_BIN pin the CLIs, so no real
 * Claude Code or Codex is ever found or run.
 */
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenario } from './fixtures.mjs'

const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url))

/** The fake Codex beside the scenario's home (which launch empties), and a folder per account. */
function setup(s) {
  const base = join(dirname(s.homeDir), 'codex-accounts')
  const bin = join(base, 'bin', 'codex')
  mkdirSync(dirname(bin), { recursive: true })
  copyFileSync(FAKE_CODEX, bin)
  chmodSync(bin, 0o755)
  const state = join(base, 'state')
  mkdirSync(state, { recursive: true })
  const folder = (name, account) => {
    const dir = join(base, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'fake-account.json'), JSON.stringify(account))
    return dir
  }
  const personal = folder('personal', { plan: 'plus', email: 'alex@example.com', usedPercent: 34 })
  const work = folder('work', { plan: 'pro', email: 'work@example.com', usedPercent: 12 })
  return { env: { EAON_CODEX_BIN: bin, EAON_CLAUDE_BIN: 'none', FAKE_CODEX_STATE: state, CODEX_HOME: personal }, work }
}

scenario('Accounts: every Codex account’s limits in the usage meter, one click to switch, and Codex chats follow', { timeout: 150_000 }, async (s) => {
  const { env, work } = setup(s)
  const accounts = {
    tools: {
      codex: {
        active: 'default',
        accounts: [
          { id: 'default', dir: null, label: '', email: null, plan: null, addedAt: 0 },
          { id: 'work1', dir: work, label: 'Work', email: null, plan: null, addedAt: 1 }
        ]
      }
    }
  }
  const app = await s.launch({ env, seed: { 'cli-accounts.json': accounts } })
  const page = app.page
  const ade = (await page.eval(() => window.api.workspaces.get())).find((w) => w.kind === 'code')
  await page.eval((id) => window.api.settings.patch({ activeWorkspaceId: id }), ade.id)
  await page.reload()

  // The pill: the account in use, as Codex reports it.
  await page.waitFor(() => /34%/.test(document.querySelector('.usage-pill')?.textContent ?? ''), { message: 'the meter to show the personal account’s session', timeout: 40_000 })
  await page.click('.usage-pill')
  const work1 = await page.waitFor(
    () => {
      const card = [...document.querySelectorAll('.usage-panel .usage-account')].find((c) => /Work/.test(c.textContent ?? ''))
      return card && /12%/.test(card.textContent ?? '') ? card.textContent : null
    },
    { message: 'the other account, with its figures', timeout: 40_000 }
  )
  s.t.diagnostic(`other account: ${work1}`)
  assert.match(work1, /Session/)
  assert.match(work1, /\dh \d+m/, 'with when it resets')
  const inUse = await page.eval(() => document.querySelector('.usage-panel .usage-tool__active')?.textContent ?? '')
  assert.match(inUse, /alex@example\.com/)
  assert.match(inUse, /In use/)
  await s.shot(page, 'meter-switcher')

  // One click: Work is the account in use, for the meter and for Eaon's Codex.
  await page.click('.usage-panel .usage-account', { text: /Work/ })
  await page.waitFor(async () => (await window.api.cliAccounts.state()).tools.codex.active === 'work1', { message: 'the switch' })
  await page.waitFor(() => /Work/.test(document.querySelector('.usage-panel .usage-tool__active')?.textContent ?? ''), { message: 'Work shown as in use' })
  await page.waitFor(() => /12%/.test(document.querySelector('.usage-pill')?.textContent ?? ''), { message: 'the pill to follow' })
  await s.shot(page, 'meter-switched')
  const plan = await page.waitFor(
    async () => {
      const codex = (await window.api.engines.refresh()).find((e) => e.id === 'codex')
      return codex?.auth.plan === 'Pro' ? codex.auth.plan : null
    },
    { message: 'Eaon’s Codex engine to run as the Work account', timeout: 30_000 }
  )
  assert.equal(plan, 'Pro')

  // Settings → Accounts: both accounts, each limit with its reset time.
  await page.click('.usage-panel .usage-panel__settings', { text: /Manage accounts/ })
  const rows = await page.waitFor(
    () => {
      const lines = [...document.querySelectorAll('.account-row__window')].map((r) => r.textContent ?? '')
      return lines.length >= 2 ? lines : null
    },
    { message: 'each account’s limits in Settings', timeout: 30_000 }
  )
  s.t.diagnostic(`settings rows: ${JSON.stringify(rows)}`)
  assert.ok(rows.every((r) => /resets in \dh \d+m/.test(r)), 'every limit says when it resets')
  await s.shot(page, 'settings-accounts')
  assert.deepEqual(app.pageErrors().filter((e) => /exception/i.test(e)), [])
})
