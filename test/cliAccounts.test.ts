import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_ACCOUNT_ID,
  hasRoom,
  limitAlerts,
  limitNoticeText,
  liveWindow,
  switchTarget,
  usageKey,
  type AccountUsage,
  type AlertMemory,
  type CliAccount,
  type CliTool,
  type LimitNotice,
  type UsageWindow
} from '@shared/cliAccounts'
import { claudeStatus, claudeUsage, codexAccount, codexUsage } from '../src/main/features/cliAccounts/parse'
import { hasRollout, prepareFolder, removeFolder, SHARED } from '../src/main/features/cliAccounts/folders'
import { findCli } from '../src/main/features/cliAccounts/cli'
import { CliAccounts, firstUrl, SLOW_FRESH_MS, stripAnsi, type CliRunner, type LoginProcess } from '../src/main/features/cliAccounts/service'

/**
 * Claude Code and Codex accounts: reading what each CLI says about its plan,
 * the folders extra accounts live in, and switching between them. The CLIs
 * are scripted; the answers are shaped like the real ones (Claude Code
 * 2.1.289's `get_usage`, codex-cli 0.160's `account/rateLimits/read`).
 */

/* -------------------------------------------------------------------- answers */

const CLAUDE_USAGE = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 7, resets_at: '2026-10-08T05:49:59.960876+00:00' },
    seven_day: { utilization: 79, resets_at: '2026-10-10T22:59:59.960902+00:00' },
    limits: [
      { kind: 'session', group: 'session', percent: 7, severity: 'normal', resets_at: '2026-10-08T05:49:59.960876+00:00', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 79, severity: 'warning', resets_at: '2026-10-10T22:59:59.960902+00:00', scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: '2026-10-10T23:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' } } },
      { kind: 'weekly_scoped', group: 'weekly', percent: 12, severity: 'normal', resets_at: '2026-10-10T23:00:00+00:00', scope: { model: { id: null, display_name: 'Opus' } } },
      { kind: 'spend_something_new', group: 'other', percent: 50 }
    ]
  }
}

const CODEX_LIMITS = {
  ordinaryUsageAllowed: true,
  rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 43200, resetsAt: 1792934528 }, secondary: null, planType: 'free' },
  rateLimitsByLimitId: {
    codex: { limitId: 'codex', limitName: null, primary: { usedPercent: 40, windowDurationMins: 43200, resetsAt: 1792934528 }, secondary: null, planType: 'free', rateLimitReachedType: null },
    'gpt-6-spark': { limitId: 'gpt-6-spark', limitName: 'Spark', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1792000000 }, secondary: null, planType: 'free' }
  }
}

test('Claude Code’s usage: its own rows, classified on kind — session, week, a model’s week once used', () => {
  const usage = claudeUsage(CLAUDE_USAGE)
  assert.equal(usage.available, true)
  assert.equal(usage.plan, 'max')
  assert.deepEqual(
    usage.windows.map((w) => [w.id, w.label, w.percent, w.severity]),
    [
      ['session', 'Session', 7, 'normal'],
      ['week', 'Week', 79, 'warning'],
      ['week:Opus', 'Opus week', 12, 'normal'],
      ['spend_something_new:', 'Spend something new', 50, 'normal']
    ]
  )
  assert.equal(usage.windows[0].resetsAt, Date.parse('2026-10-08T05:49:59.960876+00:00'))
})

test('Claude Code on an Enterprise plan: no session or week, but the member’s monthly spend cap, in cents', () => {
  const usage = claudeUsage({
    subscription_type: 'enterprise',
    rate_limits_available: true,
    rate_limits: {
      five_hour: null,
      seven_day: null,
      limits: [],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1240, utilization: 24.8, currency: 'USD' }
    }
  })
  assert.equal(usage.available, true)
  assert.equal(usage.plan, 'enterprise')
  assert.deepEqual(
    usage.windows.map((w) => [w.id, w.label, w.percent, w.severity, w.detail]),
    [['spend', 'Monthly spend', 25, 'normal', '$12.40 of $50.00']]
  )
  // A meter of the plan's own that Eaon has no name for is shown, not dropped.
  const surface = claudeUsage({
    rate_limits_available: true,
    rate_limits: { limits: [{ kind: 'monthly_member', group: 'monthly', percent: 92, severity: 'critical', resets_at: null, scope: { surface: { display_name: 'Claude Code' } } }] }
  })
  assert.deepEqual(
    surface.windows.map((w) => [w.label, w.span, w.percent, w.severity]),
    [['Claude Code', 'this month', 92, 'critical']]
  )
  // No cap set: nothing to measure against.
  assert.deepEqual(claudeUsage({ rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null } } }).windows, [])
})

