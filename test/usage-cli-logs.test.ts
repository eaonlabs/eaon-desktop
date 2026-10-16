import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliLogs, readCliLogs, resetCliLogs } from '../src/main/features/usage/cliLogs'
import type { LedgerDays } from '../src/main/features/usage/ledger'
import { dailyTotals, summarizeTools, withCliDays } from '../src/main/features/usage/rows'

/**
 * Settings → Usage reads Claude Code's and Codex's own logs to show them next
 * to Eaon: by Tokn CLI's rules (a response counted once however many
 * transcripts repeat it, `<synthetic>` never, Codex's cached input split out),
 * and a growing file only from where it was last read.
 */

const at = (day: number, hour = 12): string => new Date(2026, 9, day, hour).toISOString()

const claude = (id: string, day: number, model = 'claude-opus-5', usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 }): string =>
  JSON.stringify({ type: 'assistant', timestamp: at(day), requestId: `req_${id}`, message: { id: `msg_${id}`, model, usage, content: [{ type: 'text', text: 'hi' }] } }) + '\n'

const codexTurn = (day: number, input: number, cached: number, output: number): string =>
  JSON.stringify({
    type: 'event_msg',
    timestamp: at(day),
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } }
  }) + '\n'

function roots(): { claudeDir: string; codexDir: string; roots: { 'claude-code': string; codex: string } } {
  const base = mkdtempSync(join(tmpdir(), 'eaon-cli-logs-'))
  const claudeDir = join(base, 'claude', 'projects')
  const codexDir = join(base, 'codex', 'sessions')
  mkdirSync(join(claudeDir, '-Users-a-app'), { recursive: true })
  mkdirSync(join(claudeDir, '-Users-a-app', 'abc', 'subagents'), { recursive: true })
  mkdirSync(join(codexDir, '2026', '10', '14'), { recursive: true })
  return { claudeDir, codexDir, roots: { 'claude-code': claudeDir, codex: codexDir } }
}

test('Claude Code: each response once across transcripts, never a synthetic one; Codex: its cached input split out', async () => {
  resetCliLogs()
  const { claudeDir, codexDir, roots: r } = roots()
  const session = join(claudeDir, '-Users-a-app', 'one.jsonl')
  writeFileSync(
    session,
    JSON.stringify({ type: 'user', timestamp: at(14), message: { role: 'user', content: 'what is "usage"?' } }) +
      '\n' +
      claude('a', 14) +
      claude('b', 14, 'claude-haiku-5-5') +
      claude('s', 14, '<synthetic>') +
      claude('c', 15)
  )
  // Resumed: the earlier responses copied into the new transcript, and a subagent's own.
  writeFileSync(join(claudeDir, '-Users-a-app', 'two.jsonl'), claude('a', 14) + claude('c', 15) + claude('d', 15))
  writeFileSync(join(claudeDir, '-Users-a-app', 'abc', 'subagents', 'agent-1.jsonl'), claude('e', 15))
  writeFileSync(
    join(codexDir, '2026', '10', '14', 'rollout-1.jsonl'),
    JSON.stringify({ type: 'turn_context', timestamp: at(14), payload: { model: 'gpt-6.1-sol' } }) +
      '\n' +
      codexTurn(14, 1000, 800, 50) +
      JSON.stringify({ type: 'event_msg', timestamp: at(14), payload: { type: 'token_count', info: null } }) +
      '\n' +
      codexTurn(14, 500, 0, 25)
  )

  await readCliLogs(r)
  const logs = cliLogs()
  assert.equal(logs.reading, false)
  assert.deepEqual([...logs.found].sort(), ['claude-code', 'codex'])

  const oct14 = logs.days['2026-10-14']
  assert.deepEqual(oct14['cli:claude-code']['claude-opus-5'], { requests: 1, input: 10, output: 20, cacheRead: 300, cacheWrite: 40 }, 'a counted once, though both transcripts have it')
  assert.equal(oct14['cli:claude-code']['claude-haiku-5-5'].requests, 1)
  assert.equal(oct14['cli:claude-code']['<synthetic>'], undefined, 'never sent to the API')
  assert.deepEqual(oct14['cli:codex']['gpt-6.1-sol'], { requests: 2, input: 200 + 500, output: 75, cacheRead: 800, cacheWrite: 0 })
  assert.equal(logs.days['2026-10-15']['cli:claude-code']['claude-opus-5'].requests, 3, 'c once, d, and the subagent’s e')
})

