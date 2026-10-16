import fs from 'node:fs/promises'
import path from 'node:path'
import type { UsageCounts, UsageTool } from '@shared/usage'
import { store } from '../../store'
import { defaultDir } from '../cliAccounts/folders'
import { localDay, type LedgerDays } from './ledger'
import { CLI_PROVIDERS } from './rows'

/**
 * Claude Code's and Codex's own use, read from the logs they keep on this
 * computer, so Settings → Usage can show them next to Eaon's: a day's
 * requests and tokens per model, nothing else. Extra accounts' folders link
 * their logs back to the default ones (cliAccounts/folders.ts), so the
 * default folders hold every account's.
 *
 *   Claude Code   <CLAUDE_CONFIG_DIR or ~/.claude>/projects/**.jsonl: one
 *                 `assistant` record per API response, with `message.usage`
 *   Codex         <CODEX_HOME or ~/.codex>/sessions/**.jsonl: `token_count`
 *                 events, each turn's `last_token_usage`, the model from
 *                 the records before it
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

type CliTool = Exclude<UsageTool, 'eaon'>

/** One response: its dedupe key (Claude Code only), day, model and tokens. */
type Entry = [key: number, day: string, model: string, input: number, output: number, cacheRead: number, cacheWrite: number]

interface FileState {
  size: number
  mtimeMs: number
  /** Where the next unread line starts. */
  offset: number
  /** Codex: the model the latest records named, for the turns that follow. */
  model?: string
  entries: Entry[]
}

interface Saved {
  version: number
  files: Record<string, FileState & { tool: CliTool }>
}

export interface CliLogs {
  /** day → `cli:claude-code` / `cli:codex` → model → counts. */
  days: LedgerDays
  /** Whether the first read since launch is still going. */
  reading: boolean
  /** The tools with any logs on this computer. */
  found: CliTool[]
}

let saved: Saved | null = null
let result: CliLogs = { days: {}, reading: true, found: [] }
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

export function readCliLogs(roots: Record<CliTool, string> = defaultRoots()): Promise<void> {
  reading ??= read(roots)
    .catch((error) => console.warn('[usage] CLI logs:', error instanceof Error ? error.message : error))
    .finally(() => {
      reading = null
      readAt = Date.now()
    })
  return reading
}

function defaultRoots(): Record<CliTool, string> {
  return {
    'claude-code': path.join(defaultDir('claude'), 'projects'),
    codex: path.join(defaultDir('codex'), 'sessions')
  }
}

async function read(roots: Record<CliTool, string>): Promise<void> {
  const state = load()
  let changed = result.reading
  const present = new Set<string>()
  const found: CliTool[] = []

  for (const tool of Object.keys(roots) as CliTool[]) {
    const files = await listLogs(roots[tool])
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

  if (!changed && found.join() === result.found.join()) return
  result = { days: tally(state), reading: false, found }
  scheduleSave()
  for (const listener of listeners) listener()
}

/** Every day's counts, each Claude Code response once however many transcripts repeat it. */
function tally(state: Saved): LedgerDays {
  const oldest = localDay(new Date(Date.now() - KEEP_DAYS * 86_400_000))
  const seen = new Set<number>()
  const days: LedgerDays = {}
  for (const file of Object.keys(state.files).sort()) {
    const { tool, entries } = state.files[file]
    const provider = CLI_PROVIDERS[tool]
    for (const [key, day, model, input, output, cacheRead, cacheWrite] of entries) {
      if (day < oldest) continue
      if (key !== 0) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      const counts = (((days[day] ??= {})[provider] ??= {})[model] ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) as UsageCounts
      counts.requests++
      counts.input += input
      counts.output += output
      counts.cacheRead += cacheRead
      counts.cacheWrite += cacheWrite
    }
  }
  return days
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

const MARKER: Record<CliTool, Buffer[]> = {
  'claude-code': [Buffer.from('"usage"')],
  codex: [Buffer.from('token_count'), Buffer.from('"model"')]
}

/**
 * Reads `file` from `state.offset` to its last whole line, adding what it
 * finds to `state`. Only lines with a marker are decoded: most of a
 * transcript is conversation, never turned into a string here.
 */
async function readFrom(file: string, tool: CliTool, state: FileState): Promise<void> {
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
          if (tool === 'claude-code') claudeLine(line.toString('utf8'), state)
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
    usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
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
  state.entries.push([key, day, message.model, n(usage.input_tokens), n(usage.output_tokens), n(usage.cache_read_input_tokens), n(usage.cache_creation_input_tokens)])
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
  result = { days: {}, reading: true, found: [] }
  readAt = 0
}
