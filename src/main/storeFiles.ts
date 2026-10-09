import { app } from 'electron'
import * as nodeFs from 'node:fs'
import { open, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { StoreHealth, StoreProblem } from '@shared/storeHealth'

/**
 * How the store's JSON documents reach the disk and come back, so that one
 * damaged file can never stop Eaon from starting or quietly replace what the
 * user had.
 *
 * Reading: a file that won't parse, or parses to the wrong shape, is copied
 * aside as `<name>.corrupt-<time>` before anything else happens. Then the
 * previous save (`<name>.bak`) is tried, then whatever complete records the
 * damaged text still holds (a file cut off mid-write keeps everything up to
 * the cut), and only then a fresh default. Whatever is used is written back
 * at once, so the next read doesn't go through all this again. Each of these
 * is reported (see `storeHealth`), so the app can say what happened.
 *
 * Writing: to a temporary file that is flushed to disk before it is renamed
 * over the real one, so a crash or power cut leaves either the old file or
 * the new one, never half of each. The file being replaced is kept as
 * `<name>.bak` (a hard link: no copy is made). A write that fails — a full
 * disk, a folder Eaon may not write to — leaves the previous file as it was;
 * the new value is kept in memory, served to every read so the app carries on
 * as if it had saved, retried on a backoff, and reported until it lands.
 */

/** The file operations used here; tests swap them to inject ENOSPC, EACCES and torn writes. */
export interface StoreFs {
  read(path: string): string
  /** Writes the whole file and flushes it to disk before returning. */
  writeDurable(path: string, data: string): void
  writeDurableAsync(path: string, data: string): Promise<void>
  rename(from: string, to: string): void
  renameAsync(from: string, to: string): Promise<void>
  link(existing: string, path: string): void
  unlink(path: string): void
  copy(from: string, to: string): void
  exists(path: string): boolean
  mkdir(path: string): void
  list(dir: string): string[]
}

/**
 * What Windows reports while another process (antivirus, the search indexer,
 * a backup tool) briefly has a file open, and how long to wait it out between
 * attempts: about a second in all.
 */
const LOCKED_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const LOCKED_WAITS_MS = [20, 50, 100, 200, 300, 330]

function lockedOnWindows(error: unknown): boolean {
  return process.platform === 'win32' && LOCKED_CODES.has((error as NodeJS.ErrnoException)?.code ?? '')
}

/** Runs a synchronous file operation, trying again while Windows reports the file locked. */
function retryLocked<T>(run: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return run()
    } catch (error) {
      if (attempt >= LOCKED_WAITS_MS.length || !lockedOnWindows(error)) throw error
      // Blocks, as the synchronous writer already does; only ever while a file is locked.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCKED_WAITS_MS[attempt])
    }
  }
}

/** `retryLocked` for the async writer. */
async function retryLockedAsync(run: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= LOCKED_WAITS_MS.length || !lockedOnWindows(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, LOCKED_WAITS_MS[attempt]))
    }
  }
}

