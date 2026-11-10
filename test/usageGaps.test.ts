import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notification } from 'electron'
import type { Provider, StreamRequest } from '@shared/types'
import { monthRange, tokenSplit, type Billing, type UsageBudgetState, type UsageSummary } from '@shared/usage'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import { adapterFor, registerAdapter } from '../src/main/providers'
import type { Adapter, TurnRequest } from '../src/main/providers/adapters/types'
import { usageFeature } from '../src/main/features/usage'
import { withUsageProject, withUsageSource } from '../src/main/features/usage/attribution'
import { budgetBlockMessage, budgetLevel, budgetNotice, budgetState, monthOf, monthUse, nextAlert, normalizeAlerts, normalizeBudget, DEFAULT_BUDGET } from '../src/main/features/usage/budget'
import { CSV_COLUMNS, csvCell, usageCsv, usageCsvName } from '../src/main/features/usage/exportCsv'
import { flushLedger, ledgerProjects, localDay, recordUsage, resetLedgerForTests } from '../src/main/features/usage/ledger'
import { activity, agentStats, normalizeSpan, spanDays, summarize, summarizeProjects, type ToknPricing } from '../src/main/features/usage/rows'
import type { FeatureContext } from '../src/main/features/types'
import { secrets } from '../src/main/secrets'
import { store } from '../src/main/store'
import { chunk, sseServer } from './helpers'
import { projectLabel } from '../src/renderer/src/components/settings/pages/usageTools'

/**
 * Settings → Usage: a custom date range, the CSV export, the token split, the
 * monthly budget (and the cap that refuses requests), and usage by project.
 * Tokn's prices are faked; no model is called.
 */

process.env.EAON_TOKN_HOST = 'https://tokn.test'

const PRICING: ToknPricing = { 'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }
const billing = (id: string): Billing => (id === 'lm-studio' ? 'local' : id === 'chatgpt' ? 'plan' : 'api')
const counts = (requests: number, input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ requests, input, output, cacheRead, cacheWrite })

/* ------------------------------------------------------ custom date range */

test('a custom range is put in order, kept to real days, today and the days Eaon keeps', () => {
  const now = new Date(2026, 10, 7, 15)
  assert.equal(normalizeSpan(7, now), 7)
  assert.equal(normalizeSpan(14, now), 30, 'anything but a preset or a range is the 30-day preset')
  assert.equal(normalizeSpan('x', now), 30)
  assert.deepEqual(normalizeSpan({ from: '2026-10-01', to: '2026-10-09' }, now), { from: '2026-10-01', to: '2026-10-09' })
  assert.deepEqual(normalizeSpan({ from: '2026-10-09', to: '2026-10-01' }, now), { from: '2026-10-01', to: '2026-10-09' }, 'reversed')
  assert.deepEqual(normalizeSpan({ from: '2026-11-01', to: '2027-01-01' }, now), { from: '2026-11-01', to: '2026-11-07' }, 'not after today')
  assert.deepEqual(normalizeSpan({ from: '2030-01-01', to: '2030-02-01' }, now), { from: '2026-11-07', to: '2026-11-07' })
  assert.equal(normalizeSpan({ from: '2020-01-01', to: '2026-11-07' }, now).from, '2025-10-04', '400 days, today included')
  assert.equal(spanDays(normalizeSpan({ from: '2020-01-01', to: '2026-11-07' }, now)).length, 400)
  assert.equal(normalizeSpan({ from: '2026-02-30', to: '2026-03-01' }, now), 30, 'not a calendar day')
  assert.equal(normalizeSpan({ from: 5, to: '2026-03-01' }, now), 30)
  assert.equal(normalizeSpan(null, now), 30)
})

