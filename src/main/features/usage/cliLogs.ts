import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CliUsageTool, CursorImport, UsageCounts } from '@shared/usage'
import { store } from '../../store'
import { defaultDir } from '../cliAccounts/folders'
import { statOf, type CliDays } from './cliFiles'
import { cursorDays, FILE_SOURCES, parseCursorCsv, sourceRoots, type CursorRow, type FileTool } from './cliSources'
import { localDay, type LedgerDays } from './ledger'
import { cliProvider } from './rows'

/**
 * The coding CLIs' own use, read from what they keep on this computer, so
 * Settings → Usage can show them next to Eaon's: a day's requests and tokens
 * per model, nothing else. Extra accounts' folders link their logs back to
 * the default ones (cliAccounts/folders.ts), so the default folders hold
 * every account's.
 *
 *   Claude Code   <CLAUDE_CONFIG_DIR or ~/.claude>/projects/**.jsonl: one
 *                 `assistant` record per API response, with `message.usage`
 *   Claude Desktop  its agent sessions (local-agent-mode-sessions), in
 *                 Claude Code's format
 *   Codex         <CODEX_HOME or ~/.codex>/sessions/**.jsonl: `token_count`
 *                 events, each turn's `last_token_usage`, the model from
 *                 the records before it
 *   the others    Gemini CLI, Qwen Code, Grok Build, Copilot CLI, opencode,
 *                 Amp, Droid and Kimi CLI, each from its own files
 *                 (cliSources.ts), read whole again when they change
 *   Cursor        keeps no counts on this computer: its dashboard's usage
 *                 export, imported (`importCursorCsv`)
 *
 * The rules are Tokn CLI's (tokn-cli core/parse.ts, sources/codex.ts), so the
 * two never disagree: Claude Code copies records into a new transcript when a
 * session is resumed or forked, so each counts once, by its message and
 * request ids; `<synthetic>` records never reached the API; Codex's input
 * includes its cached input, which is split out.
 *
 * Shown, never uploaded: Tokn's CLI counts these on the Tokn profile under
 * their own tools, so uploading them as Eaon's would count them twice.
 *
 * The logs can be gigabytes, so each file is read once and then only from
 * where it ended (they are append-only); what each file held is saved in
 * cli-usage.json, so a relaunch reads only what's new.
 */

const FILE = 'cli-usage.json'
const VERSION = 1
/** A little over a year, like the ledger. */
const KEEP_DAYS = 400
/** A summary asks for fresh logs at most this often. */
const FRESH_MS = 60_000
const CHUNK = 1 << 20
const MAX_DEPTH = 12

/** The tools whose logs are read a line at a time, from where each file ended. */
type LineTool = 'claude-code' | 'claude-desktop' | 'codex'
const LINE_TOOLS: LineTool[] = ['claude-code', 'claude-desktop', 'codex']

/** Where each tool keeps its usage; null for one with no folder on this system. */
export type CliRoots = Partial<Record<Exclude<CliUsageTool, 'cursor'>, string | null>>

/** One response: its dedupe key (Claude only), day, model and tokens; 1-hour cache writes last, when there were any. */
type Entry = [key: number, day: string, model: string, input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h?: number]

interface FileState {
  size: number
  mtimeMs: number
  /** Where the next unread line starts. */
  offset: number
  /** Codex: the model the latest records named, for the turns that follow. */
  model?: string
  entries: Entry[]
}

interface SourceState {
  tool: FileTool
  size: number
  mtimeMs: number
  days: CliDays
}

interface Saved {
  version: number
  files: Record<string, FileState & { tool: LineTool }>
  /** The other tools' files, each with what it held when last read. */
  sources?: Record<string, SourceState>
}

export interface CliLogs {
  /** day → `cli:<tool>` → model → counts. */
  days: LedgerDays
  /** Whether the first read since launch is still going. */
  reading: boolean
  /** The tools with any use on this computer. */
  found: CliUsageTool[]
  /** Cursor requests imported from its usage export. */
  cursorImported: number
}

/** Imported Cursor rows, by the export line they came from, so a second import adds only what's new. */
const CURSOR_FILE = 'cursor-usage.json'