test('Claude Code: the named windows stand in when there is no list; no limits for an API key', () => {
  const { rate_limits } = CLAUDE_USAGE
  const older = claudeUsage({ rate_limits_available: true, rate_limits: { five_hour: rate_limits.five_hour, seven_day: { utilization: 93, resets_at: null } } })
  assert.deepEqual(
    older.windows.map((w) => [w.id, w.percent, w.severity, w.resetsAt === null]),
    [
      ['session', 7, 'normal', false],
      ['week', 93, 'critical', true]
    ]
  )
  assert.deepEqual(claudeUsage({ rate_limits_available: false, rate_limits: null }), { available: false, plan: null, windows: [] })
  assert.deepEqual(claudeUsage('nonsense').windows, [], 'a reshaped answer costs rows, never the meter')
  assert.deepEqual(claudeStatus({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.co', subscriptionType: 'max' }), { loggedIn: true, email: 'a@b.co', plan: 'max', method: 'claude.ai' })
})

test('Codex’s rate limits: named by window length, the main limit first, a model’s own only once used', () => {
  const usage = codexUsage(CODEX_LIMITS)
  assert.equal(usage.plan, 'free')
  assert.deepEqual(usage.windows.map((w) => [w.id, w.label, w.span, w.percent]), [['month', 'Month', 'rolling 30 days', 40]])
  assert.equal(usage.windows[0].resetsAt, 1792934528 * 1000, 'seconds become ms')
  const plus = codexUsage({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 96, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 2 }, planType: 'plus', rateLimitReachedType: 'primary' }
  })
  assert.deepEqual(
    plus.windows.map((w) => [w.label, w.span, w.percent, w.severity]),
    [
      ['Session', '5 hours', 96, 'critical'],
      ['Week', 'rolling 7 days', 30, 'normal']
    ]
  )
  assert.deepEqual(codexAccount({ account: { type: 'chatgpt', email: 'c@d.co', planType: 'plus' } }), { signedIn: true, chatgpt: true, email: 'c@d.co', plan: 'plus' })
  assert.deepEqual(codexAccount({ account: { type: 'apiKey' } }).chatgpt, false)
  assert.equal(codexAccount({ account: null }).signedIn, false)
})

test('the sign-in page is found in what the CLI printed, colours and all', () => {
  const printed = '\x1b[1mBrowser didn\'t open? Use the url below to sign in:\x1b[0m\r\n\r\n\x1b[2mhttps://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz\x1b[0m\r\n'
  assert.equal(firstUrl(stripAnsi(printed)), 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz')
  assert.equal(firstUrl('Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL:\n\nhttps://auth.openai.com/oauth/authorize?x=1).'), 'https://auth.openai.com/oauth/authorize?x=1')
  assert.equal(firstUrl('nothing yet'), null)
})

/* -------------------------------------------------------------------- folders */

function scratch(): { root: string; home: string; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-cli-accounts-'))
  const home = path.join(base, 'default')
  fs.mkdirSync(path.join(home, 'projects', 'p1'), { recursive: true })
  fs.writeFileSync(path.join(home, 'projects', 'p1', 'session.jsonl'), '{}\n')
  fs.writeFileSync(path.join(home, 'settings.json'), '{"theme":"dark"}')
  fs.writeFileSync(path.join(home, '.credentials.json'), 'the default login')
  fs.writeFileSync(path.join(home, '.claude.json'), '{"oauthAccount":{}}')
  return { root: path.join(base, 'accounts'), home, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) }
}

test('an extra account’s folder shares setup and history with the default, never its login', () => {
  const { root, home, cleanup } = scratch()
  try {
    const dir = path.join(root, 'claude', 'a1')
    const linked = prepareFolder('claude', dir, home)
    assert.deepEqual(linked.sort(), ['projects', 'settings.json'])
    assert.equal(fs.readFileSync(path.join(dir, 'projects', 'p1', 'session.jsonl'), 'utf8'), '{}\n', 'yesterday’s sessions resume from either account')
    assert.ok(!fs.existsSync(path.join(dir, '.credentials.json')), 'the login is not shared')
    assert.ok(!fs.existsSync(path.join(dir, '.claude.json')), 'nor the per-account state')
    for (const name of SHARED.claude) assert.ok(!/credential|auth|\.claude\.json/.test(name))
    for (const name of SHARED.codex) assert.ok(!/auth/.test(name))
    // Run again (a repair): nothing doubled, and the account's own file is kept.
    fs.unlinkSync(path.join(dir, 'settings.json'))
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"own":true}')
    prepareFolder('claude', dir, home)
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"own":true}')
  } finally {
    cleanup()
  }
})

