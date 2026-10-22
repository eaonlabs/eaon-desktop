import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { secrets } from '../src/main/secrets'
import { glmWindows, kimiWindows, minimaxWindows, readConsoleOnly, readGlm, readKimi, readMinimax } from '../src/main/features/providerUsage/plans'
import { readOpencode } from '../src/main/features/providerUsage/readers'

/**
 * Coding plans read with the key saved in Settings → Model providers. The
 * answers are shaped like the providers' own: Kimi Code's managed-usage
 * parser and tests, Z.ai's quota monitor as its coding plugin reads it, and
 * MiniMax's CLI fixture. No network: fetch is scripted.
 */

const realFetch = globalThis.fetch
// A home of its own, so OpenCode's real sign-in on this computer is never read.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-plan-usage-'))
delete process.env.XDG_DATA_HOME
delete process.env.OPENCODE_DATA_DIR

/** Answers each URL with the body (or status) the test gives; records what was asked, with which Authorization. */
function script(answers: Record<string, { status?: number; body?: unknown }>): { asked: string[] } {
  const asked: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    asked.push(`${url} ${new Headers(init?.headers).get('authorization')}`)
    const answer = answers[url]
    if (!answer) return new Response('not here', { status: 404 })
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { asked }
}

const KIMI = {
  usage: { used: '40', limit: '1000', resetTime: '2026-10-25T05:20:51Z' },
  limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { used: '12', limit: '100', resetTime: '2026-10-21T20:00:00Z' } }]
}

test('Kimi For Coding: the five-hour window and the week, as requests used', () => {
  const windows = kimiWindows(KIMI)
  assert.deepEqual(
    windows.map((w) => [w.id, w.label, w.span, w.percent, w.detail]),
    [
      ['session', 'Session', '5 hours', 12, '12 of 100 requests'],
      ['week', 'Week', 'rolling 7 days', 4, '40 of 1,000 requests']
    ]
  )
  assert.equal(windows[1].resetsAt, Date.parse('2026-10-25T05:20:51Z'))
  assert.deepEqual(kimiWindows({ usage: { used: 'x' }, limits: 'nope' }), [], 'a reshaped answer costs rows, never the card')
})

test('GLM Coding Plan: session, week and the month’s web tools from the quota monitor', () => {
  const windows = glmWindows({
    level: 'pro',
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 13, nextResetTime: 1792630000000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 41.5, nextResetTime: 1793000000000 },
      { type: 'TIME_LIMIT', percentage: 2, currentValue: 21, usage: 1000 }
    ]
  })
  assert.deepEqual(
    windows.map((w) => [w.id, w.label, w.percent, w.detail ?? null]),
    [
      ['session', 'Session', 13, null],
      ['week', 'Week', 41.5, null],
      ['tools', 'Web tools', 2, '21 of 1,000 calls']
    ]
  )
  assert.equal(windows[0].resetsAt, 1792630000000)
})

test('MiniMax Token Plan: the text models’ row, counts read by the percentage when sent', () => {
  // MiniMax CLI's fixture: no percentage, so the counts are what is left (the old meaning).
  const legacy = minimaxWindows({
    model_remains: [
      { model_name: 'MiniMax-M*', start_time: 1776355200000, end_time: 1776373200000, current_interval_total_count: 1500, current_interval_usage_count: 1272, current_weekly_total_count: 0, current_weekly_usage_count: 0 },
      { model_name: 'speech-hd', current_interval_total_count: 9000, current_interval_usage_count: 0 }
    ]
  })
  assert.deepEqual(
    legacy.map((w) => [w.id, w.span, Math.round(w.percent), w.detail]),
    [['session', '5 hours', 15, '228 of 1,500 prompts']]
  )
  // With percentages, they decide; status 3 is an unlimited week.
  const current = minimaxWindows({
    model_remains: [
      { model_name: 'MiniMax-M*', current_interval_total_count: 1500, current_interval_usage_count: 300, current_interval_remaining_percent: 80, current_weekly_total_count: 9000, current_weekly_usage_count: 900, current_weekly_remaining_percent: 90 }
    ]
  })
  assert.deepEqual(current.map((w) => [w.id, w.percent]), [['session', 20], ['week', 10]])
  const unlimited = minimaxWindows({ model_remains: [{ model_name: 'MiniMax-M*', current_interval_total_count: 100, current_interval_usage_count: 100, current_weekly_total_count: 1, current_weekly_status: 3 }] })
  assert.deepEqual(unlimited.map((w) => w.id), ['session'])
})

