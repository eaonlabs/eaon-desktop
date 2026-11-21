import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addSpend,
  budgetHit,
  budgetReason,
  budgetUsageLines,
  isTransientError,
  normalizeBudget,
  normalizeRetry,
  normalizeSites,
  normalizeToolRules,
  parseSiteList,
  periodEnd,
  periodStart,
  retryDelayMs,
  retryLabel,
  seedSpend,
  siteEntry,
  siteVerdict,
  spendNow,
  usageTokens,
  waitText
} from '@shared/workerLimits'

/** The owner's limits on a worker, as pure rules: the spend cap, retries, websites and tool rules. */

// Local noon, so a day or a month boundary is never within reach of the assertions.
const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime()

/* ------------------------------------------------------------------ spend cap */

test('a budget is kept only while it sets a limit, and typed text is repaired', () => {
  assert.equal(normalizeBudget(null), null)
  assert.equal(normalizeBudget({ tokens: null, usd: null, period: 'day' }), null)
  assert.equal(normalizeBudget({ tokens: 0, usd: 0 }), null, 'zero is no cap')
  assert.deepEqual(normalizeBudget({ tokens: '50000', usd: '', period: 'month' }), { tokens: 50000, usd: null, period: 'month' })
  assert.deepEqual(normalizeBudget({ tokens: 12.9, usd: 5.678, period: 'week' }), { tokens: 12, usd: 5.68, period: 'day' }, 'whole tokens, whole cents, a period it knows')
  assert.equal(normalizeBudget({ tokens: -5, usd: 'abc' }), null)
})

test('the period starts at local midnight, or on the 1st, and ends at the next', () => {
  const now = at(2026, 10, 15, 14)
  assert.equal(periodStart('day', now), at(2026, 10, 15, 0))
  assert.equal(periodEnd('day', now), at(2026, 10, 16, 0))
  assert.equal(periodStart('month', now), at(2026, 10, 1, 0))
  assert.equal(periodEnd('month', now), at(2026, 11, 1, 0))
  assert.equal(periodEnd('month', at(2026, 12, 20)), at(2027, 1, 1, 0), 'December rolls into the next year')
})

test('a run counts its input and output tokens, and the period starts over on its own', () => {
  assert.equal(usageTokens({ input: 1200, output: 300 }), 1500)
  assert.equal(usageTokens(null), 0)
  const today = at(2026, 10, 15)
  let spend = addSpend(null, 'day', today, { tokens: 400, usd: 0.25 })
  spend = addSpend(spend, 'day', today + 60_000, { tokens: 100, usd: 0.1 })
  assert.deepEqual(spend, { since: at(2026, 10, 15, 0), tokens: 500, usd: 0.35 })
  const tomorrow = at(2026, 10, 16, 9)
  assert.deepEqual(spendNow(spend, 'day', tomorrow), { since: at(2026, 10, 16, 0), tokens: 0, usd: 0 }, 'yesterday’s use is not today’s')
  assert.equal(addSpend(spend, 'day', tomorrow, { tokens: 7, usd: 0 }).tokens, 7)
})

test('a cap that was just set counts what the worker already used in the period', () => {
  const now = at(2026, 10, 15, 15)
  const seeded = seedSpend(
    [
      { endedAt: at(2026, 10, 14, 23), tokens: 900, usd: 1 },
      { endedAt: at(2026, 10, 15, 9), tokens: 300, usd: 0.5 },
      { endedAt: at(2026, 10, 15, 11), tokens: 200, usd: null },
      { endedAt: null, tokens: 5000, usd: null }
    ],
    'day',
    now
  )
  assert.deepEqual(seeded, { since: at(2026, 10, 15, 0), tokens: 500, usd: 0.5 })
  assert.equal(seedSpend([{ endedAt: at(2026, 10, 3), tokens: 40, usd: 0 }, { endedAt: at(2026, 9, 30), tokens: 99, usd: 0 }], 'month', now).tokens, 40)
})