test('removing an account deletes its folder and nothing its links point at; only folders Eaon made', () => {
  const { root, home, cleanup } = scratch()
  try {
    const dir = path.join(root, 'claude', 'a1')
    prepareFolder('claude', dir, home)
    fs.writeFileSync(path.join(dir, '.credentials.json'), 'the extra login')
    removeFolder(dir, root)
    assert.ok(!fs.existsSync(dir))
    assert.ok(fs.existsSync(path.join(home, 'projects', 'p1', 'session.jsonl')), 'shared history survives')
    assert.ok(fs.existsSync(path.join(home, 'settings.json')))
    assert.equal(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8'), 'the default login')
    assert.throws(() => removeFolder(home, root), /Not a folder Eaon made/)
    assert.throws(() => removeFolder(path.join(root, '..', 'default'), root), /Not a folder Eaon made/)
    assert.ok(fs.existsSync(home))
  } finally {
    cleanup()
  }
})

/* -------------------------------------------------------------------- service */

interface Script {
  /** Per folder (null = default): who is signed in, and their figures. */
  claude: Map<string | null, { status: unknown; usage: unknown }>
  codex: Map<string | null, { account: unknown; limits: unknown }>
  calls: string[]
  loggedOut: string[]
}

function harness(installed: CliTool[] = ['claude', 'codex'], options: { autoSwitch?: boolean } = {}) {
  const { root, home, cleanup } = scratch()
  let clock = Date.parse('2026-10-07T18:00:00Z')
  let saved: unknown = {}
  const script: Script = { claude: new Map(), codex: new Map(), calls: [], loggedOut: [] }
  script.claude.set(null, { status: { loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com', subscriptionType: 'max' }, usage: CLAUDE_USAGE })
  script.codex.set(null, { account: { account: { type: 'chatgpt', email: 'me@example.com', planType: 'free' } }, limits: CODEX_LIMITS })
  const runner: CliRunner = {
    find: (tool) => (installed.includes(tool) ? `/bin/${tool}` : null),
    claudeStatus: async (_bin, dir) => {
      script.calls.push(`claude status ${dir ?? 'default'}`)
      return script.claude.get(dir)?.status ?? { loggedIn: false }
    },
    claudeUsage: async (_bin, dir) => {
      script.calls.push(`claude usage ${dir ?? 'default'}`)
      return script.claude.get(dir)?.usage
    },
    codexRead: async (_bin, dir) => {
      script.calls.push(`codex read ${dir ?? 'default'}`)
      return script.codex.get(dir) ?? { account: { account: null }, limits: null }
    },
    logout: async (tool, _bin, dir) => {
      script.loggedOut.push(`${tool} ${dir}`)
    }
  }
  const logins: { tool: CliTool; dir: string; data: (d: string) => void; exit: (code: number) => void; written: string[]; killed: boolean }[] = []
  const notices: LimitNotice[] = []
  const service = new CliAccounts({
    runner,
    root,
    load: () => saved as never,
    save: (next) => (saved = JSON.parse(JSON.stringify(next))),
    startLogin: (tool, _bin, dir) => {
      const login = { tool, dir, data: (_d: string) => {}, exit: (_c: number) => {}, written: [] as string[], killed: false }
      logins.push(login)
      const proc: LoginProcess = {
        write: (d) => login.written.push(d),
        kill: () => (login.killed = true),
        onData: (l) => (login.data = l),
        onExit: (l) => (login.exit = l)
      }
      return proc
    },
    changed: () => {},
    alert: (notice) => void notices.push(notice),
    autoSwitch: () => options.autoSwitch === true,
    now: () => clock,
    defaultDirs: { claude: home, codex: home }
  })
  return {
    service,
    script,
    logins,
    notices,
    clock: () => clock,
    root,
    cleanup,
    tick: (ms: number) => (clock += ms),
    saved: () => saved as { tools: Record<CliTool, { active: string }> }
  }
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(check(), 'timed out')
}

test('the default accounts are read once, then not again until the figures go stale', async () => {
  const h = harness()
  try {
    await h.service.refresh()
    const state = h.service.state()
    const claude = state.usage[usageKey('claude', DEFAULT_ACCOUNT_ID)]
    assert.ok(claude?.ok)
    assert.deepEqual(claude.windows.map((w) => w.percent), [7, 79, 12, 50])
    const codex = state.usage[usageKey('codex', DEFAULT_ACCOUNT_ID)]
    assert.ok(codex?.ok && codex.windows[0].label === 'Month')
    assert.equal(state.tools.claude.accounts[0].email, 'me@example.com', 'who it is, as the CLI says')
    assert.equal(state.tools.claude.accounts[0].plan, 'max')

    const calls = h.script.calls.length
    await h.service.refresh()
    await h.service.refresh({ force: true })
    assert.equal(h.script.calls.length, calls, 'fresh figures are not read again, even when asked')
    h.tick(20_000)
    await h.service.refresh({ force: true })
    assert.equal(h.script.calls.length, calls + 3, 'the refresh button reads them after 15 seconds')
    h.tick(30_000)
    await h.service.refresh()
    assert.equal(h.script.calls.length, calls + 3, 'on its own, only after a minute')
    h.tick(31_000)
    await h.service.refresh()
    assert.equal(h.script.calls.length, calls + 6)
    assert.deepEqual(h.service.terminalEnv(), {}, 'the default accounts need nothing set')
  } finally {
    h.cleanup()
  }
})

test('signed out, an API key, a failing CLI and a missing CLI each say so', async () => {
  const h = harness(['claude'])
  try {
    h.script.claude.set(null, { status: { loggedIn: false }, usage: null })
    await h.service.refresh()
    const signedOut = h.service.state().usage[usageKey('claude', DEFAULT_ACCOUNT_ID)]
    assert.ok(signedOut && !signedOut.ok && signedOut.reason === 'signed-out')
    assert.ok(!h.script.calls.includes('claude usage default'), 'signed out: nothing more is asked')

    h.tick(61_000)
    h.script.claude.set(null, { status: { loggedIn: true, authMethod: 'console_api_key' }, usage: null })
    await h.service.refresh()
    const key = h.service.state().usage[usageKey('claude', DEFAULT_ACCOUNT_ID)]
    assert.ok(key && !key.ok && key.reason === 'no-limits')

    h.tick(61_000)
    h.script.claude.set(null, { status: { loggedIn: true, authMethod: 'claude.ai' }, usage: undefined })
    ;(h.service as unknown as { deps: { runner: CliRunner } }).deps.runner.claudeUsage = async () => {
      throw new Error('Claude Code didn’t answer in time')
    }
    await h.service.refresh()
    const failed = h.service.state().usage[usageKey('claude', DEFAULT_ACCOUNT_ID)]
    assert.ok(failed && !failed.ok && failed.reason === 'failed' && /in time/.test(failed.message))

    assert.equal(h.service.state().tools.codex.installed, false)
    assert.equal(h.service.state().usage[usageKey('codex', DEFAULT_ACCOUNT_ID)], undefined, 'no CLI, nothing asked')
  } finally {
    h.cleanup()
  }
})

test('adding an account: the CLI’s own sign-in in its own folder, which becomes the one terminals use', async () => {
  const h = harness()
  try {
    h.service.addAccount('claude')
    const login = h.logins[0]
    assert.equal(login.tool, 'claude')
    assert.ok(login.dir.startsWith(h.root), 'a folder Eaon made')
    assert.ok(fs.lstatSync(path.join(login.dir, 'projects')).isSymbolicLink())
    let state = h.service.state()
    assert.equal(state.login.state, 'running')
    assert.equal(state.tools.claude.accounts.length, 2)
    assert.equal(state.tools.claude.active, DEFAULT_ACCOUNT_ID, 'not used until it is signed in')
    assert.throws(() => h.service.addAccount('codex'), /already open/)

    login.data('\x1b[2mhttps://claude.ai/oauth/authorize?code=true&state=s1\x1b[0m\r\nPaste code here if prompted > ')
    state = h.service.state()
    assert.ok(state.login.state === 'running' && state.login.url === 'https://claude.ai/oauth/authorize?code=true&state=s1')
    h.service.loginInput('abc#def\n')
    assert.deepEqual(login.written, ['abc#def\r'], 'a pasted code goes to the CLI, once')

    h.script.claude.set(login.dir, { status: { loggedIn: true, authMethod: 'claude.ai', email: 'work@company.com', subscriptionType: 'team' }, usage: CLAUDE_USAGE })
    login.exit(0)
    await until(() => h.service.state().login.state === 'done')
    state = h.service.state()
    const added = state.tools.claude.accounts[1]
    assert.equal(added.email, 'work@company.com')
    assert.equal(state.tools.claude.active, added.id)
    assert.deepEqual(h.service.terminalEnv(), { CLAUDE_CONFIG_DIR: login.dir }, 'every pane now runs claude as it')
    assert.equal(h.saved().tools.claude.active, added.id, 'and that is saved')

    h.service.use('claude', DEFAULT_ACCOUNT_ID)
    assert.deepEqual(h.service.terminalEnv(), {}, 'switching back')
  } finally {
    h.cleanup()
  }
})

test('a sign-in that is cancelled, fails, or is an account already here leaves nothing behind', async () => {
  const h = harness()
  try {
    h.service.addAccount('codex')
    const first = h.logins[0]
    h.service.cancelLogin()
    assert.ok(first.killed)
    await until(() => !fs.existsSync(first.dir))
    assert.equal(h.service.state().tools.codex.accounts.length, 1)
    h.service.dismissLogin()

    h.service.addAccount('codex')
    const second = h.logins[1]
    second.exit(1)
    await until(() => h.service.state().login.state === 'failed')
    assert.ok(!fs.existsSync(second.dir))
    assert.equal(h.service.state().tools.codex.accounts.length, 1)
    h.service.dismissLogin()

    h.service.addAccount('codex')
    const third = h.logins[2]
    h.script.codex.set(third.dir, { account: { account: { type: 'chatgpt', email: 'me@example.com', planType: 'free' } }, limits: CODEX_LIMITS })
    await h.service.refresh({ tool: 'codex' })
    third.exit(0)
    await until(() => h.service.state().login.state === 'failed')
    const state = h.service.state()
    assert.ok(state.login.state === 'failed' && /already here/.test(state.login.message ?? ''))
    assert.equal(state.tools.codex.accounts.length, 1)
    assert.deepEqual(h.script.loggedOut, [`codex ${third.dir}`], 'its duplicate login is signed out, not left lying around')
    assert.equal(state.tools.codex.active, DEFAULT_ACCOUNT_ID)
  } finally {
    h.cleanup()
  }
})

test('signing an account out: the CLI signs it out, the folder goes, the default takes over; the default stays', async () => {
  const h = harness()
  try {
    h.service.addAccount('codex')
    const login = h.logins[0]
    h.script.codex.set(login.dir, { account: { account: { type: 'chatgpt', email: 'side@x.co', planType: 'plus' } }, limits: CODEX_LIMITS })
    login.exit(0)
    await until(() => h.service.state().login.state === 'done')
    const id = h.service.state().tools.codex.active
    assert.deepEqual(h.service.terminalEnv(), { CODEX_HOME: login.dir })

    await h.service.remove('codex', id)
    assert.deepEqual(h.script.loggedOut, [`codex ${login.dir}`])
    assert.ok(!fs.existsSync(login.dir))
    const state = h.service.state()
    assert.equal(state.tools.codex.active, DEFAULT_ACCOUNT_ID)
    assert.equal(state.usage[usageKey('codex', id)], undefined)
    await assert.rejects(h.service.remove('codex', DEFAULT_ACCOUNT_ID), /default account/)
  } finally {
    h.cleanup()
  }
})

test('saved accounts come back, and a saved choice that no longer exists falls back to the default', () => {
  const h = harness()
  try {
    const reloaded = new CliAccounts({
      runner: { find: () => null } as unknown as CliRunner,
      root: h.root,
      load: () => ({ tools: { claude: { active: 'gone', accounts: [{ id: 'x1', dir: '/x', label: 'Work', email: null, plan: null, addedAt: 1 }] } } }) as never,
      save: () => {},
      startLogin: () => {
        throw new Error('unused')
      },
      changed: () => {}
    })
    const state = reloaded.state()
    assert.deepEqual(
      state.tools.claude.accounts.map((a) => a.id),
      [DEFAULT_ACCOUNT_ID, 'x1']
    )
    assert.equal(state.tools.claude.active, DEFAULT_ACCOUNT_ID)
    assert.equal(state.tools.codex.accounts.length, 1)
  } finally {
    h.cleanup()
  }
})

test('signing an existing account in again: a failure keeps it; the default signs in in a terminal', async () => {
  const h = harness()
  try {
    h.service.addAccount('claude')
    const first = h.logins[0]
    h.script.claude.set(first.dir, { status: { loggedIn: true, authMethod: 'claude.ai', email: 'work@company.com' }, usage: CLAUDE_USAGE })
    first.exit(0)
    await until(() => h.service.state().login.state === 'done')
    h.service.dismissLogin()
    const id = h.service.state().tools.claude.active
    h.service.use('claude', DEFAULT_ACCOUNT_ID)

    // Its login lapses.
    h.script.claude.set(first.dir, { status: { loggedIn: false }, usage: null })
    h.tick(61_000)
    await h.service.refresh({ tool: 'claude', all: true })
    h.service.signIn('claude', id)
    const again = h.logins[1]
    assert.equal(again.dir, first.dir, 'the same folder')
    again.exit(1)
    await until(() => h.service.state().login.state === 'failed')
    assert.ok(fs.existsSync(first.dir), 'a failed sign-in keeps the account')
    assert.equal(h.service.state().tools.claude.accounts.length, 2)
    h.service.dismissLogin()

    h.service.signIn('claude', id)
    h.service.cancelLogin()
    assert.ok(fs.existsSync(first.dir), 'and so does a cancelled one')
    h.service.dismissLogin()

    h.service.signIn('claude', id)
    h.script.claude.set(first.dir, { status: { loggedIn: true, authMethod: 'claude.ai', email: 'work@company.com' }, usage: CLAUDE_USAGE })
    h.logins[3].exit(0)
    await until(() => h.service.state().login.state === 'done')
    const state = h.service.state()
    assert.equal(state.tools.claude.active, DEFAULT_ACCOUNT_ID, 'signing in again doesn’t switch to it')
    assert.ok(state.usage[usageKey('claude', id)]?.ok)
    assert.throws(() => h.service.signIn('claude', DEFAULT_ACCOUNT_ID), /default account/)
  } finally {
    h.cleanup()
  }
})

/* ------------------------------------------------- limits, resets and alerts */

const NOW = Date.parse('2026-10-07T18:00:00Z')
const win = (id: string, percent: number, resetsAt: number | null, extra: Partial<UsageWindow> = {}): UsageWindow => ({
  id,
  label: id === 'session' ? 'Session' : 'Week',
  span: '',
  percent,
  resetsAt,
  severity: percent >= 90 ? 'critical' : 'normal',
  ...extra
})
const ok = (...windows: UsageWindow[]): AccountUsage => ({ ok: true, at: NOW, plan: 'plus', windows })

test('a window whose reset has passed since it was read shows as reset, never as a stale 100%', () => {
  const full = win('session', 100, NOW + 60_000, { reached: true })
  assert.equal(liveWindow(full, NOW).percent, 100)
  const after = liveWindow(full, NOW + 60_000)
  assert.deepEqual([after.percent, after.hasReset, after.reached, after.severity], [0, true, false, 'normal'])
  assert.equal(liveWindow(win('week', 50, null), NOW + 1e9).hasReset, false, 'no reset time: nothing to go by')
  assert.equal(hasRoom(ok(full), NOW), false)
  assert.equal(hasRoom(ok(full), NOW + 60_000), true, 'room again once it resets')
  assert.equal(hasRoom({ ok: false, at: NOW, reason: 'signed-out', message: '' }, NOW), false)
})

test('limit alerts: at 90% and at the limit, each once per window reset', () => {
  const reset = NOW + 3 * 3600_000
  let memory: AlertMemory = {}
  const step = (usage: AccountUsage, at = NOW): string[] => {
    const result = limitAlerts('codex', 'a1', usage, memory, at)
    memory = result.memory
    return result.alerts.map((a) => `${a.windowId}:${a.level}`)
  }
  assert.deepEqual(step(ok(win('session', 89, reset))), [], 'under 90%: nothing')
  assert.deepEqual(step(ok(win('session', 91, reset), win('week', 40, null))), ['session:near'])
  assert.deepEqual(step(ok(win('session', 95, reset))), [], 'said once')
  assert.deepEqual(step(ok(win('session', 97, reset, { reached: true }))), ['session:reached'], 'hitting it is news')
  assert.deepEqual(step(ok(win('session', 100, reset))), [])
  assert.deepEqual(step(ok(win('session', 93, reset + 5 * 3600_000)), reset + 1000), ['session:near'], 'its reset passed: armed again')
  assert.deepEqual(step(ok(win('session', 10, reset + 5 * 3600_000)), reset + 2000), [])
  assert.deepEqual(memory, {}, 'under 90% again forgets it')
  assert.deepEqual(step(ok(win('week', 100, null))), ['week:reached'], 'no reset time: straight to the limit')
  assert.deepEqual(step(ok(win('week', 100, null))), [])
  assert.deepEqual(limitAlerts('codex', 'a1', { ok: false, at: NOW, reason: 'failed', message: 'x' }, memory, NOW).alerts, [])
  assert.ok(Object.keys(limitAlerts('codex', 'a2', ok(win('week', 95, null)), memory, NOW).memory).includes('codex:a1:week'), 'other accounts are kept apart')
})

test('the account to switch to: signed in, with room, the emptiest first', () => {
  const account = (id: string, email: string): CliAccount => ({ id, dir: id === DEFAULT_ACCOUNT_ID ? null : `/accounts/${id}`, label: '', email, plan: null, addedAt: 0 })
  const tools = {
    claude: { active: DEFAULT_ACCOUNT_ID, accounts: [account(DEFAULT_ACCOUNT_ID, 'alex@example.com')] },
    codex: {
      active: DEFAULT_ACCOUNT_ID,
      accounts: [account(DEFAULT_ACCOUNT_ID, 'alex@example.com'), account('b', 'b@example.com'), account('c', 'c@example.com'), account('d', 'd@example.com'), account('e', 'e@example.com')]
    }
  }
  const usage: Record<string, AccountUsage> = {
    [usageKey('codex', DEFAULT_ACCOUNT_ID)]: ok(win('session', 100, NOW + 3600_000, { reached: true })),
    [usageKey('codex', 'b')]: ok(win('session', 60, null)),
    [usageKey('codex', 'c')]: ok(win('session', 20, null), win('week', 30, null)),
    [usageKey('codex', 'd')]: ok(win('session', 95, null)),
    [usageKey('codex', 'e')]: { ok: false, at: NOW, reason: 'signed-out', message: 'Not signed in' }
  }
  assert.equal(switchTarget('codex', { tools, usage }, NOW)?.id, 'c')
  assert.equal(switchTarget('codex', { tools, usage }, NOW, 'c')?.id, 'b')
  assert.equal(switchTarget('claude', { tools, usage }, NOW), null, 'one account: nowhere to go')
  usage[usageKey('codex', 'b')] = ok(win('session', 100, NOW + 60_000))
  usage[usageKey('codex', 'c')] = ok(win('session', 92, null))
  assert.equal(switchTarget('codex', { tools, usage }, NOW), null, 'none has room')
  assert.equal(switchTarget('codex', { tools, usage }, NOW + 60_000)?.id, 'b', 'until one resets')
})

test('the notification says what hit, when it resets, and where there is room', () => {
  const notice: LimitNotice = { tool: 'codex', accountId: 'a1', windowId: 'session', label: 'Session', level: 'reached', percent: 100, resetsAt: NOW + 2 * 3600_000 + 5 * 60_000, name: 'Work', switchTo: { id: 'b', name: 'Personal' }, switched: false }
  const text = limitNoticeText(notice, NOW)
  assert.equal(text.title, 'Codex: Work hit its session limit')
  assert.match(text.body, /^Resets (\w{3} )?at .+ \(in 2h 5m\)\. Personal has room\.$/)
  assert.match(limitNoticeText({ ...notice, switched: true }, NOW).body, /New Codex sessions now use Personal\.$/)
  assert.equal(limitNoticeText({ ...notice, level: 'near', percent: 92, resetsAt: null, switchTo: null }, NOW).title, 'Codex: Work is at 92% of its session limit')
})

test('Codex’s rateLimitReachedType marks the window it names as reached', () => {
  const usage = codexUsage({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: 2 }, rateLimitReachedType: 'secondary' }
  })
  assert.deepEqual(usage.windows.map((w) => [w.id, w.reached === true, w.severity]), [
    ['session', false, 'normal'],
    ['week', true, 'critical']
  ])
  const none = codexUsage({ rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1 }, rateLimitReachedType: null } })
  assert.equal(none.windows[0].reached, undefined)
})

