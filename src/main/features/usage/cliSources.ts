import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CliUsageTool } from '@shared/usage'
import { localDay } from './ledger'
import { addTo, count, listFiles, listJsonl, num, readLines, type CliDays } from './cliFiles'

/**
 * Every other CLI's own usage, read from what each keeps on this computer, for
 * Settings → Usage (`cliLogs.ts` reads them and keeps
 * the totals). Where each tool writes its counts, and what they mean, follows
 * tokscale (github.com/junhoyeo/tokscale), the open-source tracker that reads
 * the most of them, and Tokn's CLI for the tools it reads too:
 *
 *   Gemini CLI   ~/.gemini/tmp/<project>/chats/session-*.json(l)   per reply
 *   Qwen Code    ~/.qwen/projects/<project>/chats/*.jsonl          per reply
 *   Grok Build   ~/.grok/logs/unified.jsonl                        per inference
 *   Copilot CLI  ~/.copilot/session-store.db                       per request
 *   opencode     ~/.local/share/opencode/opencode.db               per reply
 *   Amp          ~/.local/share/amp/threads/T-*.json               per reply
 *   Droid        ~/.factory/sessions/**\/*.settings.json            per session
 *   Kimi CLI     ~/.kimi/sessions/<group>/<session>/wire.jsonl     per reply
 *
 * Cursor keeps no counts on this computer at all (its chats hold the text
 * and nothing about tokens), so its usage comes from the CSV its dashboard
 * exports, imported in Settings → Usage: `parseCursorCsv`.
 *
 * Reasoning ("thinking") tokens are billed as output, so a tool that counts
 * them apart has them added to output here; one whose output already holds
 * them (Grok, Codex, opencode) is taken as it is.
 */

/** The tools read file by file here; Claude's and Codex's transcripts are read in `cliLogs.ts`, and Cursor's usage is imported. */
export type FileTool = Exclude<CliUsageTool, 'claude-code' | 'claude-desktop' | 'codex' | 'cursor'>

export interface FileSource {
  tool: FileTool
  /** The files holding the tool's usage, under its folder. */
  files(root: string): Promise<string[]>
  /** One file's totals. Files are read whole, and again when they change. */
  read(file: string, root: string): Promise<CliDays>
}

/* ----------------------------------------------------------------- helpers */

/** A local day from an ISO string, or a number of seconds or milliseconds since 1970. */
export function dayOf(value: unknown, fallback: string): string {
  let at: Date | null = null
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) at = new Date(value < 1e11 ? value * 1000 : value)
  else if (typeof value === 'string' && value.trim()) {
    // SQLite's datetime('now') is UTC with no zone: "2026-09-13 22:29:51".
    const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value.trim()) ? `${value.trim().replace(' ', 'T')}Z` : value
    at = new Date(text)
  }
  return at && !Number.isNaN(at.getTime()) ? localDay(at) : fallback
}

const mtimeDay = async (file: string): Promise<string> => {
  try {
    return localDay(new Date((await fs.stat(file)).mtimeMs))
  } catch {
    return localDay(new Date())
  }
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined)
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
/** The first of `keys` that `value` has as a number. */
const first = (value: Json, keys: string[]): number => {
  for (const key of keys) if (typeof value[key] === 'number') return num(value[key])
  return 0
}

const has = (needle: string): ((line: Buffer) => boolean) => {
  const bytes = Buffer.from(needle)
  return (line) => line.includes(bytes)
}

interface SqliteDb {
  prepare(sql: string): { all(): Record<string, unknown>[] }
  close(): void
}

/**
 * Opens a database read-only with Node's built-in SQLite, or null when it
 * can't be (locked, corrupt, or no `node:sqlite` in this runtime): that tool
 * then just counts nothing, and is tried again on the next read.
 */
function openSqlite(file: string): SqliteDb | null {
  try {
    const sqlite = process.getBuiltinModule?.('node:sqlite') as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => SqliteDb } | undefined
    return sqlite ? new sqlite.DatabaseSync(file, { readOnly: true }) : null
  } catch {
    return null
  }
}

function query(file: string, sql: string): Record<string, unknown>[] {
  const db = openSqlite(file)
  if (!db) return []
  try {
    return db.prepare(sql).all()
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      /* closed */
    }
  }
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/* -------------------------------------------------------------- Gemini CLI */

