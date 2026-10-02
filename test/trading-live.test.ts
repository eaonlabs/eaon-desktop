import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import { registerToolSource } from '../src/main/agent/tools'
import { getProvider, refreshModels } from '../src/main/providers'
import { store } from '../src/main/store'
import { defaultConfig, TradingEngine } from '../src/main/features/trading/engine'
import { YahooMarketData } from '../src/main/features/trading/marketData'
import { tradingToolSource } from '../src/main/features/trading/tools'
import type { StreamEvent } from '@shared/types'

/**
 * Opt-in (EAON_LIVE=1): a real trading session on the simulator — live Yahoo
 * prices, a real model through the real agent loop and tools — for a few
 * checks, printing what the agent looked at, what it ordered and what each
 * check cost. Fills happen at the last price even with the market closed.
 *
 *   EAON_LIVE=1 EAON_TEST_OUT=t-live npm run test:main -- trading-live
 *   EAON_LIVE_MODEL=qwen3.5:9b EAON_LIVE_CHECKS=3 …   (defaults: gpt-oss:20b, 2 checks)
 */

const MODEL = process.env.EAON_LIVE_MODEL ?? 'gpt-oss:20b'
const CHECKS = Number(process.env.EAON_LIVE_CHECKS ?? 2)
const STRATEGY =
  process.env.EAON_LIVE_STRATEGY ??
  'Swing-trade large US tech stocks and the big index ETFs. Buy strength: names above their 20- and 50-day averages that are up today on good volume, ' +
    'with a protective stop under each new position. Cut losers quickly, let winners run. Keep at most 4 positions.'

async function ollamaUp(): Promise<string[]> {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) })
    return ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? []
  } catch {
    return []
  }
}

test(`a live trading session on the simulator (${MODEL})`, { skip: !process.env.EAON_LIVE, timeout: 30 * 60_000 }, async (t) => {
  if (!(await ollamaUp()).includes(MODEL)) return t.skip(`Ollama is not running, or ${MODEL} is not installed`)
  await refreshModels('ollama')
  const model = getProvider('ollama')!.models.find((m) => m.id === MODEL)
  assert.ok(model, `${MODEL} not listed`)

  const events: { at: number; event: StreamEvent }[] = []
  const engine = new TradingEngine({
    prices: new YahooMarketData(),
    runAgent: (request, emit, options) =>
      runAgent(
        request,
        (event) => {
          events.push({ at: Date.now(), event })
          emit(event)
        },
        options
      ),
    getSettings: () => store.getSettings(),
    getKeys: () => null,
    saveKeys: () => {},
    loadConfig: () => ({ ...defaultConfig(), simulatorAnytime: true }),
    saveConfig: () => {},
    loadOrders: () => [],
    saveOrders: () => {},
    loadEquity: () => ({}),
    saveEquity: () => {},
    loadSchedules: () => [],
    saveSchedules: () => {},
    loadSessions: () => [],
    saveSessions: () => {},
    loadSim: () => null,
    saveSim: () => {},
    resolveModel: () => ({ ok: true, providerId: 'ollama', modelId: MODEL, model }),
    workFolder: () => mkdtempSync(join(tmpdir(), 'eaon-trading-live-')),
    // A session "minute" is a second: the next check follows the last one closely.
    minuteMs: 1000,
    stallMs: 5 * 60_000
  })
  engine.load()
  registerToolSource(tradingToolSource(engine))
  engine.start()

  const started = Date.now()
  const session = await engine.startSession({ strategy: STRATEGY, until: Date.now() + 25 * 60_000, everyMinutes: 1, name: 'Live check' })
  try {
    while ((engine.activeSession()?.checks ?? CHECKS) < CHECKS && Date.now() - started < 25 * 60_000) await new Promise((r) => setTimeout(r, 1000))
  } finally {
    await engine.stopSession(session.id, 'Live test finished.')
  }

  const snap = engine.snapshot()
  const ended = snap.sessions.find((s) => s.id === session.id)!
  const calls = events.filter((e) => e.event.type === 'tool-call').map((e) => e.event as { name: string; input?: unknown })
  const usage = events
    .filter((e) => e.event.type === 'usage')
    .reduce((sum, e) => {
      const u = (e.event as { usage?: { input: number; output: number } }).usage
      return { input: sum.input + (u?.input ?? 0), output: sum.output + (u?.output ?? 0) }
    }, { input: 0, output: 0 })
  console.log(`\n=== ${MODEL}: ${ended.checks} checks in ${Math.round((Date.now() - started) / 1000)} s, ${calls.length} tool calls, tokens in ${usage.input} out ${usage.output}`)
  console.log('Tool calls:', calls.map((c) => `${c.name}(${JSON.stringify(c.input ?? {}).slice(0, 120)})`).join('\n  '))
  console.log('Log:\n' + ended.log.map((e) => `  [${e.kind}] ${e.text}`).join('\n'))
  console.log('Orders:\n' + snap.orders.map((o) => `  ${o.status} ${o.side} ${o.qty} ${o.symbol} @ ${o.filledAvgPrice ?? o.limitPrice ?? 'mkt'} — ${o.reason}${o.error ? ` (${o.error})` : ''}`).join('\n'))
  console.log('Positions:', snap.positions.map((p) => `${p.symbol} ${p.qty}`).join(', ') || 'none')
  engine.stop()
  await engine.whenIdle()
  assert.ok(ended.checks >= 1, 'no check finished')
  assert.ok(!ended.log.some((e) => e.kind === 'error'), `a check failed: ${ended.log.find((e) => e.kind === 'error')?.text}`)
})