test('a conversation’s rollout is found in a Codex folder, linked or not', () => {
  const { root, home, cleanup } = scratch()
  try {
    const id = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000'
    const day = path.join(home, 'sessions', '2026', '10', '07')
    fs.mkdirSync(day, { recursive: true })
    fs.writeFileSync(path.join(day, `rollout-2026-10-07T10-00-00-${id}.jsonl`), '{}\n')
    assert.equal(hasRollout(home, id), true)
    assert.equal(hasRollout(home, '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001'), false)
    const extra = path.join(root, 'codex', 'x1')
    prepareFolder('codex', extra, home)
    assert.equal(hasRollout(extra, id), true, 'an extra account shares the default’s sessions')
    assert.equal(hasRollout(path.join(root, 'nowhere'), id), false)
  } finally {
    cleanup()
  }
})

/* ---------------------------------------------- the service: switching and alerts */

/** Adds a signed-in Codex account through the scripted sign-in; returns its id and folder. */
async function addCodex(h: ReturnType<typeof harness>, email: string, limits: unknown): Promise<{ id: string; dir: string }> {
  h.service.addAccount('codex')
  const login = h.logins[h.logins.length - 1]
  h.script.codex.set(login.dir, { account: { account: { type: 'chatgpt', email, planType: 'plus' } }, limits })
  login.exit(0)
  await until(() => h.service.state().login.state === 'done')
  h.service.dismissLogin()
  return { id: h.service.state().tools.codex.active, dir: login.dir }
}