/**
 * One Gemini reply's figures. Gemini's prompt count includes the cached
 * part: when the total shows it does, the cached tokens come out of input.
 * Tool-use prompt tokens are input; thoughts are output.
 */
function addGemini(days: CliDays, day: string, model: string, tokens: Json): void {
  let input = first(tokens, ['input', 'prompt', 'input_tokens', 'prompt_tokens', 'promptTokenCount'])
  const output = first(tokens, ['output', 'candidates', 'output_tokens', 'completion_tokens', 'candidatesTokenCount'])
  const cached = first(tokens, ['cached', 'cached_tokens', 'cachedContentTokenCount'])
  const thoughts = first(tokens, ['thoughts', 'reasoning', 'thoughts_tokens', 'thoughtsTokenCount'])
  const tool = first(tokens, ['tool', 'tool_tokens', 'toolUsePromptTokenCount'])
  const total = first(tokens, ['total', 'totalTokenCount', 'total_tokens'])
  if (cached > 0 && total > 0 && total === input + output + thoughts + tool) input = Math.max(0, input - cached)
  if (input + output + cached + thoughts + tool === 0) return
  addTo(days, day, model, { input: input + tool, output: output + thoughts, cacheRead: cached, cacheWrite: 0 })
}

/**
 * A Gemini CLI chat recording: the older whole-session `.json`, or the
 * current `.jsonl`, where a reply can be written again as it fills in (the
 * last copy of an id counts).
 */
export async function readGemini(file: string): Promise<CliDays> {
  const days: CliDays = {}
  const fallback = await mtimeDay(file)
  if (file.endsWith('.json')) {
    const text = await fs.readFile(file, 'utf8')
    if (!text.includes('"tokens"')) return days
    const messages = obj(parse(text))?.messages
    if (!Array.isArray(messages)) return days
    for (const m of messages) {
      const message = obj(m)
      const tokens = obj(message?.tokens)
      const model = str(message?.model)
      if (message && tokens && model) addGemini(days, dayOf(message.timestamp, fallback), model, tokens)
    }
    return days
  }
  let model = ''
  const replies = new Map<string, { day: string; model: string; tokens: Json }>()
  let unnamed = 0
  await readLines(
    file,
    0,
    (line) => line.includes(Buffer.from('"tokens"')) || line.includes(Buffer.from('"model"')),
    (line) => {
      const record = obj(parse(line))
      if (!record) return
      if (str(record.model)) model = str(record.model)
      const tokens = obj(record.tokens)
      if (!tokens || !model) return
      replies.set(str(record.id) || `#${unnamed++}`, { day: dayOf(record.timestamp, fallback), model, tokens })
    },
    true
  )
  for (const reply of replies.values()) addGemini(days, reply.day, reply.model, reply.tokens)
  return days
}

export const geminiSource: FileSource = {
  tool: 'gemini-cli',
  files: (root) => listFiles(path.join(root, 'tmp'), (name) => name.endsWith('.json') || name.endsWith('.jsonl')),
  read: (file) => readGemini(file)
}

/* --------------------------------------------------------------- Qwen Code */

/** A Qwen Code chat: one line per reply, its counts in Gemini's `usageMetadata` shape, cached tokens apart from the prompt. */
export async function readQwen(file: string): Promise<CliDays> {
  const days: CliDays = {}
  const fallback = await mtimeDay(file)
  await readLines(
    file,
    0,
    has('"usageMetadata"'),
    (line) => {
      const record = obj(parse(line))
      const usage = obj(record?.usageMetadata)
      if (!record || !usage || record.type !== 'assistant') return
      const input = first(usage, ['promptTokenCount'])
      const output = first(usage, ['candidatesTokenCount']) + first(usage, ['thoughtsTokenCount'])
      const cached = first(usage, ['cachedContentTokenCount'])
      if (input + output + cached === 0) return
      addTo(days, dayOf(record.timestamp, fallback), str(record.model) || 'unknown', { input, output, cacheRead: cached, cacheWrite: 0 })
    },
    true
  )
  return days
}