test('the cap is reached at the limit, tokens first, and says so plainly', () => {
  const now = at(2026, 10, 15)
  const budget = normalizeBudget({ tokens: 1000, usd: 2, period: 'day' })!
  assert.equal(budgetHit(null, null, now), null)
  assert.equal(budgetHit(budget, { since: at(2026, 10, 15, 0), tokens: 999, usd: 1.99 }, now), null)
  const tokens = budgetHit(budget, { since: at(2026, 10, 15, 0), tokens: 1000, usd: 0 }, now)
  assert.deepEqual(tokens, { limit: 'tokens', used: 1000, cap: 1000 })
  assert.equal(budgetReason(tokens!, 'day'), 'Used 1,000 of its 1,000 tokens for today. It starts again at midnight, or raise the cap in Edit to let it carry on.')
  const money = budgetHit(budget, { since: at(2026, 10, 15, 0), tokens: 5, usd: 2.5 }, now)
  assert.equal(budgetReason(money!, 'month'), 'Spent about $2.50 of its $2.00 for this month. It starts again on the 1st, or raise the cap in Edit to let it carry on.')
  assert.equal(budgetHit(budget, { since: at(2026, 10, 14, 0), tokens: 99999, usd: 99 }, now), null, 'last period’s spend is forgotten')
  assert.deepEqual(budgetUsageLines(budget, { since: at(2026, 10, 15, 0), tokens: 12400, usd: 0.3 }, now), ['12,400 of 1,000 tokens today', 'about $0.30 of $2.00 today'])
})

/* -------------------------------------------------------------------- retries */

test('retries are limited, and each wait doubles up to a ceiling', () => {
  assert.equal(normalizeRetry(null), null)
  assert.equal(normalizeRetry({ attempts: 0, minutes: 5 }), null)
  assert.deepEqual(normalizeRetry({ attempts: 3, minutes: 5 }), { attempts: 3, minutes: 5 })
  assert.deepEqual(normalizeRetry({ attempts: 99, minutes: 9999 }), { attempts: 5, minutes: 120 })
  assert.deepEqual(normalizeRetry({ attempts: 2 }), { attempts: 2, minutes: 2 })
  const retry = { attempts: 5, minutes: 2 }
  assert.deepEqual([1, 2, 3, 4].map((n) => retryDelayMs(retry, n) / 60_000), [2, 4, 8, 16])
  assert.equal(retryDelayMs({ attempts: 5, minutes: 120 }, 5), 4 * 60 * 60_000, 'no wait is longer than four hours')
  assert.equal(waitText(2 * 60_000), '2 min')
  assert.equal(waitText(3 * 3_600_000), '3 h')
  assert.equal(retryLabel(2, 3, 'Retry 1 of 3: Daily research'), 'Retry 2 of 3: Daily research', 'a retry of a retry names the original')
})

test('only an error that passes by itself is worth another try', () => {
  const passing = [
    'Ollama didn’t answer in time. Try again.',
    'Couldn’t reach OpenAI. Check your internet connection and try again.',
    'The connection to Anthropic dropped. Check your internet connection and try again.',
    'Anthropic is having problems right now (503). Try again in a few minutes.',
    'OpenAI is limiting how fast requests can be made. Try again in 20 s.',
    'No progress for 15 minutes, so the turn was stopped. The model or a tool stopped responding.',
    'Codex couldn’t reach its service. Check your connection, then retry.',
    'fetch failed: ECONNRESET',
    'Codex stopped responding and was restarted. Retry the run.',
    '529 overloaded_error'
  ]
  const lasting = [
    'Your OpenAI session expired. Sign in again.',
    'You’re signed out of ChatGPT. Sign in again to keep using it.',
    'OpenAI rejected the API key. Check it, or paste a new one.',
    'OpenAI says the account is out of credit or over its quota. Add credit with OpenAI, or use another key.',
    'You’ve reached your Claude plan’s usage limit. It resets later, or choose another model.',
    'OpenAI doesn’t offer this model to your account. Choose another model.',
    'Codex isn’t installed on this computer (or Eaon can’t find it).',
    'Daily limit reached. This gateway allows 20 requests a day per user. Try again in 18 h.',
    'This worker follows Chat’s model (gpt-5), which isn’t available right now.',
    '401: Unauthorized',
    '',
    null
  ]
  for (const text of passing) assert.equal(isTransientError(text), true, text)
  for (const text of lasting) assert.equal(isTransientError(text), false, String(text))
})