const codexLimits = (percent: number, resetsAt: number, reached: string | null = null): unknown => ({
  rateLimits: { limitId: 'codex', primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: Math.round(resetsAt / 1000) }, secondary: null, planType: 'plus', rateLimitReachedType: reached }
})

test('switching tells whoever follows the active account, and gives one CLI’s folder on its own', async () => {
  const h = harness()
  try {
    const heard: CliTool[] = []
    const stop = h.service.onActive((tool) => heard.push(tool))
    const extra = await addCodex(h, 'work@example.com', codexLimits(10, h.clock() + 3600_000))
    assert.deepEqual(heard, ['codex'], 'a new account, signed in, becomes the active one')
    assert.deepEqual(h.service.toolEnv('codex'), { CODEX_HOME: extra.dir })
    assert.deepEqual(h.service.toolEnv('claude'), {}, 'the other CLI is untouched')

    h.service.use('codex', extra.id)
    assert.deepEqual(heard, ['codex'], 'choosing the one already in use is no change')
    h.service.use('codex', DEFAULT_ACCOUNT_ID)
    assert.deepEqual(h.service.toolEnv('codex'), {})
    h.service.use('codex', extra.id)
    await h.service.remove('codex', extra.id)
    assert.deepEqual(heard, ['codex', 'codex', 'codex', 'codex'], 'removing the active account falls back to the default, and says so')
    stop()
    h.service.use('codex', DEFAULT_ACCOUNT_ID)
    assert.equal(heard.length, 4)
  } finally {
    h.cleanup()
  }
})

