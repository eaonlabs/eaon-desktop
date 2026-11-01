import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeReportedUsage } from '../src/main/features/cliAccounts/parse'
import { claudeReportEverywhere, prepareClaudeReport, readClaudeReport, reportKey } from '../src/main/features/cliAccounts/usageReport'
import { withUsageReport } from '../src/main/features/terminals'

/**
 * Claude Code's plan limits, as it reports them to the status line Eaon's
 * panes start it with: the script runs under a real `sh`, the way Claude
 * Code runs it, and what it leaves is what the usage meter reads.
 */

const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-claude-report-'))

/** The JSON Claude Code hands a status line, cut to what matters here. */
const statusInput = (fiveHour: number, week: number, now = Date.now()) =>
  JSON.stringify({
    session_id: 's1',
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: Math.round(now / 1000) + 3600 },
      seven_day: { used_percentage: week, resets_at: Math.round(now / 1000) + 3 * 86_400 }
    }
  })

/** Runs the status line Claude Code would, as `settings.json` says, from a Claude Code folder. */
function runStatusLine(settings: string, input: string, configDir: string | null): string {
  const { statusLine } = JSON.parse(fs.readFileSync(settings, 'utf8'))
  const env = { ...process.env }
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  else delete env.CLAUDE_CONFIG_DIR
  return execFileSync('sh', ['-c', statusLine.command], { input, env, encoding: 'utf8' })
}

test('the status line keeps each Claude Code folder’s limits apart, and shows your own status line after', { skip: process.platform === 'win32' }, async () => {
  const root = path.join(scratch(), 'Application Support', 'claude-code')
  const home = scratch()
  const work = path.join(home, 'Work account ü')
  fs.mkdirSync(work, { recursive: true })
  // The second account has a status line of its own.
  fs.writeFileSync(path.join(work, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'cat >/dev/null; printf "mine %s" "$CLAUDE_CONFIG_DIR"' } }))
  const settings = prepareClaudeReport(root, [null, work])
  assert.ok(settings && fs.existsSync(settings), 'a settings file to start Claude Code with')

  assert.equal(runStatusLine(settings, statusInput(61.4, 48), null), '', 'no status line of its own: nothing is drawn')
  assert.equal(runStatusLine(settings, statusInput(12, 7), work), `mine ${work}`, 'its own status line still shows')

  const mine = await readClaudeReport(root, null)
  const theirs = await readClaudeReport(root, work)
  assert.ok(mine && theirs, 'one report per folder, even with spaces and an ü in its path')
  const now = Date.now()
  assert.deepEqual(claudeReportedUsage(mine.input, mine.at, now)?.windows.map((w) => `${w.label} ${w.percent}%`), ['Session 61%', 'Week 48%'])
  assert.deepEqual(claudeReportedUsage(theirs.input, theirs.at, now)?.windows.map((w) => `${w.label} ${w.percent}%`), ['Session 12%', 'Week 7%'])
  assert.equal((fs.statSync(path.join(root, 'limits', `${reportKey(work)}.json`)).mode & 0o777).toString(8), '600', 'only this user can read it')

  // A turn with no limits in it (an API key's) leaves the last report alone.
  runStatusLine(settings, JSON.stringify({ session_id: 's2' }), null)
  assert.deepEqual(claudeReportedUsage((await readClaudeReport(root, null))?.input, now, now)?.windows.map((w) => w.percent), [61, 48])

  // Their status line removed: ours stops running it.
  fs.rmSync(path.join(work, 'settings.json'))
  prepareClaudeReport(root, [null, work])
  assert.equal(runStatusLine(settings, statusInput(13, 7), work), '')
})

test('reported limits: percentages and Unix-second resets, a reset window starts again, and a gateway’s spend limit', () => {
  const now = Date.parse('2026-10-28T20:00:00Z')
  const usage = claudeReportedUsage(
    {
      rate_limits: {
        five_hour: { used_percentage: 100, resets_at: now / 1000 + 600 },
        seven_day: { used_percentage: 87.6, resets_at: now / 1000 - 60 },
        spend_limit: { used_percentage: 40, resets_at: now / 1000 + 86_400, used_usd: 20, limit_usd: 50, period: 'monthly' }
      }
    },
    now - 5000,
    now
  )
  assert.ok(usage)
  assert.equal(usage.asOf, now - 5000, 'when Claude Code wrote it')
  const [session, week, spend] = usage.windows
  assert.equal(session.percent, 100)
  assert.equal(session.reached, true)
  assert.equal(session.resetsAt, now + 600_000)
  assert.equal(week.percent, 0, 'its week reset a minute ago')
  assert.equal(week.resetsAt, null)
  assert.equal(spend.detail, '$20.00 of $50.00')
  assert.equal(claudeReportedUsage({ session_id: 'x' }, now, now), null, 'no limits in it')
  assert.equal(claudeReportedUsage('nonsense', now, now), null)
})