/* ------------------------------------------------------------------- websites */

test('a typed site is reduced to its host, and what is not a site is set aside', () => {
  assert.equal(siteEntry('https://www.Example.com/a/b?x=1#top'), 'www.example.com')
  assert.equal(siteEntry('*.example.com'), 'example.com')
  assert.equal(siteEntry('example.com:8443'), 'example.com')
  assert.equal(siteEntry('user@mail.example.com'), 'mail.example.com')
  assert.equal(siteEntry('localhost'), 'localhost')
  assert.equal(siteEntry('not a site'), null)
  assert.equal(siteEntry('example'), null, 'a bare word is not a site')
  assert.equal(siteEntry('exa mple.com'), null)
  assert.deepEqual(parseSiteList('github.com, https://docs.github.com/x\nnonsense  github.com'), { entries: ['github.com', 'docs.github.com'], invalid: ['nonsense'] })
  assert.equal(normalizeSites({ allow: [], deny: [] }), null)
  assert.deepEqual(normalizeSites({ allow: ['GitHub.com', 'bad one'], deny: ['https://ads.example.com/'] }), { allow: ['github.com'], deny: ['ads.example.com'] })
})

test('a blocked site is refused for every request; the allowed list limits where it goes', () => {
  const rules = normalizeSites({ allow: ['github.com'], deny: ['gist.github.com'] })!
  const ok = (url: string, navigation = true): boolean => siteVerdict(rules, url, { navigation }).allowed
  assert.equal(ok('https://github.com/eaon'), true)
  assert.equal(ok('https://docs.github.com/'), true, 'a listed site covers its subdomains')
  assert.equal(ok('https://gist.github.com/x'), false, 'the blocked list wins over the allowed one')
  assert.equal(ok('https://notgithub.com/'), false, 'a different site that ends in the same letters is another site')
  assert.equal(ok('https://example.com/'), false)
  assert.equal(ok('https://cdn.example.com/app.js', false), true, 'what an allowed page loads is not a visit')
  assert.equal(ok('https://gist.github.com/app.js', false), false, 'a blocked site is blocked for images and scripts too')
  assert.equal(ok('about:blank'), true)
  assert.equal(ok('data:text/html,hi'), true)
  const refused = siteVerdict(rules, 'https://example.com/', { navigation: true })
  assert.equal(refused.allowed, false)
  assert.match(refused.allowed ? '' : refused.reason, /example\.com isn't one of the sites the user allowed/)
  assert.equal(siteVerdict(null, 'https://anything.test/').allowed, true)
  assert.equal(siteVerdict({ allow: [], deny: ['ads.test'] }, 'https://ads.test./x').allowed, false, 'a trailing dot is the same host')
})

/* ----------------------------------------------------------------- tool rules */

test('tool rules keep only ask and block', () => {
  assert.equal(normalizeToolRules(null), null)
  assert.equal(normalizeToolRules([]), null)
  assert.deepEqual(normalizeToolRules({ run_command: 'ask', web_browser: 'block', read_file: 'allow', '': 'ask', x: 3 }), { run_command: 'ask', web_browser: 'block' })
  assert.equal(normalizeToolRules({ read_file: 'allow' }), null)
})