export const qwenSource: FileSource = {
  tool: 'qwen-code',
  // Today's chats, and the Gemini-style ones Qwen Code wrote before (it began as a Gemini CLI fork).
  files: async (root) => [
    ...(await listJsonl(path.join(root, 'projects'))),
    ...(await listFiles(path.join(root, 'tmp'), (name) => name.endsWith('.json') || name.endsWith('.jsonl')))
  ],
  read: (file, root) => (file.startsWith(path.join(root, 'tmp')) ? readGemini(file) : readQwen(file))
}

/* -------------------------------------------------------------- Grok Build */

const GROK_INFERENCE = 'shell.turn.inference_done'

/** The model a Grok session was started with, from its `summary.json`. */
async function grokSessionModels(root: string): Promise<Map<string, string>> {
  const models = new Map<string, string>()
  for (const file of await listFiles(path.join(root, 'sessions'), (name) => name === 'summary.json')) {
    try {
      const summary = obj(parse(await fs.readFile(file, 'utf8')))
      const model = str(summary?.current_model_id) || str(summary?.model_id)
      if (model) models.set(path.basename(path.dirname(file)), model)
    } catch {
      /* unreadable: the session's model stays unknown */
    }
  }
  return models
}

/**
 * Grok Build's log, which records every inference with its token counts
 * (`shell.turn.inference_done`). The prompt count includes the cached part
 * and the completion count includes reasoning. Which model ran is the last
 * one the log names for that session, then for that process, then the one
 * the session started with.
 */
export async function readGrok(file: string, root: string): Promise<CliDays> {
  const days: CliDays = {}
  const fallback = await mtimeDay(file)
  const bySession = new Map<string, string>()
  const byProcess = new Map<number, string>()
  let started: Map<string, string> | null = null
  const seen = new Set<string>()
  const pending: { day: string; sid: string; pid: number; input: number; output: number; cached: number }[] = []
  await readLines(
    file,
    0,
    (line) => line.includes(Buffer.from('model')) || line.includes(Buffer.from(GROK_INFERENCE)) || line.includes(Buffer.from('AuthManager::new')),
    (line) => {
      const record = obj(parse(line))
      if (!record) return
      const msg = str(record.msg)
      const ctx = obj(record.ctx) ?? {}
      const sid = str(record.sid)
      const pid = typeof record.pid === 'number' ? record.pid : -1
      // A restarted process can reuse a pid: it doesn't inherit the old one's model.
      if (msg === 'AuthManager::new') return void byProcess.delete(pid)
      const changedTo =
        msg === 'model changed'
          ? str(ctx.model)
          : msg === 'model catalog: notifying clients'
            ? str(ctx.current_model_id)
            : msg === 'backend_search: model switch'
              ? str(ctx.new_model) || str(ctx.model) || str(ctx.current_model_id)
              : ''
      if (changedTo && changedTo !== 'unknown') {
        if (sid) bySession.set(sid, changedTo)
        else if (pid >= 0) byProcess.set(pid, changedTo)
        return
      }
      if (msg !== GROK_INFERENCE || !sid) return
      const prompt = num(ctx.prompt_tokens)
      const completion = num(ctx.completion_tokens)
      if (prompt + completion === 0) return
      const id = str(record.event_id) || str(record.id) || str(ctx.event_id) || line
      if (seen.has(`${sid}:${id}`)) return
      seen.add(`${sid}:${id}`)
      const cached = Math.min(num(ctx.cached_prompt_tokens), prompt)
      const model = bySession.get(sid) ?? byProcess.get(pid)
      if (model) addTo(days, dayOf(record.ts, fallback), model, { input: prompt - cached, output: completion, cacheRead: cached, cacheWrite: 0 })
      else pending.push({ day: dayOf(record.ts, fallback), sid, pid, input: prompt - cached, output: completion, cached })
    },
    true
  )
  for (const p of pending) {
    started ??= await grokSessionModels(root)
    addTo(days, p.day, started.get(p.sid) ?? 'unknown', { input: p.input, output: p.output, cacheRead: p.cached, cacheWrite: 0 })
  }
  return days
}

export const grokSource: FileSource = {
  tool: 'grok',
  files: (root) => listFiles(path.join(root, 'logs'), (name) => name.startsWith('unified') && name.endsWith('.jsonl')),
  read: (file, root) => readGrok(file, root)
}