test('the background reads the other accounts every half hour, and a window that reset straight away', async () => {
  const h = harness(['codex'])
  try {
    const extra = await addCodex(h, 'work@example.com', codexLimits(10, h.clock() + 2 * 3600_000))
    h.service.use('codex', DEFAULT_ACCOUNT_ID)
    await h.service.refresh({ background: 'visible' })
    const reads = (dir: string | null): number => h.script.calls.filter((c) => c === `codex read ${dir ?? 'default'}`).length
    const extraReads = reads(extra.dir)
    h.tick(10 * 60_000)
    await h.service.refresh({ background: 'visible' })
    assert.equal(reads(extra.dir), extraReads, 'an account not in use waits half an hour')
    const defaultReads = reads(null)
    h.tick(SLOW_FRESH_MS)
    await h.service.refresh({ background: 'hidden' })
    assert.equal(reads(extra.dir), extraReads, 'with no window up, only the account in use')
    assert.equal(reads(null), defaultReads + 1)
    await h.service.refresh({ background: 'visible' })
    assert.equal(reads(extra.dir), extraReads + 1)

    // The default's session resets in five minutes; read a minute before, then just after.
    h.script.codex.set(null, { account: { account: { type: 'chatgpt', email: 'alex@example.com', planType: 'plus' } }, limits: codexLimits(100, h.clock() + 5 * 60_000, 'primary') })
    h.tick(61_000)
    await h.service.refresh()
    const before = reads(null)
    h.tick(30_000)
    await h.service.refresh({ background: 'hidden' })
    assert.equal(reads(null), before, 'fresh enough, and nothing reset')
    h.tick(5 * 60_000)
    await h.service.refresh({ background: 'hidden' })
    assert.equal(reads(null), before + 1, 'its window reset since: read again, well before half an hour')
  } finally {
    h.cleanup()
  }
})

