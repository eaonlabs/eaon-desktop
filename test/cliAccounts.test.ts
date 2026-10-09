import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_ACCOUNT_ID, usageKey, type CliTool } from '@shared/cliAccounts'
import { claudeStatus, claudeUsage, codexAccount, codexUsage } from '../src/main/features/cliAccounts/parse'
import { prepareFolder, removeFolder, SHARED } from '../src/main/features/cliAccounts/folders'
import { CliAccounts, firstUrl, stripAnsi, type CliRunner, type LoginProcess } from '../src/main/features/cliAccounts/service'

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
      ['week:Opus', 'Opus week', 12, 'normal']
    ]
  )
  assert.equal(usage.windows[0].resetsAt, Date.parse('2026-10-08T05:49:59.960876+00:00'))
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

function harness(installed: CliTool[] = ['claude', 'codex']) {
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
    now: () => clock,
    defaultDirs: { claude: home, codex: home }
  })
  return {
    service,
    script,
    logins,
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
    assert.deepEqual(claude.windows.map((w) => w.percent), [7, 79, 12])
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