test('each plan is read with its own saved key, from the provider’s own host; no key, no card', async () => {
  const keys = ['kimi-coding', 'zai-coding', 'zai-coding-cn', 'minimax', 'minimax-cn', 'qwen-token-plan', 'xiaomi-token-plan', 'opencode-go']
  try {
    script({})
    assert.equal(await readKimi(), null)
    assert.equal(await readGlm(), null)
    assert.equal(await readMinimax(), null)
    assert.deepEqual(readConsoleOnly(), [])

    secrets.set('kimi-coding', 'sk-kimi-test')
    secrets.set('zai-coding-cn', 'zhipu.key')
    secrets.set('minimax', 'sk-cp-plan')
    secrets.set('opencode-go', 'sk-go-test')
    const { asked } = script({
      'https://api.kimi.com/coding/v1/usages': { body: KIMI },
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit': { body: { code: 200, data: { level: 'lite', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 50 }] } } },
      'https://api.minimax.io/v1/token_plan/remains': { body: { base_resp: { status_code: 0 }, model_remains: [{ model_name: 'MiniMax-M*', current_interval_total_count: 10, current_interval_usage_count: 4, current_interval_remaining_percent: 60 }] } },
      'https://opencode.ai/zen/go/v1/usage': { body: { usage: { rolling: { percent: 12, resetsAt: 1792630000 } } } }
    })
    const kimi = await readKimi()
    assert.equal(kimi?.status, 'ok')
    assert.equal(kimi?.windows.length, 2)
    const glm = await readGlm()
    assert.equal(glm?.plan, 'GLM Coding Lite')
    assert.equal(glm?.windows[0].percent, 50)
    const minimax = await readMinimax()
    assert.equal(minimax?.windows[0].percent, 40)
    const opencode = await readOpencode()
    assert.equal(opencode?.windows[0]?.percent, 12, 'OpenCode Go with the key saved in Eaon, without the OpenCode CLI')
    assert.ok(asked.includes('https://api.kimi.com/coding/v1/usages Bearer sk-kimi-test'))
    assert.ok(asked.includes('https://open.bigmodel.cn/api/monitor/usage/quota/limit zhipu.key'), 'Z.ai’s monitor takes the bare key, and the China key goes to the China host')
    assert.ok(asked.includes('https://api.minimax.io/v1/token_plan/remains Bearer sk-cp-plan'))

    // A rejected key says so; a key without a plan says that.
    script({ 'https://api.kimi.com/coding/v1/usages': { status: 401 }, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit': { body: { code: 200, msg: 'ok' } } })
    assert.equal((await readKimi())?.status, 'signed-out')
    assert.equal((await readGlm())?.status, 'unsupported')

    // A pay-as-you-go MiniMax key has no plan to read, and isn't sent anywhere.
    secrets.set('minimax', 'sk-api-paygo')
    const paygo = script({})
    assert.equal(await readMinimax(), null)
    assert.equal(paygo.asked.length, 0)

    // Alibaba's and Xiaomi's plans have no usage endpoint: a card says where to look.
    secrets.set('qwen-token-plan', 'sk-sp-test')
    secrets.set('xiaomi-token-plan', 'tp-test')
    assert.deepEqual(
      readConsoleOnly().map((c) => [c.id, c.status]),
      [
        ['qwen', 'unsupported'],
        ['mimo', 'unsupported']
      ]
    )
  } finally {
    for (const key of keys) secrets.clear(key)
    globalThis.fetch = realFetch
  }
})