let saved: Saved | null = null
let result: CliLogs = { days: {}, reading: true, found: [], cursorImported: 0 }
let cursor: Record<string, CursorRow> | null = null
let readAt = 0
let reading: Promise<void> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function load(): Saved {
  if (!saved) {
    const raw = store.getJson<Partial<Saved>>(FILE, {})
    saved = raw.version === VERSION && raw.files && typeof raw.files === 'object' ? (raw as Saved) : { version: VERSION, files: {} }
  }
  return saved
}

/** The logs as last read, and a fresh read started in the background when they're a minute old. */
export function cliLogs(): CliLogs {
  if (Date.now() - readAt > FRESH_MS) void readCliLogs()
  return result
}

/** Called after a read that changed anything. */
export function onCliLogsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readCliLogs(roots: CliRoots = defaultRoots()): Promise<void> {
  reading ??= read(roots)
    .catch((error) => console.warn('[usage] CLI logs:', error instanceof Error ? error.message : error))
    .finally(() => {
      reading = null
      readAt = Date.now()
    })
  return reading
}

/** Claude Desktop's own folder, where its agent sessions live. */
function claudeDesktopDir(env: NodeJS.ProcessEnv, home: string): string | null {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude')
  if (process.platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Claude')
  if (process.platform === 'linux') return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Claude')
  return null
}

/**
 * Where each tool keeps its usage. EAON_CLI_LOGS_HOME stands in for the home
 * folder the other tools are looked for in, so tests never read the real ones.
 */
export function defaultRoots(env: NodeJS.ProcessEnv = process.env, home: string = env['EAON_CLI_LOGS_HOME'] || os.homedir()): CliRoots {
  const desktop = claudeDesktopDir(env, home)
  return {
    'claude-code': path.join(defaultDir('claude'), 'projects'),
    'claude-desktop': desktop && path.join(desktop, 'local-agent-mode-sessions'),
    codex: path.join(defaultDir('codex'), 'sessions'),
    ...sourceRoots(env, home)
  }
}

async function read(roots: CliRoots): Promise<void> {
  const state = load()
  let changed = result.reading
  const present = new Set<string>()
  const found: CliUsageTool[] = []

  for (const tool of LINE_TOOLS) {
    const root = roots[tool]
    if (!root) continue
    const files = await listLogs(root)
    if (files.length > 0) found.push(tool)
    for (const file of files) {
      present.add(file.path)
      const known = state.files[file.path]
      if (known && known.tool === tool && known.size === file.size && known.mtimeMs === file.mtimeMs) continue
      // Grown: read on from where it ended. Shrunk or new: from the start.
      const next =
        known && known.tool === tool && file.size > known.size
          ? known
          : { tool, size: 0, mtimeMs: 0, offset: 0, entries: [] as Entry[], model: undefined as string | undefined }
      try {
        await readFrom(file.path, tool, next)
        next.size = file.size
        next.mtimeMs = file.mtimeMs
        state.files[file.path] = next
        changed = true
      } catch {
        /* unreadable this time: tried again on the next read */
      }
    }
  }
  for (const file of Object.keys(state.files)) {
    if (present.has(file)) continue
    delete state.files[file]
    changed = true
  }
  if (await readSources(roots, state, present)) changed = true
  for (const source of FILE_SOURCES) {
    if (Object.values(state.sources ?? {}).some((s) => s.tool === source.tool && Object.keys(s.days).length > 0)) found.push(source.tool)
  }
  const imported = cursorRows()
  if (Object.keys(imported).length > 0) found.push('cursor')

  if (!changed && found.join() === result.found.join()) return
  result = { days: tally(state, imported), reading: false, found, cursorImported: Object.keys(imported).length }
  scheduleSave()
  for (const listener of listeners) listener()
}

/**
 * The other tools' files: each read whole again when it changed (they are
 * small, or a database), what it held kept until it does again. True when
 * anything changed.
 */
async function readSources(roots: CliRoots, state: Saved, present: Set<string>): Promise<boolean> {
  const sources = (state.sources ??= {})
  let changed = false
  for (const source of FILE_SOURCES) {
    const root = roots[source.tool]
    if (!root) continue
    let files: string[]
    try {
      files = await source.files(root)
    } catch {
      continue
    }
    for (const file of files) {
      present.add(file)
      const stat = await statOf(file)
      if (!stat) continue
      const known = sources[file]
      if (known && known.tool === source.tool && known.size === stat.size && known.mtimeMs === stat.mtimeMs) continue
      try {
        sources[file] = { tool: source.tool, size: stat.size, mtimeMs: stat.mtimeMs, days: await source.read(file, root) }
        changed = true
      } catch {
        /* unreadable this time (locked, half-written): tried again on the next read */
      }
    }
  }
  for (const file of Object.keys(sources)) {
    if (present.has(file)) continue
    delete sources[file]
    changed = true
  }
  return changed
}

function addInto(days: LedgerDays, day: string, provider: string, model: string, from: Omit<UsageCounts, 'requests'>, requests: number): void {
  const counts = (((days[day] ??= {})[provider] ??= {})[model] ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as UsageCounts
  counts.requests += requests
  counts.input += from.input
  counts.output += from.output
  counts.cacheRead += from.cacheRead
  counts.cacheWrite += from.cacheWrite
  if (from.cacheWrite1h) counts.cacheWrite1h = (counts.cacheWrite1h ?? 0) + from.cacheWrite1h
  if (from.reportedCost) counts.reportedCost = (counts.reportedCost ?? 0) + from.reportedCost
}

/** Every day's counts, each Claude response once however many transcripts repeat it. */
function tally(state: Saved, imported: Record<string, CursorRow>): LedgerDays {
  const oldest = localDay(new Date(Date.now() - KEEP_DAYS * 86_400_000))
  const seen = new Set<number>()
  const days: LedgerDays = {}
  for (const file of Object.keys(state.files).sort()) {
    const { tool, entries } = state.files[file]
    const provider = cliProvider(tool)
    for (const [key, day, model, input, output, cacheRead, cacheWrite, cacheWrite1h] of entries) {
      if (day < oldest) continue
      if (key !== 0) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      addInto(days, day, provider, model, { input, output, cacheRead, cacheWrite, ...(cacheWrite1h ? { cacheWrite1h } : {}) }, 1)
    }
  }
  const add = (provider: string, toolDays: CliDays): void => {
    for (const [day, models] of Object.entries(toolDays)) {
      if (day < oldest) continue
      for (const [model, counts] of Object.entries(models)) addInto(days, day, provider, model, counts, counts.requests)
    }
  }
  for (const source of Object.values(state.sources ?? {})) add(cliProvider(source.tool), source.days)
  add(cliProvider('cursor'), cursorDays(Object.values(imported)))
  return days
}

/* ------------------------------------------------------------------ Cursor */

function cursorRows(): Record<string, CursorRow> {
  cursor ??= store.getJson<{ rows?: Record<string, CursorRow> }>(CURSOR_FILE, {}).rows ?? {}
  return cursor
}

/**
 * Cursor's usage export (cursor.com/dashboard → Usage → Export CSV), added to
 * what was imported before: a request already in an earlier export isn't
 * counted twice.
 */
export async function importCursorCsv(text: string): Promise<CursorImport> {
  const parsed = parseCursorCsv(text)
  const rows = cursorRows()
  if (!parsed) return { added: 0, total: Object.keys(rows).length, error: 'That isn’t Cursor’s usage export. Export it from cursor.com/dashboard → Usage → Export CSV.' }
  let added = 0
  for (const [key, row] of parsed) {
    if (rows[key]) continue
    rows[key] = row
    added++
  }
  if (added > 0) store.setJson(CURSOR_FILE, { rows })
  readAt = 0
  await readCliLogs()
  return { added, total: Object.keys(rows).length }
}

/** Saved off the main thread a little after a read: the file can be megabytes. */
function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (saved) store.setJsonAsync(FILE, saved)
  }, 10_000)
}