const realFs: StoreFs = {
  read: (path) => nodeFs.readFileSync(path, 'utf8'),
  writeDurable(path, data) {
    const fd = nodeFs.openSync(path, 'w')
    try {
      nodeFs.writeFileSync(fd, data, 'utf8')
      nodeFs.fsyncSync(fd)
    } finally {
      nodeFs.closeSync(fd)
    }
  },
  async writeDurableAsync(path, data) {
    const handle = await open(path, 'w')
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  rename: (from, to) => retryLocked(() => nodeFs.renameSync(from, to)),
  renameAsync: (from, to) => retryLockedAsync(() => rename(from, to)),
  link: (existing, path) => nodeFs.linkSync(existing, path),
  unlink: (path) => nodeFs.unlinkSync(path),
  copy: (from, to) => nodeFs.copyFileSync(from, to),
  exists: (path) => nodeFs.existsSync(path),
  mkdir: (path) => void nodeFs.mkdirSync(path, { recursive: true }),
  list: (dir) => nodeFs.readdirSync(dir)
}

let fs: StoreFs = realFs

/** Tests: replace some file operations (the rest stay real). Returns a function that restores them. */
export function setStoreFs(overrides: Partial<StoreFs>): () => void {
  fs = { ...realFs, ...overrides }
  return () => {
    fs = realFs
  }
}

export const storeDir = (): string => join(app.getPath('userData'), 'store')
export const docPath = (name: string): string => join(storeDir(), name)

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/* ----------------------------------------------------------------- health */

/** What the user calls each document, for the notice. Anything else is named by its file. */
const LABELS: Record<string, string> = {
  'settings.json': 'Settings',
  'chats.json': 'Chats',
  'projects.json': 'Projects',
  'workspaces.json': 'Tabs',
  'providers.json': 'Model providers',
  'mcp.json': 'MCP servers',
  'scheduled-tasks.json': 'Scheduled tasks',
  'scheduled-runs.json': 'Scheduled task history',
  'workers.json': 'Workers',
  'usage-ledger.json': 'Usage',
  'downloaded-models.json': 'Downloaded models',
  'ade-terminals.json': 'ADE terminals',
  'channels.json': 'Chat apps',
  'email.json': 'Email',
  'payments.json': 'Payments'
}

export const docLabel = (name: string): string =>
  LABELS[name] ?? (/^worker-.+\.json$/.test(name) ? 'A worker’s conversation' : name.startsWith('trading') ? 'Trading' : name)

const problems = new Map<string, StoreProblem>()
const healthListeners = new Set<(health: StoreHealth) => void>()
let problemSeq = 0

export function storeHealth(): StoreHealth {
  return { problems: [...problems.values()].sort((a, b) => a.at - b.at) }
}

export function onStoreHealth(listener: (health: StoreHealth) => void): () => void {
  healthListeners.add(listener)
  return () => healthListeners.delete(listener)
}

function emitHealth(): void {
  const health = storeHealth()
  for (const listener of healthListeners) {
    try {
      listener(health)
    } catch (error) {
      console.error('[store] health listener failed:', error)
    }
  }
}

function report(problem: Omit<StoreProblem, 'id' | 'at' | 'label'>): void {
  // One notice per file and kind: a write that keeps failing updates its
  // notice rather than stacking a new one every retry.
  const key = `${problem.kind === 'unsaved' ? 'unsaved' : 'repaired'}:${problem.file}`
  const existing = problems.get(key)
  problems.set(key, { ...problem, id: existing?.id ?? `p${++problemSeq}`, at: existing?.at ?? Date.now(), label: docLabel(problem.file) })
  const log = problem.kind === 'unsaved' ? console.error : console.warn
  log(`[store] ${problem.file}: ${problem.detail}${problem.copy ? ` (damaged copy kept at ${problem.copy})` : ''}`)
  emitHealth()
}

function resolveUnsaved(name: string): void {
  if (problems.delete(`unsaved:${name}`)) emitHealth()
}

/** The user has read a notice; it stays gone until something new happens to that file. */
export function dismissProblem(id: string): void {
  for (const [key, problem] of problems) {
    // A write still failing can't be dismissed away: the data really isn't saved.
    if (problem.id === id && problem.kind !== 'unsaved') problems.delete(key)
  }
  emitHealth()
}

/** The path a notice points at (its damaged copy), for "Show in Finder"; never anything else. */
export function problemFile(id: string): string | null {
  for (const problem of problems.values()) if (problem.id === id) return problem.copy ?? docPath(problem.file)
  return null
}

/** Tests: forget every notice. */
export function resetStoreHealthForTests(): void {
  problems.clear()
  unsaved.clear()
  blocked.clear()
  pendingValues.clear()
  inflightValues.clear()
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  retryDelay = RETRY_FIRST_MS
}

function writeFailure(name: string, error: unknown): string {
  const code = errorCode(error)
  switch (code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'Your disk is full, so Eaon can’t save changes. Free up some space; Eaon keeps your changes and saves them as soon as it can.'
    case 'EACCES':
    case 'EPERM':
      return `Eaon isn’t allowed to write to its data folder (${storeDir()}). Check that folder’s permissions; Eaon keeps your changes and saves them as soon as it can.`
    case 'EROFS':
      return 'Eaon’s data folder is on a read-only disk, so changes can’t be saved.'
    default:
      return `Eaon couldn’t save ${docLabel(name).toLowerCase()} (${code ?? errorText(error)}). It keeps your changes and tries again shortly.`
  }
}

/* ---------------------------------------------------------- write tracking */

/** Values whose write failed, by document: served to reads until a retry lands. */
const unsaved = new Map<string, { value: unknown; async: boolean }>()
/** The newest value waiting for a document's queued async write, which has not started yet. */
const pendingValues = new Map<string, unknown>()
/** The value an async write is writing right now. */
const inflightValues = new Map<string, unknown>()
const writeQueues = new Map<string, Promise<void>>()

const RETRY_FIRST_MS = 15_000
const RETRY_MAX_MS = 5 * 60_000
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = RETRY_FIRST_MS

function scheduleRetry(): void {
  if (retryTimer || unsaved.size === 0) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    for (const [name, entry] of unsaved) {
      // Async ones go back through the queue, behind any newer write.
      if (entry.async) writeDocAsync(name, entry.value)
      else writeDocSync(name, entry.value)
    }
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
    scheduleRetry()
  }, retryDelay)
  retryTimer.unref?.()
}

