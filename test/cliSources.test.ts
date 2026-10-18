import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliDays } from '../src/main/features/usage/cliFiles'
import { cliLogs, importCursorCsv, readCliLogs, resetCliLogs } from '../src/main/features/usage/cliLogs'
import {
  cursorDays,
  dayOf,
  droidModel,
  parseCursorCsv,
  readAmp,
  readCopilot,
  readDroid,
  readGemini,
  readGrok,
  readKimi,
  readOpencode,
  readQwen,
  sourceRoots
} from '../src/main/features/usage/cliSources'
import { localDay } from '../src/main/features/usage/ledger'
import { summarize, type ToknPricing } from '../src/main/features/usage/rows'

/**
 * Settings → Usage for the CLIs past Claude and Codex: each tool's own record
 * of what it used, in the shape that tool writes it, read into days.
 */

const home = mkdtempSync(join(tmpdir(), 'eaon-cli-sources-'))
const now = new Date()
const today = localDay(now)
const iso = now.toISOString()

const total = (days: CliDays): number => Object.values(days).reduce((n, models) => n + Object.values(models).reduce((m, c) => m + c.requests, 0), 0)
const only = (days: CliDays): { model: string; counts: CliDays[string][string] } => {
  const [model, counts] = Object.entries(days[today] ?? {})[0] ?? []
  return { model: model ?? '', counts: counts! }
}

function write(path: string, text: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

type Sqlite = { DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void } }
const sqlite = process.getBuiltinModule?.('node:sqlite') as Sqlite | undefined

test('a day comes from an ISO time, seconds or milliseconds, or SQLite’s zone-less UTC', () => {
  assert.equal(dayOf(iso, 'x'), today)
  assert.equal(dayOf(now.getTime(), 'x'), today)
  assert.equal(dayOf(now.getTime() / 1000, 'x'), today)
  assert.equal(dayOf(iso.slice(0, 19).replace('T', ' '), 'x'), today)
  assert.equal(dayOf('not a date', 'fallback'), 'fallback')
})

test('Gemini CLI: a whole-session file, and a JSONL recording where a reply is rewritten as it fills in', async () => {
  const dir = join(home, 'gemini', 'tmp', 'abc', 'chats')
  const json = write(
    join(dir, 'session-1.json'),
    JSON.stringify({
      sessionId: 's',
      messages: [
        { id: 'u', type: 'user', timestamp: iso, content: 'hi' },
        // The total shows the cached 40 are inside the 100 prompt tokens.
        { id: 'g', type: 'gemini', timestamp: iso, model: 'gemini-2.5-pro', tokens: { input: 100, output: 20, cached: 40, thoughts: 5, tool: 0, total: 125 } }
      ]
    })
  )
  assert.deepEqual(only(await readGemini(json)), { model: 'gemini-2.5-pro', counts: { requests: 1, input: 60, output: 25, cacheRead: 40, cacheWrite: 0 } })

  const jsonl = write(
    join(dir, 'session-2.jsonl'),
    [
      { type: 'init', model: 'gemini-2.5-flash' },
      { id: 'a', type: 'gemini', timestamp: iso, tokens: { input: 10, output: 1 } },
      { id: 'a', type: 'gemini', timestamp: iso, tokens: { input: 10, output: 7 } },
      { id: 'b', type: 'gemini', timestamp: iso, model: 'gemini-2.5-pro', tokens: { input: 3, output: 3 } }
    ]
      .map((r) => JSON.stringify(r))
      .join('\n')
  )
  const days = await readGemini(jsonl)
  assert.equal(total(days), 2)
  assert.deepEqual(days[today]['gemini-2.5-flash'], { requests: 1, input: 10, output: 7, cacheRead: 0, cacheWrite: 0 })
})

test('Qwen Code: assistant lines with usageMetadata, thoughts as output', async () => {
  const file = write(
    join(home, 'qwen', 'projects', 'p', 'chats', 's.jsonl'),
    [
      { type: 'user', timestamp: iso, content: 'hi' },
      { type: 'assistant', model: 'qwen3-coder-plus', timestamp: iso, usageMetadata: { promptTokenCount: 1508, candidatesTokenCount: 205, thoughtsTokenCount: 50, cachedContentTokenCount: 4864 } },
      { type: 'assistant', model: 'qwen3-coder-plus', timestamp: iso, usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } }
    ]
      .map((r) => JSON.stringify(r))
      .join('\n')
  )
  assert.deepEqual(only(await readQwen(file)), { model: 'qwen3-coder-plus', counts: { requests: 1, input: 1508, output: 255, cacheRead: 4864, cacheWrite: 0 } })
})