test('only a local Claude Code is started with the status line, and only once', () => {
  const settings = '/Users/me/Library/Application Support/eaon-desktop/claude-code/settings.json'
  assert.equal(
    withUsageReport('claude --dangerously-skip-permissions --resume 1b2c', settings, 'posix'),
    `claude --settings '${settings}' --dangerously-skip-permissions --resume 1b2c`
  )
  assert.equal(withUsageReport('/opt/bin/claude', settings, 'posix'), `/opt/bin/claude --settings '${settings}'`)
  assert.equal(withUsageReport('codex', settings, 'posix'), 'codex', 'another agent')
  assert.equal(withUsageReport('claude --settings mine.json', settings, 'posix'), 'claude --settings mine.json', 'one that brings its own')
  assert.equal(withUsageReport('claude', null, 'posix'), 'claude', 'nowhere to report (Windows)')
  assert.equal(prepareClaudeReport(scratch(), [null], 'win32'), null)
})

test('everywhere: Claude Code’s own settings get the status line, theirs still runs after it, and turning it off puts theirs back as it was', { skip: process.platform === 'win32' }, async () => {
  const root = path.join(scratch(), 'claude-usage')
  const home = scratch()
  const main = path.join(home, '.claude')
  const extra = path.join(home, 'extra account')
  fs.mkdirSync(main, { recursive: true })
  fs.mkdirSync(extra, { recursive: true })
  // Like Orca's: a status line of their own, and other settings beside it.
  const theirs = { type: 'command', command: 'cat >/dev/null; printf orca', padding: 1 }
  const before = { model: 'opus', statusLine: theirs, permissions: { allow: ['Bash(ls)'] } }
  fs.writeFileSync(path.join(main, 'settings.json'), JSON.stringify(before, null, 2))
  // An extra account's settings is a link to the main one's (cliAccounts/folders.ts).
  fs.symlinkSync(path.join(main, 'settings.json'), path.join(extra, 'settings.json'))

  prepareClaudeReport(root, [main, extra])
  assert.deepEqual(claudeReportEverywhere(root, [main, extra], true), [fs.realpathSync(path.join(main, 'settings.json'))], 'one file, written through the link')
  assert.ok(fs.lstatSync(path.join(extra, 'settings.json')).isSymbolicLink(), 'the link is still a link')
  const installed = JSON.parse(fs.readFileSync(path.join(main, 'settings.json'), 'utf8'))
  assert.equal(installed.model, 'opus', 'the rest is untouched')
  assert.deepEqual(installed.permissions, before.permissions)
  assert.equal(installed.statusLine.padding, 1)
  assert.match(installed.statusLine.command, /status-line\.sh/)
  assert.deepEqual(claudeReportEverywhere(root, [main], true), [], 'already there: nothing to do')

  // Claude Code runs it, in a session Eaon didn't start: the limits are kept, and theirs shows.
  prepareClaudeReport(root, [main, extra])
  const run = (configDir: string): string =>
    execFileSync('sh', ['-c', installed.statusLine.command], { input: statusInput(33, 21), env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, encoding: 'utf8' })
  assert.equal(run(main), 'orca', 'their status line still runs')
  assert.equal(run(extra), 'orca', 'in every account')
  assert.deepEqual(claudeReportedUsage((await readClaudeReport(root, extra))?.input, Date.now(), Date.now())?.windows.map((w) => w.percent), [33, 21])

  // Eaon's files gone: Claude Code still shows theirs.
  fs.rmSync(path.join(root, 'status-line.sh'))
  assert.equal(run(main), 'orca')

  assert.deepEqual(claudeReportEverywhere(root, [main, extra], false), [fs.realpathSync(path.join(main, 'settings.json'))])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(main, 'settings.json'), 'utf8')), before, 'exactly as it was')

  // Without one of their own: added, then taken away again.
  const bare = path.join(scratch(), '.claude')
  claudeReportEverywhere(root, [bare], true)
  assert.match(JSON.parse(fs.readFileSync(path.join(bare, 'settings.json'), 'utf8')).statusLine.command, /status-line\.sh/)
  claudeReportEverywhere(root, [bare], false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bare, 'settings.json'), 'utf8')), {})
  // A settings file that isn't JSON is left alone.
  const broken = path.join(scratch(), '.claude')
  fs.mkdirSync(broken, { recursive: true })
  fs.writeFileSync(path.join(broken, 'settings.json'), '{ not json')
  assert.deepEqual(claudeReportEverywhere(root, [broken], true), [])
  assert.equal(fs.readFileSync(path.join(broken, 'settings.json'), 'utf8'), '{ not json')
})