function succeeded(name: string): void {
  unsaved.delete(name)
  // Also when the failed value itself was never kept (a newer one was
  // already queued): this write is that newer one.
  resolveUnsaved(name)
  if (unsaved.size === 0) {
    retryDelay = RETRY_FIRST_MS
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }
}

function failed(name: string, value: unknown, error: unknown, async: boolean): void {
  // A newer value may already be waiting for its own write; only remember
  // this one if nothing has replaced it.
  if (!pendingValues.has(name)) unsaved.set(name, { value, async })
  report({ kind: 'unsaved', file: name, detail: writeFailure(name, error), code: errorCode(error) })
  scheduleRetry()
}

/** Documents that keep their previous save as `<name>.bak`. Large growing logs don't. */
const backedUp = (name: string, async: boolean): boolean => !async || name === 'chats.json'

let tmpSeq = 0
/** Unique per write: a synchronous save landing while an async one is mid-write must not share its temp file. */
const tmpPath = (target: string): string => `${target}.${process.pid}-${++tmpSeq}.tmp`

function ensureDirFor(target: string): void {
  const dir = dirname(target)
  if (!fs.exists(dir)) fs.mkdir(dir)
}

/** Keeps the file about to be replaced as `.bak`. Best effort: a filesystem without hard links just has no backup. */
function linkBackup(target: string): void {
  if (!fs.exists(target)) return
  const bak = `${target}.bak`
  try {
    if (fs.exists(bak)) fs.unlink(bak)
    fs.link(target, bak)
  } catch {
    /* no backup this time */
  }
}

/**
 * Documents that exist but could not be read for a passing reason (too many
 * open files, a busy or failing disk). Until a read succeeds, nothing is
 * written over them: whatever the app would save was built on an empty
 * default, not on what the file holds.
 */
const blocked = new Set<string>()
const TRANSIENT = new Set(['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EINTR', 'EIO', 'ETIMEDOUT'])

function refuseBlocked(name: string): boolean {
  if (!blocked.has(name)) return false
  report({
    kind: 'unsaved',
    file: name,
    detail: 'Eaon couldn’t read this file, so it isn’t saving over it in case that loses what it holds. Quit and reopen Eaon.'
  })
  return true
}

/** Writes a document now. Never throws for disk trouble: that is reported, kept, and retried. */
export function writeDocSync(name: string, value: unknown, pretty = true): void {
  // A programming error (a cycle) should still surface, before any file is touched.
  const json = JSON.stringify(value, null, pretty ? 2 : undefined)
  if (refuseBlocked(name)) return
  const target = docPath(name)
  const tmp = tmpPath(target)
  try {
    ensureDirFor(target)
    fs.writeDurable(tmp, json)
    if (backedUp(name, false)) linkBackup(target)
    fs.rename(tmp, target)
  } catch (error) {
    try {
      fs.unlink(tmp)
    } catch {
      /* never created */
    }
    failed(name, value, error, false)
    return
  }
  succeeded(name)
}