test('Grok Build: each inference once, under the model the log last named, else the session’s own', async () => {
  const root = join(home, 'grok')
  write(join(root, 'sessions', '%2Fwork', 'sess-b', 'summary.json'), JSON.stringify({ current_model_id: 'grok-4' }))
  const inference = (sid: string, id: string, prompt: number, cached: number, completion: number): unknown => ({
    ts: iso,
    pid: 7,
    sid,
    msg: 'shell.turn.inference_done',
    event_id: id,
    ctx: { prompt_tokens: prompt, cached_prompt_tokens: cached, completion_tokens: completion, reasoning_tokens: 2, loop_index: 1 }
  })
  const file = write(
    join(root, 'logs', 'unified.jsonl'),
    [
      { msg: 'model changed', sid: 'sess-a', pid: 7, ctx: { model: 'grok-code-fast-1' } },
      inference('sess-a', 'e1', 100, 60, 10),
      inference('sess-a', 'e1', 100, 60, 10),
      inference('sess-b', 'e2', 50, 0, 5),
      { msg: 'something else', sid: 'sess-a' }
    ]
      .map((r) => JSON.stringify(r))
      .join('\n')
  )
  const days = await readGrok(file, root)
  assert.equal(total(days), 2)
  assert.deepEqual(days[today]['grok-code-fast-1'], { requests: 1, input: 40, output: 10, cacheRead: 60, cacheWrite: 0 })
  assert.deepEqual(days[today]['grok-4'], { requests: 1, input: 50, output: 5, cacheRead: 0, cacheWrite: 0 })
})

test('Copilot CLI and opencode: read from their SQLite databases', { skip: !sqlite && 'no node:sqlite here' }, async () => {
  const copilot = join(mkdtempSync(join(tmpdir(), 'copilot-')), 'session-store.db')
  let db = new sqlite!.DatabaseSync(copilot)
  db.exec(`CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
           cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT DEFAULT (datetime('now')));
           INSERT INTO assistant_usage_events (model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES ('claude-sonnet-4.5', 10, 2, 300, 40);
           INSERT INTO assistant_usage_events (model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at) VALUES ('gpt-5', 5, 1, 0, 0, '${iso}');`)
  db.close()
  const days = await readCopilot(copilot)
  assert.equal(total(days), 2)
  assert.deepEqual(days[today]['claude-sonnet-4.5'], { requests: 1, input: 10, output: 2, cacheRead: 300, cacheWrite: 40 })

  const opencode = join(mkdtempSync(join(tmpdir(), 'opencode-')), 'opencode.db')
  db = new sqlite!.DatabaseSync(opencode)
  const message = (data: unknown): string => `INSERT INTO message (time_created, data) VALUES (${now.getTime()}, '${JSON.stringify(data)}');`
  db.exec(
    `CREATE TABLE message (id INTEGER PRIMARY KEY, time_created INTEGER, data TEXT);` +
      message({ role: 'user', time: { created: now.getTime() } }) +
      message({ role: 'assistant', modelID: 'kimi-k2', cost: 0.25, tokens: { input: 100, output: 10, reasoning: 4, cache: { read: 50, write: 0 } }, time: { created: now.getTime() } }) +
      message({ role: 'assistant', modelID: 'local-model', tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } })
  )
  db.close()
  assert.deepEqual(only(await readOpencode(opencode)), { model: 'kimi-k2', counts: { requests: 1, input: 100, output: 10, cacheRead: 50, cacheWrite: 0, reportedCost: 0.25 } })
})

test('Amp counts its assistant messages, or its usage ledger when they carry none', async () => {
  const dir = join(home, 'amp', 'threads')
  const messages = write(
    join(dir, 'T-1.json'),
    JSON.stringify({
      id: 'T-1',
      created: now.getTime(),
      messages: [
        { role: 'user', messageId: 0 },
        { role: 'assistant', messageId: 1, usage: { model: 'claude-sonnet-4-5', inputTokens: 12, outputTokens: 30, cacheReadInputTokens: 900, cacheCreationInputTokens: 100, timestamp: iso } }
      ],
      usageLedger: { events: [{ timestamp: iso, model: 'claude-sonnet-4-5', tokens: { input: 12, output: 30 } }] }
    })
  )
  assert.deepEqual(only(await readAmp(messages)), { model: 'claude-sonnet-4-5', counts: { requests: 1, input: 12, output: 30, cacheRead: 900, cacheWrite: 100 } })

  const ledger = write(join(dir, 'T-2.json'), JSON.stringify({ id: 'T-2', created: now.getTime(), usageLedger: { events: [{ timestamp: iso, model: 'gpt-5', tokens: { input: 4, output: 2 } }] } }))
  assert.equal(total(await readAmp(ledger)), 1)
})

test('Droid: a session’s running totals are one request, thinking as output, the model name tidied', async () => {
  assert.equal(droidModel('custom:Claude-Opus-4.5-Thinking-[Anthropic]-0'), 'claude-opus-4.5-thinking-0')
  const file = write(
    join(home, 'factory', 'sessions', 'p', 'abc.settings.json'),
    JSON.stringify({ model: 'gpt-5-codex', tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 7, cacheReadTokens: 900, thinkingTokens: 20 } })
  )
  assert.deepEqual(only(await readDroid(file)), { model: 'gpt-5-codex', counts: { requests: 1, input: 100, output: 70, cacheRead: 900, cacheWrite: 7 } })
})