/** On the way out: a read waiting to be saved is saved now. */
export function flushCliLogs(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  if (saved) store.setJson(FILE, saved)
}

// ------------------------------------------------------------------ files

async function listLogs(root: string): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  const out: { path: string; size: number; mtimeMs: number }[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // Never through a link: a loop would never end, and an extra account's
      // links lead back here anyway.
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = await fs.stat(full)
          out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs })
        } catch {
          /* gone between the listing and the stat */
        }
      }
    }
  }
  await walk(root, 0)
  return out
}

const MARKER: Record<LineTool, Buffer[]> = {
  'claude-code': [Buffer.from('"usage"')],
  'claude-desktop': [Buffer.from('"usage"')],
  codex: [Buffer.from('token_count'), Buffer.from('"model"')]
}

/**
 * Reads `file` from `state.offset` to its last whole line, adding what it
 * finds to `state`. Only lines with a marker are decoded: most of a
 * transcript is conversation, never turned into a string here.
 */
async function readFrom(file: string, tool: LineTool, state: FileState): Promise<void> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(CHUNK)
    let carry: Buffer = Buffer.alloc(0)
    let position = state.offset
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, position)
      if (bytesRead === 0) break
      position += bytesRead
      const data = carry.length > 0 ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead)
      let start = 0
      for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
        const line = data.subarray(start, end)
        if (MARKER[tool].some((m) => line.indexOf(m) !== -1)) {
          if (tool !== 'codex') claudeLine(line.toString('utf8'), state)
          else codexLine(line.toString('utf8'), state)
        }
        start = end + 1
      }
      state.offset += start
      // A line still being written stays for the next read.
      carry = Buffer.from(data.subarray(start))
    }
  } finally {
    await handle.close()
  }
}