/**
 * Atomic write that does not block the main process.
 *
 * Chat history grows without bound, and a synchronous multi-megabyte write
 * freezes everything the main process drives — IPC, input, painting — for its
 * whole duration. Writes to the same file are chained so a slow one cannot be
 * overtaken by the next, and the output is compact rather than pretty-printed:
 * nothing reads these files by hand, and the indentation roughly doubled both
 * the bytes and the stringify cost.
 *
 * Saves that arrive while a write is still running collapse into one: only the
 * newest is written, and it is only stringified when its turn comes. Each save
 * is the whole file, so the ones in between would be overwritten unread — and
 * every one held its own multi-megabyte string until then.
 */
export function writeDocAsync(name: string, value: unknown): void {
  if (refuseBlocked(name)) return
  const alreadyQueued = pendingValues.has(name)
  pendingValues.set(name, value)
  if (alreadyQueued) return
  const target = docPath(name)
  const queued = (writeQueues.get(name) ?? Promise.resolve()).then(async () => {
    const latest = pendingValues.get(name)
    pendingValues.delete(name)
    inflightValues.set(name, latest)
    const tmp = tmpPath(target)
    try {
      ensureDirFor(target)
      await fs.writeDurableAsync(tmp, JSON.stringify(latest))
      if (backedUp(name, true)) linkBackup(target)
      await fs.renameAsync(tmp, target)
      succeeded(name)
    } catch (error) {
      try {
        fs.unlink(tmp)
      } catch {
        /* never created */
      }
      failed(name, latest, error, true)
    } finally {
      inflightValues.delete(name)
    }
  })
  writeQueues.set(name, queued)
  void queued.finally(() => {
    if (writeQueues.get(name) === queued) writeQueues.delete(name)
  })
}

/** Waits for every queued write, and tries once more to save anything a failed write left unsaved. */
export async function flushDocWrites(): Promise<void> {
  for (const [name, entry] of unsaved) if (!pendingValues.has(name)) writeDocAsync(name, entry.value)
  while (writeQueues.size > 0) await Promise.all([...writeQueues.values()])
}

/* -------------------------------------------------------------- reading */

/** What a repair pass did to a document that parsed. */
export interface Repaired<T> {
  value: T
  /** Records left out (duplicates, ones with no id). A copy of the file is kept when this is above zero. */
  dropped: number
  /** Fields put right in place (a missing list, an impossible time, an unknown option). */
  fixed: number
  /** What the notice says, beyond the counts. */
  notes?: string[]
}

export interface DocSpec<T> {
  /** A fresh default, when there is nothing usable on disk. */
  fallback: () => T
  /** Checks and repairs a parsed value; null when it is not this document at all. */
  repair: (value: unknown) => Repaired<T> | null
  /** Whether to pretty-print when writing back a repair (matches how the document is normally written). */
  pretty?: boolean
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')
/** Damaged copies kept per document; older ones go, so a file that keeps breaking can't fill the disk. */
const KEEP_CORRUPT = 5

/** Copies a damaged file aside, or moves it when it can't even be read. Returns the copy's path. */
function keepCopy(name: string, move = false): string | undefined {
  const target = docPath(name)
  const copy = `${target}.corrupt-${stamp()}`
  try {
    if (move) fs.rename(target, copy)
    else fs.copy(target, copy)
  } catch (error) {
    console.error(`[store] could not keep a copy of ${name}:`, error)
    return undefined
  }
  try {
    const prefix = `${name}.corrupt-`
    const dir = dirname(target)
    const copies = fs
      .list(dir)
      .filter((file) => file.startsWith(prefix))
      .sort()
    for (const old of copies.slice(0, Math.max(0, copies.length - KEEP_CORRUPT))) fs.unlink(join(dir, old))
  } catch {
    /* pruning is housekeeping */
  }
  return copy
}

/**
 * The longest complete prefix of a JSON array or object that was cut off:
 * every top-level element (or key) before the cut, closed off. Undefined when
 * there is nothing to recover. Cut points are commas at the top level, outside
 * strings; a prefix ending at one is complete whatever came after it. Damage
 * in the middle of the file makes later cut points useless, so the longest
 * prefix that parses is found by binary search rather than by trying them all.
 */
export function salvageJson(text: string): unknown {
  const start = text.search(/\S/)
  if (start === -1) return undefined
  const open = text[start]
  if (open !== '[' && open !== '{') return undefined
  const close = open === '[' ? ']' : '}'
  const cuts: number[] = []
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 1) cuts.push(i)
    if (depth <= 0 && i > start) break
  }
  const attempt = (cut: number): unknown => {
    try {
      return JSON.parse(text.slice(start, cut) + close)
    } catch {
      return undefined
    }
  }
  let lo = 0
  let hi = cuts.length - 1
  let best: unknown = undefined
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const parsed = attempt(cuts[mid])
    if (parsed === undefined) hi = mid - 1
    else {
      best = parsed
      lo = mid + 1
    }
  }
  // Nothing before the first comma either: an empty container is no recovery.
  return best
}