test('Kimi CLI: the last status of each reply counts, under the configured model', async () => {
  const root = join(home, 'kimi')
  write(join(root, 'config.json'), JSON.stringify({ model: 'kimi-k2-turbo' }))
  const status = (id: string, input: number, output: number): unknown => ({
    timestamp: now.getTime() / 1000,
    message: { type: 'StatusUpdate', payload: { token_usage: { input_other: input, output, input_cache_read: 5, input_cache_creation: 0 }, message_id: id } }
  })
  const file = write(
    join(root, 'sessions', 'g', 's', 'wire.jsonl'),
    [status('m1', 100, 10), status('m1', 120, 30), status('m2', 1, 1)].map((r) => JSON.stringify(r)).join('\n')
  )
  const days = await readKimi(file, root)
  assert.deepEqual(days[today]['kimi-k2-turbo'], { requests: 2, input: 121, output: 31, cacheRead: 10, cacheWrite: 0 })
})

test('Cursor’s usage export: found by column name in any layout; the same row imported twice counts once', () => {
  const v3 = [
    'Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    `"${iso}","","","Included","auto","No","28342","775","105891","21282","156290","0.19"`,
    `"${iso}","","","On-Demand","gpt-5-codex","No","0","8263","66964","1612","76839","$0.03"`,
    `"${iso}","","","Errored, Not Charged","claude-4-sonnet","No","0","0","0","0","0","0"`
  ].join('\n')
  const rows = parseCursorCsv(v3)!
  assert.equal(rows.size, 2)
  const days = cursorDays(rows.values())
  assert.deepEqual(days[today].auto, { requests: 1, input: 775, output: 21282, cacheRead: 105891, cacheWrite: 28342, reportedCost: 0.19 })

  const v1 = 'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost,Cost to you\n2025-02-01,gpt-4o,10,5,0,15,30,$0.10,$0.10'
  const old = parseCursorCsv(v1)!
  assert.deepEqual([...old.values()][0].slice(1), ['gpt-4o', 5, 15, 0, 10, 0.1])
  assert.equal(localDay(new Date([...old.values()][0][0])), '2025-02-01')

  // Merging a second export keyed by line: the overlap adds nothing.
  const merged = new Map([...rows, ...parseCursorCsv(v3)!])
  assert.equal(merged.size, 2)
  assert.equal(parseCursorCsv('name,email\nx,y'), null)
})

test('a model Tokn has no price for is priced at the tool’s own figure; Tokn’s rate wins when it has one', () => {
  const pricing: ToknPricing = { 'gpt-5-codex': { input: 1, output: 10 } }
  const days = {
    [today]: {
      'cli:cursor': {
        auto: { requests: 1, input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, reportedCost: 0.19 },
        'gpt-5-codex': { requests: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reportedCost: 99 },
        free: { requests: 1, input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }
      }
    }
  }
  const summary = summarize(days, 7, pricing, () => 'api', now)
  const cost = Object.fromEntries(summary.models.map((m) => [m.modelId, m.costUsd]))
  assert.deepEqual(cost, { 'gpt-5-codex': 1, auto: 0.19, free: null })
  assert.equal(summary.totals.unpricedRequests, 1)
})

test('every tool’s folder is read into its own provider, unchanged files aren’t read again, and Cursor’s export is imported once', async () => {
  resetCliLogs()
  const root = mkdtempSync(join(tmpdir(), 'eaon-roots-'))
  const roots = sourceRoots({}, root)
  write(join(roots['droid'], 'sessions', 'a.settings.json'), JSON.stringify({ model: 'gpt-5', tokenUsage: { inputTokens: 1, outputTokens: 1 } }))
  write(
    join(roots['qwen-code'], 'projects', 'p', 'chats', 'c.jsonl'),
    JSON.stringify({ type: 'assistant', model: 'qwen3-coder-plus', timestamp: iso, usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }) + '\n'
  )
  // Nothing but empty folders for Claude and Codex.
  const all = { ...roots, 'claude-code': join(root, 'claude'), 'claude-desktop': null, codex: join(root, 'codex') }
  await readCliLogs(all)
  const first = cliLogs()
  assert.equal(first.days[today]['cli:droid']['gpt-5'].requests, 1)
  assert.equal(first.days[today]['cli:qwen-code']['qwen3-coder-plus'].requests, 1)
  assert.deepEqual([...first.found].sort(), ['droid', 'qwen-code'])

  await readCliLogs(all)
  assert.equal(cliLogs(), first, 'nothing changed, so nothing was rebuilt')

  const csv = 'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost\n' + `${today},auto,10,100,0,50,160,$0.02\n`
  const imported = await importCursorCsv(csv)
  assert.deepEqual(imported, { added: 1, total: 1 })
  assert.equal((await importCursorCsv(csv)).added, 0, 'the same export again adds nothing')
  assert.equal((await importCursorCsv('not,a,cursor,export\n1,2,3,4')).error !== undefined, true)
  const after = cliLogs()
  assert.equal(after.cursorImported, 1)
  assert.equal(after.days[today]['cli:cursor'].auto.reportedCost, 0.02)
  assert.ok(after.found.includes('cursor'))
})