/* ------------------------------------------------------------- Copilot CLI */

/**
 * GitHub Copilot CLI's own ledger, one row per request. Its cost column is in
 * GitHub's AI units, not dollars, so it's left out; one cache-write figure
 * with no TTL is priced as the 5-minute kind (Tokn's CLI does both the same).
 */
export async function readCopilot(file: string): Promise<CliDays> {
  const days: CliDays = {}
  const fallback = await mtimeDay(file)
  const rows = query(
    file,
    'SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at FROM assistant_usage_events'
  )
  for (const row of rows) {
    const model = str(row.model)
    if (!model) continue
    addTo(days, dayOf(row.created_at, fallback), model, {
      input: count(row.input_tokens),
      output: count(row.output_tokens),
      cacheRead: count(row.cache_read_tokens),
      cacheWrite: count(row.cache_write_tokens)
    })
  }
  return days
}

export const copilotSource: FileSource = {
  tool: 'copilot-cli',
  files: async (root) => {
    const db = path.join(root, 'session-store.db')
    return (await exists(db)) ? [db] : []
  },
  read: (file) => readCopilot(file)
}

/* ---------------------------------------------------------------- opencode */

/** One opencode reply. Its output already holds reasoning; local and free models with no tokens are left out. */
function addOpencode(days: CliDays, data: Json, fallback: string, created?: unknown): void {
  if (data.role !== 'assistant') return
  const model = str(data.modelID)
  const tokens = obj(data.tokens)
  if (!model || !tokens) return
  const cache = obj(tokens.cache) ?? {}
  const counts = { input: num(tokens.input), output: num(tokens.output), cacheRead: num(cache.read), cacheWrite: num(cache.write) }
  if (counts.input + counts.output + counts.cacheRead + counts.cacheWrite === 0) return
  const cost = typeof data.cost === 'number' && data.cost > 0 ? data.cost : 0
  addTo(days, dayOf(obj(data.time)?.created ?? created, fallback), model, { ...counts, ...(cost ? { reportedCost: cost } : {}) })
}

/** opencode's database (today), or one of the per-message files it kept before. */
export async function readOpencode(file: string): Promise<CliDays> {
  const days: CliDays = {}
  const fallback = await mtimeDay(file)
  if (file.endsWith('.db')) {
    // Only the fields counted leave SQLite: a message's data also holds its whole text.
    const rows = query(
      file,
      `SELECT time_created, json_extract(data, '$.role') AS role, json_extract(data, '$.modelID') AS modelID,
              json_extract(data, '$.tokens') AS tokens, json_extract(data, '$.cost') AS cost, json_extract(data, '$.time') AS time
       FROM message WHERE json_extract(data, '$.role') = 'assistant'`
    )
    for (const row of rows) {
      addOpencode(days, { role: row.role, modelID: row.modelID, tokens: parse(str(row.tokens)), cost: row.cost, time: parse(str(row.time)) }, fallback, row.time_created)
    }
    return days
  }
  const data = obj(parse(await fs.readFile(file, 'utf8')))
  if (data) addOpencode(days, data, fallback)
  return days
}

export const opencodeSource: FileSource = {
  tool: 'opencode',
  files: async (root) => {
    // The database took over from the per-message files: reading both would count a migrated message twice.
    const db = path.join(root, 'opencode.db')
    if (await exists(db)) return [db]
    return listFiles(path.join(root, 'storage', 'message'), (name) => name.endsWith('.json'))
  },
  read: (file) => readOpencode(file)
}

/* --------------------------------------------------------------------- Amp */

/**
 * An Amp thread: each assistant message carries its usage. A thread without
 * any keeps a usage ledger instead, which counts the same requests.
 */