test('the active account hitting its limit: one alert per reset, naming an account with room', async () => {
  const h = harness(['codex'])
  try {
    const reset = h.clock() + 3 * 3600_000
    const extra = await addCodex(h, 'work@example.com', codexLimits(12, reset))
    h.script.codex.set(null, { account: { account: { type: 'chatgpt', email: 'alex@example.com', planType: 'plus' } }, limits: codexLimits(92, reset) })
    h.service.use('codex', DEFAULT_ACCOUNT_ID)
    await h.service.refresh({ all: true })
    assert.deepEqual(h.notices.map((n) => [n.accountId, n.level, n.percent]), [[DEFAULT_ACCOUNT_ID, 'near', 92]], 'only the account in use is alerted on')
    assert.deepEqual(h.notices[0].switchTo, { id: extra.id, name: 'work@example.com' })
    assert.equal(h.notices[0].switched, false)

    h.tick(61_000)
    await h.service.refresh()
    assert.equal(h.notices.length, 1, 'still near: not said again')
    h.script.codex.set(null, { account: { account: { type: 'chatgpt', email: 'alex@example.com', planType: 'plus' } }, limits: codexLimits(100, reset, 'primary') })
    h.tick(61_000)
    await h.service.refresh()
    assert.deepEqual(h.notices.map((n) => n.level), ['near', 'reached'])
    assert.equal(h.service.state().tools.codex.active, DEFAULT_ACCOUNT_ID, 'no switching unless asked for')
  } finally {
    h.cleanup()
  }
})