test('a transcript being written is read on from where it stopped, its unfinished line left for later', async () => {
  resetCliLogs()
  const { claudeDir, roots: r } = roots()
  const session = join(claudeDir, '-Users-a-app', 'live.jsonl')
  writeFileSync(session, claude('a', 14))
  await readCliLogs(r)
  assert.equal(cliLogs().days['2026-10-14']['cli:claude-code']['claude-opus-5'].requests, 1)

  const next = claude('b', 14)
  appendFileSync(session, next.slice(0, 40))
  await readCliLogs(r)
  assert.equal(cliLogs().days['2026-10-14']['cli:claude-code']['claude-opus-5'].requests, 1, 'half a line is not a response yet')

  appendFileSync(session, next.slice(40) + claude('c', 14))
  await readCliLogs(r)
  assert.equal(cliLogs().days['2026-10-14']['cli:claude-code']['claude-opus-5'].requests, 3, 'b once finished, then c; a not again')
})

test('with the logs: Eaon’s own Codex-engine turns aren’t counted twice, and each tool gets its share', () => {
  const now = new Date(2026, 9, 15, 15)
  const counts = (requests: number, input: number) => ({ requests, input, output: 0, cacheRead: 0, cacheWrite: 0 })
  const eaon: LedgerDays = {
    '2026-10-15': { anthropic: { 'claude-opus-5': counts(2, 1_000_000) }, codex: { 'gpt-6.1-sol': counts(5, 9) } }
  }
  const cli: LedgerDays = {
    '2026-10-14': { 'cli:claude-code': { 'claude-opus-5': counts(4, 2_000_000) } },
    '2026-10-15': { 'cli:codex': { 'gpt-6.1-sol': counts(7, 100) } }
  }
  const pricing = { 'claude-opus-5': { input: 5, output: 25 } }
  const billing = (id: string) => (id.startsWith('cli:') || id === 'codex' ? 'plan' : 'api') as 'plan' | 'api'

  const merged = withCliDays(eaon, cli, true)
  assert.equal(merged['2026-10-15'].codex, undefined, 'Codex logged those turns itself')
  assert.ok(withCliDays(eaon, cli, false)['2026-10-15'].codex, 'kept when there are no Codex logs to count them')

  const byDay = dailyTotals(merged, pricing, billing, true)
  assert.equal(byDay.get('2026-10-14')!.requests, 4, 'a day only Claude Code was used is an active day')
  assert.deepEqual(byDay.get('2026-10-15')!.tools, { eaon: { usd: 5, tokens: 1_000_000, requests: 2 }, codex: { usd: 0, tokens: 100, requests: 7 } })

  const tools = summarizeTools(merged, 7, pricing, billing, now)
  assert.deepEqual(
    tools.map((t) => [t.tool, t.requests, t.costUsd, t.planUsd]),
    [
      ['claude-code', 4, 0, 10],
      ['eaon', 2, 5, 0],
      ['codex', 7, 0, 0]
    ]
  )
})

test('a Claude response’s 1-hour cache writes are kept apart from its 5-minute ones', async () => {
  resetCliLogs()
  const { claudeDir, roots: r } = roots()
  writeFileSync(
    join(claudeDir, '-Users-a-app', 'hour.jsonl'),
    claude('h', 14, 'claude-opus-5', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 } } as never)
  )
  await readCliLogs(r)
  assert.deepEqual(cliLogs().days['2026-10-14']['cli:claude-code']['claude-opus-5'], { requests: 1, input: 1, output: 2, cacheRead: 0, cacheWrite: 100, cacheWrite1h: 400 })
})