export async function readAmp(file: string): Promise<CliDays> {
  const days: CliDays = {}
  const thread = obj(parse(await fs.readFile(file, 'utf8')))
  if (!thread) return days
  const fallback = typeof thread.created === 'number' ? dayOf(thread.created, await mtimeDay(file)) : await mtimeDay(file)
  let counted = 0
  for (const m of Array.isArray(thread.messages) ? thread.messages : []) {
    const message = obj(m)
    const usage = obj(message?.usage)
    if (!message || !usage || message.role !== 'assistant') continue
    const counts = {
      input: num(usage.inputTokens),
      output: num(usage.outputTokens),
      cacheRead: num(usage.cacheReadInputTokens),
      cacheWrite: num(usage.cacheCreationInputTokens)
    }
    if (counts.input + counts.output + counts.cacheRead + counts.cacheWrite === 0) continue
    addTo(days, dayOf(usage.timestamp, fallback), str(usage.model) || 'unknown', counts)
    counted++
  }
  if (counted > 0) return days
  const events = obj(thread.usageLedger)?.events
  for (const e of Array.isArray(events) ? events : []) {
    const event = obj(e)
    const tokens = obj(event?.tokens)
    if (!event || !tokens) continue
    const counts = { input: num(tokens.input), output: num(tokens.output), cacheRead: num(tokens.cacheReadInputTokens), cacheWrite: num(tokens.cacheCreationInputTokens) }
    if (counts.input + counts.output + counts.cacheRead + counts.cacheWrite === 0) continue
    addTo(days, dayOf(event.timestamp, fallback), str(event.model) || 'unknown', counts)
  }
  return days
}

export const ampSource: FileSource = {
  tool: 'amp',
  files: (root) => listFiles(path.join(root, 'threads'), (name) => name.startsWith('T-') && name.endsWith('.json')),
  read: (file) => readAmp(file)
}

/* ------------------------------------------------------------------- Droid */

/** Droid's model names as Tokn writes them: no `custom:` prefix or `[Provider]` tag, lower case. */
export function droidModel(raw: string): string {
  return raw
    .replace(/^custom:/, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/-+$/, '')
    .replace(/-+/g, '-')
    .toLowerCase()
}

/**
 * A Droid session's settings, which keep the session's running totals: the
 * session counts as one request, on the day it was last written.
 */
export async function readDroid(file: string): Promise<CliDays> {
  const days: CliDays = {}
  const settings = obj(parse(await fs.readFile(file, 'utf8')))
  const usage = obj(settings?.tokenUsage)
  if (!settings || !usage) return days
  const counts = {
    input: num(usage.inputTokens),
    output: num(usage.outputTokens) + num(usage.thinkingTokens),
    cacheRead: num(usage.cacheReadTokens),
    cacheWrite: num(usage.cacheCreationTokens)
  }
  if (counts.input + counts.output + counts.cacheRead + counts.cacheWrite === 0) return days
  addTo(days, await mtimeDay(file), droidModel(str(settings.model)) || 'unknown', counts)
  return days
}

export const droidSource: FileSource = {
  tool: 'droid',
  files: (root) => listFiles(path.join(root, 'sessions'), (name) => name.endsWith('.settings.json')),
  read: (file) => readDroid(file)
}

/* ---------------------------------------------------------------- Kimi CLI */

const KIMI_DEFAULT_MODEL = 'kimi-for-coding'

/** The model Kimi CLI is set to; its log doesn't name one. */
async function kimiModel(root: string): Promise<string> {
  try {
    const model = str(obj(parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')))?.model)
    if (model) return model
  } catch {
    /* no JSON config */
  }
  try {
    const match = /^\s*default_model\s*=\s*"([^"]+)"/m.exec(await fs.readFile(path.join(root, 'config.toml'), 'utf8'))
    if (match) return match[1]
  } catch {
    /* no TOML config */
  }
  return KIMI_DEFAULT_MODEL
}

/**
 * A Kimi CLI session's wire log: each reply's counts come in a
 * `StatusUpdate`, sent again as a long reply goes on (the last one counts).
 */
export async function readKimi(file: string, root: string): Promise<CliDays> {
  const days: CliDays = {}
  const fallback = await mtimeDay(file)
  const model = await kimiModel(root)
  const replies = new Map<string, { day: string; usage: Json }>()
  let unnamed = 0
  await readLines(
    file,
    0,
    has('"token_usage"'),
    (line) => {
      const record = obj(parse(line))
      const message = obj(record?.message)
      const payload = obj(message?.payload)
      const usage = obj(payload?.token_usage)
      if (!record || !usage || message?.type !== 'StatusUpdate') return
      replies.set(str(payload?.message_id) || `#${unnamed++}`, { day: dayOf(record.timestamp, fallback), usage })
    },
    true
  )
  for (const { day, usage } of replies.values()) {
    const counts = { input: num(usage.input_other), output: num(usage.output), cacheRead: num(usage.input_cache_read), cacheWrite: num(usage.input_cache_creation) }
    if (counts.input + counts.output + counts.cacheRead + counts.cacheWrite > 0) addTo(days, day, model, counts)
  }
  return days
}