test('with the automatic switch on, a Codex account at its limit hands over to the one with room', async () => {
  const h = harness(['codex'], { autoSwitch: true })
  try {
    const heard: CliTool[] = []
    const reset = h.clock() + 3 * 3600_000
    const extra = await addCodex(h, 'work@example.com', codexLimits(12, reset))
    h.service.use('codex', DEFAULT_ACCOUNT_ID)
    h.service.onActive((tool) => heard.push(tool))
    await h.service.refresh({ all: true, force: true })
    assert.equal(h.notices.length, 0)
    h.script.codex.set(null, { account: { account: { type: 'chatgpt', email: 'alex@example.com', planType: 'plus' } }, limits: codexLimits(100, reset, 'primary') })
    h.tick(61_000)
    await h.service.refresh()
    assert.equal(h.service.state().tools.codex.active, extra.id)
    assert.deepEqual(heard, ['codex'], 'the engine and new panes hear of it')
    assert.deepEqual(h.service.terminalEnv(), { CODEX_HOME: extra.dir })
    assert.equal(h.notices.length, 1)
    assert.equal(h.notices[0].switched, true)
    assert.match(limitNoticeText(h.notices[0], h.clock()).body, /New Codex sessions now use work@example\.com\./)

    // The new one hits its limit too, with nowhere left to go: an alert, and no switch.
    h.script.codex.set(extra.dir, { account: { account: { type: 'chatgpt', email: 'work@example.com', planType: 'plus' } }, limits: codexLimits(100, reset, 'primary') })
    h.tick(61_000)
    await h.service.refresh()
    assert.equal(h.service.state().tools.codex.active, extra.id)
    assert.equal(h.notices.length, 2)
    assert.equal(h.notices[1].switchTo, null)
  } finally {
    h.cleanup()
  }
})

test('a CLI named in EAON_CLAUDE_BIN / EAON_CODEX_BIN is used instead of searching; `none` means not installed', () => {
  const which = (bin: string): string | null => `/path/${bin}`
  const exists = (file: string): boolean => file.startsWith('/fake/')
  assert.equal(findCli('claude', which, exists, {}), '/path/claude')
  assert.equal(findCli('codex', which, exists, { EAON_CODEX_BIN: '/fake/codex' }), '/fake/codex')
  assert.equal(findCli('claude', which, exists, { EAON_CLAUDE_BIN: 'none' }), null)
  assert.equal(findCli('codex', which, exists, { EAON_CODEX_BIN: '/missing/codex' }), null, 'a pinned CLI that isn’t there is not replaced by another')
})
