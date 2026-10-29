import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeReportedUsage } from '../src/main/features/cliAccounts/parse'
import { prepareClaudeReport, readClaudeReport, reportKey } from '../src/main/features/cliAccounts/usageReport'
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