export const kimiSource: FileSource = {
  tool: 'kimi-cli',
  files: (root) => listFiles(path.join(root, 'sessions'), (name) => name === 'wire.jsonl'),
  read: (file, root) => readKimi(file, root)
}

/** Every tool read file by file, in the order the scanner reads them. */
export const FILE_SOURCES: FileSource[] = [geminiSource, qwenSource, grokSource, copilotSource, opencodeSource, ampSource, droidSource, kimiSource]

/** Each file-read tool's folder: where it keeps its usage, following the tool's own overrides. */
export function sourceRoots(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Record<FileTool, string> {
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  return {
    'gemini-cli': env.GEMINI_CLI_HOME || path.join(home, '.gemini'),
    'qwen-code': path.join(home, '.qwen'),
    grok: env.GROK_HOME || path.join(home, '.grok'),
    'copilot-cli': env.COPILOT_HOME || path.join(home, '.copilot'),
    opencode: path.join(dataHome, 'opencode'),
    amp: path.join(dataHome, 'amp'),
    droid: path.join(home, '.factory'),
    'kimi-cli': env.KIMI_SHARE_DIR || path.join(home, '.kimi')
  }
}

/* ------------------------------------------------------------------ Cursor */

/** One request from Cursor's usage export: [when (ms), model, input, output, cache read, cache write, cost USD]. */
export type CursorRow = [number, string, number, number, number, number, number]

/** A CSV line's fields, quotes and doubled quotes undone. */
function csvFields(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(field.trim())
      field = ''
    } else field += c
  }
  out.push(field.trim())
  return out
}

/**
 * Cursor's usage export (cursor.com/dashboard → Usage → Export CSV), any of
 * its layouts: the columns are found by name. "Input (w/ Cache Write)" is the
 * input written to the cache and "Input (w/o Cache Write)" the rest. Each row
 * is keyed by its line, so importing an overlapping export again adds only
 * what's new. Null when the file isn't Cursor's export.
 */
export function parseCursorCsv(text: string): Map<string, CursorRow> | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const header = csvFields(lines[0] ?? '')
  const col = (name: string): number => header.findIndex((h) => h.toLowerCase() === name.toLowerCase())
  const at = {
    date: col('Date'),
    model: col('Model'),
    write: col('Input (w/ Cache Write)'),
    input: col('Input (w/o Cache Write)'),
    read: col('Cache Read'),
    output: col('Output Tokens'),
    cost: col('Cost')
  }
  if (at.date < 0 || at.model < 0 || at.output < 0 || (at.input < 0 && at.write < 0)) return null
  const rows = new Map<string, CursorRow>()
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const f = csvFields(line)
    const model = f[at.model] ?? ''
    const raw = f[at.date] ?? ''
    // A date alone is that local day; anything with a time is an instant.
    const when = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00`).getTime() : Date.parse(raw)
    if (!model || !Number.isFinite(when)) continue
    const row: CursorRow = [
      when,
      model,
      count(f[at.input]),
      count(f[at.output]),
      count(f[at.read]),
      count(f[at.write]),
      Math.max(0, Number(String(f[at.cost] ?? '').replace(/[$,\s]/g, '')) || 0)
    ]
    if (row[2] + row[3] + row[4] + row[5] === 0) continue
    rows.set(line.trim(), row)
  }
  return rows
}

/** Imported Cursor rows as days. */
export function cursorDays(rows: Iterable<CursorRow>): CliDays {
  const days: CliDays = {}
  for (const [when, model, input, output, cacheRead, cacheWrite, cost] of rows) {
    addTo(days, localDay(new Date(when)), model, { input, output, cacheRead, cacheWrite, ...(cost > 0 ? { reportedCost: cost } : {}) })
  }
  return days
}