const n = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

function dayOf(timestamp: unknown): string | null {
  const at = typeof timestamp === 'string' ? new Date(timestamp) : null
  return at && !Number.isNaN(at.getTime()) ? localDay(at) : null
}

/** cyrb53: a 53-bit hash, so a key is a number in the saved file, not a 60-character string. */
function hash(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0) || 1
}

interface ClaudeRecord {
  type?: string
  timestamp?: string
  requestId?: string
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
    }
  }
}

export function claudeLine(line: string, state: FileState): void {
  let record: ClaudeRecord
  try {
    record = JSON.parse(line) as ClaudeRecord
  } catch {
    return
  }
  const message = record.message
  const usage = message?.usage
  if (record.type !== 'assistant' || !usage || !message.model || message.model === '<synthetic>') return
  const day = dayOf(record.timestamp)
  if (!day) return
  const key = message.id || record.requestId ? hash(`${message.id ?? ''}:${record.requestId ?? ''}`) : 0
  // 1-hour cache writes cost more than 5-minute ones; the total holds both.
  const written = n(usage.cache_creation_input_tokens)
  const hour = Math.min(n(usage.cache_creation?.ephemeral_1h_input_tokens), written)
  const entry: Entry = [key, day, message.model, n(usage.input_tokens), n(usage.output_tokens), n(usage.cache_read_input_tokens), written - hour]
  if (hour > 0) entry.push(hour)
  state.entries.push(entry)
}

interface CodexRecord {
  type?: string
  timestamp?: string
  payload?: {
    type?: string
    model?: unknown
    info?: { last_token_usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } } | null
  }
}

export function codexLine(line: string, state: FileState): void {
  let record: CodexRecord
  try {
    record = JSON.parse(line) as CodexRecord
  } catch {
    return
  }
  const payload = record.payload
  if (!payload) return
  if (typeof payload.model === 'string' && payload.model) state.model = payload.model
  if (record.type !== 'event_msg' || payload.type !== 'token_count') return
  const turn = payload.info?.last_token_usage
  if (!turn || (n(turn.input_tokens) === 0 && n(turn.output_tokens) === 0)) return
  const day = dayOf(record.timestamp)
  if (!day) return
  const cached = n(turn.cached_input_tokens)
  // Codex's input includes the cached part; reasoning is already in its output.
  state.entries.push([0, day, state.model || 'unknown', Math.max(0, n(turn.input_tokens) - cached), n(turn.output_tokens), cached, 0])
}

/** For tests: forget what was read. */
export function resetCliLogs(): void {
  saved = { version: VERSION, files: {} }
  result = { days: {}, reading: true, found: [], cursorImported: 0 }
  cursor = null
  readAt = 0
}