const describeCount = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function parseAndRepair<T>(text: string, spec: DocSpec<T>): Repaired<T> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return spec.repair(parsed)
}

/** A read, tried again a couple of times when the error is one that passes (EMFILE, EBUSY). */
function readWithRetry(path: string): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.read(path)
    } catch (error) {
      if (attempt >= 2 || !TRANSIENT.has(errorCode(error) ?? '')) throw error
    }
  }
}

/** The `.bak` copy, when it parses and passes the repair. */
function fromBackup<T>(name: string, spec: DocSpec<T>): Repaired<T> | null {
  const bak = `${docPath(name)}.bak`
  try {
    if (!fs.exists(bak)) return null
    return parseAndRepair(fs.read(bak), spec)
  } catch {
    return null
  }
}

/** A copy the caller may change; JSON's, for anything structuredClone refuses (an object with methods). */
function copyOf(value: unknown): unknown {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value) ?? 'null')
  }
}

/** A clone of a value a write is still holding (queued, in flight, or failed), so reads see the latest save. */
function overlay(name: string): { value: unknown } | null {
  if (pendingValues.has(name)) return { value: pendingValues.get(name) }
  if (inflightValues.has(name)) return { value: inflightValues.get(name) }
  const failedWrite = unsaved.get(name)
  return failedWrite ? { value: failedWrite.value } : null
}

/**
 * Reads a document, repairing or recovering it as described at the top of
 * this file. Never throws, and never returns something of the wrong shape.
 */
export function readDoc<T>(name: string, spec: DocSpec<T>): T {
  const pending = overlay(name)
  if (pending) {
    const repaired = spec.repair(copyOf(pending.value))
    if (repaired) return repaired.value
  }
  const target = docPath(name)
  let text: string
  try {
    text = readWithRetry(target)
    if (blocked.delete(name)) resolveUnsaved(name)
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return spec.fallback()
    if (TRANSIENT.has(errorCode(error) ?? '')) {
      blocked.add(name)
      console.error(`[store] ${name} could not be read (${errorCode(error)}); not writing over it until it can be`)
      return spec.fallback()
    }
    // Present but unreadable (permissions). Writing over it would lose it
    // for good, so it is moved aside — a rename needs no read access — and
    // the previous save used, if there is one.
    const copy = keepCopy(name, true)
    return recover(name, spec, '', copy, `couldn’t be read (${errorCode(error) ?? errorText(error)})`)
  }

  const repaired = parseAndRepair(text, spec)
  if (!repaired) return recover(name, spec, text, keepCopy(name), text.trim() ? 'was damaged' : 'was empty')
  if (repaired.dropped > 0 || repaired.fixed > 0) {
    // Lossless fixes don't need a copy; anything left out does.
    const copy = repaired.dropped > 0 ? keepCopy(name) : undefined
    writeDocSync(name, repaired.value, spec.pretty ?? true)
    const parts = [
      repaired.dropped > 0 ? `${describeCount(repaired.dropped, 'damaged entry was', 'damaged entries were')} set aside` : null,
      repaired.fixed > 0 ? `${describeCount(repaired.fixed, 'value was', 'values were')} repaired` : null,
      ...(repaired.notes ?? [])
    ].filter(Boolean)
    // Only what the user could notice gets a notice: a dropped record. Quiet
    // fixes (an unknown option reset to its default) are logged.
    if (repaired.dropped > 0) report({ kind: 'repaired', file: name, detail: `${parts.join('; ')}.`, copy })
    else console.warn(`[store] ${name}: ${parts.join('; ')}.`)
  }
  return repaired.value
}