test('spanDays lists every day of a custom range, across a month and a year end', () => {
  assert.deepEqual(spanDays({ from: '2026-12-30', to: '2027-01-02' }), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
  assert.equal(spanDays(30, new Date(2026, 9, 3, 15)).length, 30)
  assert.equal(spanDays(7, new Date(2026, 9, 3, 15))[0], '2026-09-27')
})

test('this month and last month as custom ranges', () => {
  assert.deepEqual(monthRange('this', new Date(2026, 10, 7, 9)), { from: '2026-11-01', to: '2026-11-07' })
  assert.deepEqual(monthRange('last', new Date(2026, 10, 7, 9)), { from: '2026-10-01', to: '2026-10-31' })
  assert.deepEqual(monthRange('last', new Date(2027, 0, 15, 9)), { from: '2026-12-01', to: '2026-12-31' }, 'across a year')
  assert.deepEqual(monthRange('last', new Date(2028, 2, 1, 9)), { from: '2028-02-01', to: '2028-02-29' }, 'a leap February')
})

test('the summary, activity and agents cover exactly the custom range; Today stays today’s', () => {
  const now = new Date(2026, 10, 7, 15)
  const days = {
    '2026-10-05': { anthropic: { 'claude-opus-5': counts(2, 1_000_000) } },
    '2026-10-20': { anthropic: { 'claude-opus-5': counts(1, 1_000_000) } },
    '2026-11-07': { anthropic: { 'claude-opus-5': counts(4, 2_000_000) } }
  }
  const october = summarize(days, { from: '2026-10-01', to: '2026-10-31' }, PRICING, billing, now)
  assert.equal(october.days.length, 31)
  assert.equal(october.totals.requests, 3)
  assert.equal(october.totals.costUsd, 10)
  assert.equal(october.today.requests, 4, 'today is outside the range but the Today tile still shows it')
  assert.equal(october.today.costUsd, 10)
  assert.deepEqual(october.models.map((m) => [m.modelId, m.requests]), [['claude-opus-5', 3]])

  const byDay = new Map(Object.entries(days).map(([day, p]) => [day, { day, costUsd: 0, tokens: p.anthropic['claude-opus-5'].input, requests: p.anthropic['claude-opus-5'].requests }]))
  assert.equal(activity(byDay, { from: '2026-10-01', to: '2026-10-10' }, now).activeInRange, 1)
  assert.equal(activity(byDay, { from: '2026-10-01', to: '2026-10-31' }, now).activeInRange, 2)
  const runs = { '2026-10-05': { work: { runs: 3, totalMs: 9, longestMs: 4 } }, '2026-11-07': { work: { runs: 1, totalMs: 1, longestMs: 1 } } }
  assert.equal(agentStats(runs, { from: '2026-10-01', to: '2026-10-31' }, now).runsInRange, 3)
  assert.equal(agentStats(runs, 7, now).runsInRange, 1)
})

/* -------------------------------------------------------- token split */

test('the token split adds up to the Tokens total and finds the cache hit rate', () => {
  const split = tokenSplit([
    { input: 100, output: 50, cacheRead: 800, cacheWrite: 100 },
    { input: 0, output: 25, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 40 }
  ])
  assert.deepEqual(split, { input: 100, output: 75, cacheRead: 800, cacheWrite: 140, total: 1115, cacheHitRate: 800 / 1040 })
  assert.equal(tokenSplit([{ input: 0, output: 9, cacheRead: 0, cacheWrite: 0 }]).cacheHitRate, null, 'no prompt, no rate')
  assert.equal(tokenSplit([]).total, 0)
  // The same figure the page's Tokens tile shows for these models.
  const summary = summarize({ '2026-11-07': { anthropic: { 'claude-opus-5': counts(1, 100, 50, 800, 100) } } }, 7, PRICING, billing, new Date(2026, 10, 7, 9))
  assert.equal(tokenSplit(summary.models).total, summary.totals.tokens)
})

/* ---------------------------------------------------------------- CSV */

function fakeSummary(): UsageSummary {
  return {
    span: { from: '2026-10-09', to: '2026-11-07', custom: true },
    chart: [
      { day: '2026-11-06', costUsd: 0, planUsd: 0, tokens: 0, requests: 0 },
      { day: '2026-11-07', costUsd: 1.5, planUsd: 4.25, tokens: 1500, requests: 3 }
    ],
    tools: [{ tool: 'eaon', usd: 1.5, costUsd: 1.5, planUsd: 0, tokens: 1500, requests: 3 }],
    models: [
      { providerId: 'anthropic', modelId: 'claude-opus-5', toknModel: 'claude-opus-5', costUsd: 1.5, local: false, billing: 'api', requests: 2, input: 100, output: 50, cacheRead: 800, cacheWrite: 100 },
      { providerId: 'chatgpt', modelId: 'gpt-6.1-sol', toknModel: null, costUsd: 4.25, local: false, billing: 'plan', requests: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      { providerId: 'lm-studio', modelId: 'qwen3-coder', toknModel: null, costUsd: 0, local: true, billing: 'local', requests: 1, input: 3, output: 3, cacheRead: 0, cacheWrite: 0 },
      { providerId: 'custom', modelId: '=HYPERLINK("http://x")', toknModel: null, costUsd: null, local: false, billing: 'api', requests: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
    ],
    sources: [{ source: 'chat', requests: 3, tokens: 1500, costUsd: 1.5, planUsd: 0 }],
    projects: [
      { kind: 'folder', path: '/Users/ada/my, project', requests: 2, tokens: 900, costUsd: 1, planUsd: 0 },
      { kind: 'unattributed', path: '', requests: 1, tokens: 600, costUsd: 0.5, planUsd: 0 }
    ]
  } as unknown as UsageSummary
}

test('CSV: one table with a section column, plain numbers, blanks where a figure is unknown', () => {
  const csv = usageCsv(fakeSummary())
  assert.ok(csv.startsWith('\uFEFF'), 'a byte order mark, so Excel reads UTF-8')
  const lines = csv.slice(1).split('\r\n')
  assert.equal(lines.pop(), '', 'ends with a line break')
  assert.equal(lines[0], CSV_COLUMNS.join(','))
  // Empty days are left out; the day with use is in.
  assert.deepEqual(lines.filter((l) => l.startsWith('day,')), ['day,2026-11-07,,,3,,,,,1500,1.5,4.25'])
  assert.deepEqual(lines.filter((l) => l.startsWith('tool,')), ['tool,eaon,,,3,,,,,1500,1.5,0'])
  const models = lines.filter((l) => l.startsWith('model,'))
  assert.equal(models[0], 'model,claude-opus-5,anthropic,api,2,100,50,800,100,1050,1.5,')
  assert.equal(models[1], 'model,gpt-6.1-sol,chatgpt,plan,1,10,5,0,0,15,,4.25', 'a plan’s use is plan_usd, never spend')
  assert.equal(models[2], 'model,qwen3-coder,lm-studio,local,1,3,3,0,0,6,0,', 'local models are free')
  assert.ok(models[3].endsWith(',api,1,1,1,0,0,2,,'), 'unpriced: both dollar cells blank, not $0')
  assert.ok(models[3].startsWith(`model,"'=HYPERLINK(""http://x"")",custom`), 'a formula-looking name is made text and quoted')
  assert.deepEqual(lines.filter((l) => l.startsWith('project,')), ['project,"/Users/ada/my, project",,,2,,,,,900,1,0', 'project,Unattributed,,,1,,,,,600,0.5,0'])
  assert.equal(lines.filter((l) => l.startsWith('source,')).length, 1)
  // Every row has the same number of cells once quoted cells are respected.
  for (const line of lines) assert.equal(line.replace(/"[^"]*(?:""[^"]*)*"/g, 'x').split(',').length, CSV_COLUMNS.length)
})

test('CSV cells: quoting, formulas, numbers and empties', () => {
  assert.equal(csvCell('plain'), 'plain')
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell('two\nlines'), '"two\nlines"')
  for (const bad of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx']) assert.ok(csvCell(bad).startsWith("'") || csvCell(bad).startsWith(`"'`), bad)
  assert.equal(csvCell(0), '0')
  assert.equal(csvCell(Number.NaN), '')
  assert.equal(csvCell(null), '')
  assert.equal(csvCell(undefined), '')
  assert.equal(usageCsvName(fakeSummary()), 'eaon-usage-2026-10-09-to-2026-11-07.csv')
})

/* ----------------------------------------------------------- the budget */

test('a saved budget is cleaned: defaults, ranges, whole tokens, cents', () => {
  assert.deepEqual(normalizeBudget(undefined), DEFAULT_BUDGET)
  assert.deepEqual(normalizeBudget('x'), DEFAULT_BUDGET)
  assert.deepEqual(normalizeBudget({ enabled: true, unit: 'usd', limit: 12.3456, warnAt: 80.4, hardCap: true }), { enabled: true, unit: 'usd', limit: 12.35, warnAt: 80, hardCap: true })
  assert.deepEqual(normalizeBudget({ enabled: 'yes', unit: 'tokens', limit: 2_500_000.7, warnAt: 150, hardCap: 1 }), { enabled: false, unit: 'tokens', limit: 2_500_001, warnAt: 99, hardCap: false })
  assert.equal(normalizeBudget({ limit: -5 }).limit, DEFAULT_BUDGET.limit)
  assert.equal(normalizeBudget({ limit: Number.POSITIVE_INFINITY }).limit, DEFAULT_BUDGET.limit)
  assert.equal(normalizeBudget({ warnAt: 0 }).warnAt, 1)
  assert.equal(normalizeBudget({ unit: 'bitcoin' }).unit, 'usd')
})

test('the month’s use counts pay-per-token requests only, with other apps’ through Eaon, and says what it couldn’t price', () => {
  const days = {
    '2026-11-02': {
      anthropic: { 'claude-opus-5': counts(1, 1_000_000), 'mystery-model': counts(2, 500) },
      chatgpt: { 'gpt-6.1-sol': counts(9, 9_000_000) },
      'lm-studio': { qwen: counts(9, 9_000_000) },
      'eaon-gateway': { 'mimo-v2.6-flash-free': counts(5, 5_000_000) }
    },
    '2026-10-31': { anthropic: { 'claude-opus-5': counts(1, 1_000_000) } },
    '2026-11-05': { anthropic: { 'claude-opus-5': { ...counts(2, 0), unreported: 2 } } }
  }
  const sources = { '2026-11-03': { gateway: { anthropic: { 'claude-opus-5': counts(1, 0, 1_000_000) } } }, '2026-11-02': { chat: { anthropic: { 'claude-opus-5': counts(99, 99_000_000) } } } }
  const counted = (id: string): boolean => billing(id) === 'api' && id !== 'eaon-gateway'
  const usd = monthUse(days, sources, '2026-11', 'usd', PRICING, billing, counted)
  // $5 of Opus input, $25 of another app's output; the plan, the local model, Eaon Lite and October aren't in it.
  assert.equal(usd.spent, 30)
  assert.equal(usd.uncounted, 2 + 2, 'the unpriced model’s two requests and the two with no token counts')
  const tokens = monthUse(days, sources, '2026-11', 'tokens', PRICING, billing, counted)
  assert.equal(tokens.spent, 1_000_000 + 500 + 1_000_000)
  assert.equal(tokens.uncounted, 2, 'only the requests with no token counts')
  assert.equal(monthOf(new Date(2026, 10, 7)), '2026-11')
})

test('levels, percent and the cap', () => {
  const budget = { ...DEFAULT_BUDGET, enabled: true, limit: 100, warnAt: 80 }
  assert.equal(budgetLevel({ ...budget, enabled: false }, 1000), 'off')
  assert.equal(budgetLevel(budget, 79.99), 'ok')
  assert.equal(budgetLevel(budget, 80), 'warn')
  assert.equal(budgetLevel(budget, 99.99), 'warn')
  assert.equal(budgetLevel(budget, 100), 'over')
  const state = budgetState({ ...budget, hardCap: true }, '2026-11', { spent: 125, uncounted: 0 }, true)
  assert.equal(state.percent, 125)
  assert.equal(state.blocked, true)
  assert.equal(budgetState(budget, '2026-11', { spent: 125, uncounted: 0 }, true).blocked, false, 'only warning: nothing is refused')
  assert.equal(budgetState({ ...budget, hardCap: true, enabled: false }, '2026-11', { spent: 999, uncounted: 0 }, true).blocked, false)
})

test('the refusal says whose limit it is, what is used and the ways out; notices differ by cap', () => {
  const state = budgetState({ ...DEFAULT_BUDGET, enabled: true, limit: 50, hardCap: true }, '2026-11', { spent: 51.2, uncounted: 0 }, true)
  const message = budgetBlockMessage(state)
  assert.match(message, /Your Eaon budget for November 2026 is used up/)
  assert.match(message, /\$51\.20 of \$50\.00/)
  assert.match(message, /not sending this request/)
  assert.match(message, /Settings → Usage/)
  const tokens = budgetBlockMessage(budgetState({ ...DEFAULT_BUDGET, enabled: true, unit: 'tokens', limit: 2_000_000, hardCap: true }, '2026-11', { spent: 2_100_000, uncounted: 0 }, true))
  assert.match(tokens, /2\.1M tokens of 2\.0M tokens/)
  assert.match(budgetNotice(state)!.body, /not sending further pay-per-token requests/)
  assert.match(budgetNotice({ ...state, budget: { ...state.budget, hardCap: false } })!.body, /still go through/)
  const warn = budgetState({ ...DEFAULT_BUDGET, enabled: true, limit: 100, warnAt: 80 }, '2026-11', { spent: 85, uncounted: 0 }, true)
  assert.match(budgetNotice(warn)!.title, /85% used/)
  assert.equal(budgetNotice(budgetState({ ...DEFAULT_BUDGET, enabled: true }, '2026-11', { spent: 1, uncounted: 0 }, true)), null)
})

test('each alert is said once, again after the use falls below it, and a month that starts over starts over', () => {
  const at = (spent: number, month = '2026-11'): UsageBudgetState => budgetState({ ...DEFAULT_BUDGET, enabled: true, limit: 100, warnAt: 80 }, month, { spent, uncounted: 0 }, true)
  let alerts = normalizeAlerts(undefined)
  const step = (state: UsageBudgetState): 'warn' | 'over' | null => {
    const next = nextAlert(state, alerts)
    alerts = next.alerts
    return next.alert
  }
  assert.equal(step(at(10)), null)
  assert.equal(step(at(81)), 'warn')
  assert.equal(step(at(85)), null, 'once')
  assert.equal(step(at(100)), 'over')
  assert.equal(step(at(120)), null, 'once')
  assert.equal(step(at(10)), null, 'the limit was raised: back below')
  assert.equal(step(at(90)), 'warn', 'and it can be said again')
  assert.equal(step(at(10, '2026-12')), null)
  assert.equal(step(at(150, '2026-12')), 'over', 'straight to over says only over')
  assert.equal(step(at(150, '2027-01')), 'over', 'a new month')
})

/* ------------------------------------------------------------ by project */

test('a request is counted for the project its run named; one outside any run is unattributed', () => {
  resetLedgerForTests()
  store.setJson('usage-ledger.json', {})
  resetLedgerForTests()
  const at = new Date(2026, 10, 7, 10)
  recordUsage('anthropic', 'claude-opus-5', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, at, 'chat', undefined)
  withUsageProject('/work/site', () => recordUsage('anthropic', 'claude-opus-5', { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, at))
  withUsageProject('/work/site', () => withUsageSource('worker', () => recordUsage('anthropic', 'claude-opus-5', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, at)))
  withUsageProject('', () => recordUsage('anthropic', 'claude-opus-5', { input: 7, output: 7, cacheRead: 0, cacheWrite: 0 }, at))
  // Another app's request through Eaon is never a project's.
  withUsageProject('/work/site', () => recordUsage('anthropic', 'claude-opus-5', { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, at, 'gateway'))
  const projects = ledgerProjects()['2026-11-07']
  assert.deepEqual(Object.keys(projects).sort(), ['', '/work/site'])
  assert.equal(projects['/work/site'].anthropic['claude-opus-5'].requests, 2)
  assert.equal(projects['/work/site'].anthropic['claude-opus-5'].input, 101)
  assert.equal(projects[''].anthropic['claude-opus-5'].input, 7)
  flushLedger()
  resetLedgerForTests()
  assert.equal(ledgerProjects()['2026-11-07']['/work/site'].anthropic['claude-opus-5'].requests, 2, 'survives a restart')
})

test('a saved ledger’s projects are cleaned, and one saved before projects existed loads without them', () => {
  store.setJson('usage-ledger.json', {
    version: 1,
    days: { '2026-11-07': { anthropic: { 'claude-opus-5': counts(1, 1) } } },
    sources: {},
    projects: { '2026-11-07': { '/a': { anthropic: { m: { requests: '5', input: -1, output: 3 } } }, junk: 'x' }, 'not-a-day': { '/a': {} } }
  })
  resetLedgerForTests()
  assert.deepEqual(ledgerProjects(), { '2026-11-07': { '/a': { anthropic: { m: { requests: 0, input: 0, output: 3, cacheRead: 0, cacheWrite: 0 } } } } })
  store.setJson('usage-ledger.json', { version: 1, days: { '2026-11-07': { anthropic: { m: counts(1, 1) } } } })
  resetLedgerForTests()
  assert.deepEqual(ledgerProjects(), {})
})

test('the project table splits the range, and what it can’t place is Unattributed', () => {
  const now = new Date(2026, 10, 7, 15)
  const days = {
    '2026-11-05': { anthropic: { 'claude-opus-5': counts(3, 3_000_000) } }, // from before projects: all unattributed
    '2026-11-07': { anthropic: { 'claude-opus-5': counts(5, 5_000_000) }, chatgpt: { 'gpt-6.1-sol': counts(2, 1_000_000) } }
  }
  const projects = {
    '2026-11-07': {
      '/work/site': { anthropic: { 'claude-opus-5': counts(2, 2_000_000) } },
      '/work/api': { anthropic: { 'claude-opus-5': counts(1, 1_000_000) } },
      '': { chatgpt: { 'gpt-6.1-sol': counts(2, 1_000_000) } }
    }
  }
  const rows = summarizeProjects(days, projects, 7, PRICING, billing, now)
  assert.deepEqual(rows.map((r) => [r.kind, r.path, r.requests, r.tokens, r.costUsd, r.planUsd]), [
    ['folder', '/work/site', 2, 2_000_000, 10, 0],
    ['folder', '/work/api', 1, 1_000_000, 5, 0],
    ['none', '', 2, 1_000_000, 0, 0], // a plan model has no price in this table: nothing spent
    ['unattributed', '', 5, 5_000_000, 25, 0] // 3 from the 5th, and 2 of the 7th that no project claims
  ])
  // Range-wise: only the 7th.
  assert.equal(summarizeProjects(days, projects, { from: '2026-11-07', to: '2026-11-07' }, PRICING, billing, now).find((r) => r.kind === 'unattributed')!.requests, 2)
  // Everything claimed: no Unattributed row.
  assert.equal(summarizeProjects({ '2026-11-07': days['2026-11-07'] }, { '2026-11-07': { '/work/all': days['2026-11-07'] } }, 7, PRICING, billing, now).some((r) => r.kind === 'unattributed'), false)
  assert.deepEqual(summarizeProjects({}, {}, 7, PRICING, billing, now), [])
})

test('project labels: a folder’s name with its path on hover, and what the other two rows mean', () => {
  assert.equal(projectLabel({ kind: 'folder', path: '/Users/ada/code/site' }).name, 'site')
  assert.equal(projectLabel({ kind: 'folder', path: '/Users/ada/code/site' }).title, '/Users/ada/code/site')
  assert.equal(projectLabel({ kind: 'folder', path: 'C:\\Users\\ada\\site\\' }).name, 'site')
  assert.equal(projectLabel({ kind: 'none', path: '' }).name, 'No project folder')
  assert.match(projectLabel({ kind: 'unattributed', path: '' }).title!, /before Eaon noted project folders/)
})

test('runAgent: every request a run makes is counted for the run’s project folder', async () => {
  resetLedgerForTests()
  store.setJson('usage-ledger.json', {})
  resetLedgerForTests()
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-usage-project-'))
  start()
  const { server, url } = await sseServer(() => [chunk({ content: 'Hi.' }, 'stop')])
  store.saveProviderConfig({ 'fake-projects': { name: 'Fake', kind: 'openai-compatible', baseUrl: url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake-projects' }] } })
  secrets.set('fake-projects', 'key')
  const request = (folder: string | null): StreamRequest => ({
    chatId: 'c-projects',
    messageId: `m${Math.random()}`,
    providerId: 'fake-projects',
    modelId: 'fake-model',
    effort: 'medium',
    mode: 'chat',
    history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'hi' }] }],
    summary: null,
    projectInstructions: '',
    cwd: folder,
    work: { swarm: false, plan: false },
    goal: null
  })
  try {
    await runAgent(request(cwd), () => {})
    await runAgent(request(null), () => {})
  } finally {
    server.close()
  }
  const today = Object.values(ledgerProjects())[0]
  assert.equal(today[cwd]['fake-projects']['fake-model'].requests, 1)
  assert.equal(today['']['fake-projects']['fake-model'].requests, 1, 'a run with no folder is "no project", not unattributed')
})

/* --------------------------------------- the feature: summary, budget, cap */

const realFetch = globalThis.fetch
function withPrices(): () => void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (href === 'https://tokn.test/api/cli/pricing') return new Response(JSON.stringify({ models: PRICING }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    return realFetch(input, init)
  }) as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

const fake: Adapter = {
  id: 'budget-fake',
  managesContext: false,
  // 1,000,000 input tokens of Opus: $5 at the fake prices.
  turn: async () => ({ text: 'hi', calls: [], stop: 'end', usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } })
}
registerAdapter('budget-test' as Provider['kind'], fake)
const providerOf = (id: string): Provider => ({ id, kind: 'budget-test', auth: 'key', local: false }) as unknown as Provider
const turn = (provider: Provider): Promise<unknown> => adapterFor(provider).turn({ provider, modelId: 'claude-opus-5' } as unknown as TurnRequest)

/**
 * The feature is registered once for the file: it listens for every request,
 * so a second registration would count each one twice.
 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: string[] = []
let registered = false
function start(): { handlers: typeof handlers; sent: string[] } {
  if (!registered) {
    registered = true
    usageFeature.register({
      ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
      getWindow: () => null,
      getWindows: () => [],
      send: (channel: string) => void sent.push(channel),
      emitStream: () => {}
    } as unknown as FeatureContext)
  }
  return { handlers, sent }
}

test('Settings → Usage: a custom range through the feature, and a bad one falls back', async () => {
  resetLedgerForTests()
  store.setJson('usage-ledger.json', {})
  resetLedgerForTests()
  recordUsage('anthropic', 'claude-opus-5', { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, new Date(2026, 9, 15, 12), 'chat', '/work/site')
  const restore = withPrices()
  start()
  try {
    const october = (await handlers.get('usage:summary')!(null, { from: '2026-10-01', to: '2026-10-31' })) as UsageSummary
    assert.deepEqual(october.span, { from: '2026-10-01', to: '2026-10-31', custom: true })
    assert.equal(october.range, 31)
    assert.equal(october.totals.requests, 1)
    assert.equal(october.chart.length, 31)
    assert.deepEqual(october.projects.map((p) => [p.kind, p.path, p.requests]), [['folder', '/work/site', 1]])
    const preset = (await handlers.get('usage:summary')!(null, 7)) as UsageSummary
    assert.equal(preset.span.custom, false)
    assert.equal(preset.range, 7)
    assert.equal(((await handlers.get('usage:summary')!(null, { from: 'x' })) as UsageSummary).range, 30)
  } finally {
    restore()
  }
})

test('the hard cap refuses a pay-per-token request with a clear message, and leaves plans, local models and a warning-only budget alone', async () => {
  resetLedgerForTests()
  store.setJson('usage-ledger.json', {})
  resetLedgerForTests()
  const restore = withPrices()
  start()
  const budget = async (): Promise<UsageBudgetState> => (await handlers.get('usage:budget')!()) as UsageBudgetState
  const set = async (patch: object): Promise<UsageBudgetState> => (await handlers.get('usage:set-budget')!(null, patch)) as UsageBudgetState
  const paid = providerOf('budget-paid-provider')
  Notification.supported = true
  Notification.shown.length = 0
  try {
    assert.equal((await budget()).level, 'off')
    // $12 monthly, warn at 50%, stop at the limit. Each Opus request here is $5.
    let state = await set({ enabled: true, unit: 'usd', limit: 12, warnAt: 50, hardCap: true })
    assert.equal(state.level, 'ok')
    assert.ok(state.priced, 'the price table loaded')
    assert.equal(Notification.shown.length, 0, 'changing the budget says nothing')

    await turn(paid) // $5
    assert.equal((await budget()).level, 'ok')
    await turn(paid) // $10: past 50%
    state = await budget()
    assert.equal(state.level, 'warn')
    assert.equal(state.spent, 10)
    assert.match(Notification.shown.at(-1)!.options.title, /83% used/)
    await turn(paid) // $15: over, but this one was allowed (the limit wasn't reached when it started)
    state = await budget()
    assert.equal(state.level, 'over')
    assert.equal(state.blocked, true)
    assert.equal(Notification.shown.at(-1)!.options.title, 'Eaon budget reached')
    const alerts = Notification.shown.length

    // Now refused, before anything is sent, with the words a person can act on.
    await assert.rejects(turn(paid), (error: Error) => {
      assert.match(error.message, /Your Eaon budget for .* is used up: about \$15\.00 of \$12\.00/)
      assert.match(error.message, /Settings → Usage/)
      return true
    })
    assert.equal((await budget()).spent, 15, 'the refused request was never counted')
    assert.equal(Notification.shown.length, alerts, 'each alert once')

    // Plans, local models and Eaon's free tiers are never charged per token, so never refused.
    for (const id of ['chatgpt', 'lm-studio', 'eaon-gateway']) await turn(providerOf(id))

    // Warn only: the same month's use, nothing refused.
    state = await set({ hardCap: false })
    assert.equal(state.blocked, false)
    await turn(paid)
    // Raising the limit lets requests through again; turning the budget off does too.
    await set({ hardCap: true })
    await assert.rejects(turn(paid), /used up/)
    await set({ limit: 100 })
    await turn(paid)
    await set({ limit: 12 })
    await assert.rejects(turn(paid), /used up/)
    await set({ enabled: false })
    await turn(paid)
  } finally {
    Notification.supported = false
    restore()
  }
})

test('a token budget needs no prices, and the budget survives a bad patch', async () => {
  resetLedgerForTests()
  store.setJson('usage-ledger.json', {})
  resetLedgerForTests()
  start()
  const set = async (patch: unknown): Promise<UsageBudgetState> => (await handlers.get('usage:set-budget')!(null, patch)) as UsageBudgetState
  try {
    const state = await set({ enabled: true, unit: 'tokens', limit: 1_500_000, warnAt: 90, hardCap: true })
    assert.deepEqual(state.budget, { enabled: true, unit: 'tokens', limit: 1_500_000, warnAt: 90, hardCap: true })
    const paid = providerOf('budget-paid-tokens')
    await turn(paid)
    assert.equal(((await handlers.get('usage:budget')!()) as UsageBudgetState).spent, 1_000_000)
    await turn(paid)
    await assert.rejects(turn(paid), /1\.5M tokens/)
    // Nonsense in a patch is ignored or put back to something valid, never saved as is.
    const after = await set({ limit: 'lots', warnAt: -3, extra: 'x' })
    assert.equal(after.budget.limit, 50)
    assert.equal(after.budget.warnAt, 1)
    assert.equal((await set('not an object')).budget.enabled, true)
    assert.equal(store.getJson<{ extra?: string }>('usage-budget.json', {}).extra, undefined)
  } finally {
    await set({ enabled: false })
  }
})

test('the budget is the month’s: use from earlier months doesn’t count', () => {
  const localMonth = monthOf(new Date())
  const lastMonth = localDay(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15, 12))
  const use = monthUse({ [lastMonth]: { anthropic: { 'claude-opus-5': counts(1, 9_000_000) } } }, {}, localMonth, 'usd', PRICING, billing, () => true)
  assert.equal(use.spent, 0)
})