function recover<T>(name: string, spec: DocSpec<T>, text: string, copy: string | undefined, what: string): T {
  const backup = fromBackup(name, spec)
  if (backup) {
    writeDocSync(name, backup.value, spec.pretty ?? true)
    report({ kind: 'restored', file: name, detail: `The file ${what}, so Eaon restored the copy from the save before.`, copy })
    return backup.value
  }
  const salvaged = text ? salvageJson(text) : undefined
  const partial = salvaged === undefined ? null : spec.repair(salvaged)
  if (partial && !isEmptyValue(partial.value)) {
    writeDocSync(name, partial.value, spec.pretty ?? true)
    report({ kind: 'repaired', file: name, detail: `The file ${what}; Eaon kept everything in it that was still complete.`, copy })
    return partial.value
  }
  const fresh = spec.fallback()
  writeDocSync(name, fresh, spec.pretty ?? true)
  report({ kind: 'reset', file: name, detail: `The file ${what} and nothing in it could be recovered, so it starts over.`, copy })
  return fresh
}

function isEmptyValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return value === null || value === undefined
}

/**
 * A repair for documents the store knows nothing about beyond their shape:
 * the fallback says whether a list or an object is expected. A document that
 * parses to the other shape (or to null) is treated as damaged rather than
 * handed to code that would crash on it or save it back over the real thing.
 */
export function shapeOf<T>(fallback: T): DocSpec<T> {
  return {
    fallback: () => structuredClone(fallback),
    repair: (value) => {
      if (Array.isArray(fallback)) return Array.isArray(value) ? { value: value as T, dropped: 0, fixed: 0 } : null
      if (isPlainObject(fallback)) return isPlainObject(value) ? { value: value as T, dropped: 0, fixed: 0 } : null
      return { value: value as T, dropped: 0, fixed: 0 }
    }
  }
}

/**
 * For a feature that checks its own records: keeps a copy of the file as it
 * is now (before the feature saves it without the records it left out) and
 * tells the user.
 */
export function setAside(name: string, detail: string): void {
  const copy = fs.exists(docPath(name)) ? keepCopy(name) : undefined
  report({ kind: 'repaired', file: name, detail, copy })
}

/**
 * Removes temp files a crash left behind. Run once at startup, before
 * anything writes: every temp file in the folder belongs to a write that
 * never finished.
 */
export function sweepTempFiles(): void {
  try {
    const dir = storeDir()
    if (!fs.exists(dir)) return
    for (const file of fs.list(dir)) if (file.endsWith('.tmp')) fs.unlink(join(dir, file))
  } catch {
    /* housekeeping */
  }
}

/** Copies these documents into `store/backups/<label>-<time>/` before a migration rewrites them. Returns the folder. */
export function backupDocs(label: string, names: string[]): string | null {
  const present = names.filter((name) => fs.exists(docPath(name)))
  if (present.length === 0) return null
  const root = join(storeDir(), 'backups')
  const dir = join(root, `${label}-${stamp()}`)
  try {
    fs.mkdir(dir)
    for (const name of present) fs.copy(docPath(name), join(dir, name))
  } catch (error) {
    console.error(`[store] could not back up before ${label}:`, error)
    return null
  }
  try {
    // The newest few are what anyone would go back to; the folder must not
    // grow by a copy of every chat at each migration forever.
    const when = (folder: string): string => /\d{4}-\d{2}-\d{2}T[\d-]+Z$/.exec(folder)?.[0] ?? ''
    const folders = fs.list(root).sort((a, b) => when(a).localeCompare(when(b)))
    for (const old of folders.slice(0, Math.max(0, folders.length - KEEP_BACKUPS))) nodeFs.rmSync(join(root, old), { recursive: true, force: true })
  } catch {
    /* housekeeping */
  }
  return dir
}

const KEEP_BACKUPS = 10
