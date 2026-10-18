import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { WorkerWatch } from '@shared/workers'
import { htmlToText } from '../../webSearch'
import { killTree, shellEnv, shellLine, watchProcessExit } from '../../localTools'

/**
 * What a sleeping worker can be woken by besides the clock: a process
 * exiting (a build, a training run started with background: true) or a file
 * or folder changing. Events, not polling, wherever the system gives one —
 * the sleep's minutes are only the longest it waits.
 */

export interface WakeCondition {
  /** A process id to wait on. */
  processExits?: number
  /** A file or folder to wait on; one that doesn't exist yet wakes it when it appears. */
  fileChanges?: string
}

/** Starts watching; `onEvent` gets one line saying what happened, once. Returns the way to stop. */
export function watchFor(condition: WakeCondition, onEvent: (what: string) => void): () => void {
  let fired = false
  const stops: (() => void)[] = []
  const fire = (what: string): void => {
    if (fired) return
    fired = true
    for (const stop of stops) stop()
    onEvent(what)
  }
  if (typeof condition.processExits === 'number' && Number.isInteger(condition.processExits) && condition.processExits > 0) {
    const pid = condition.processExits
    stops.push(watchProcessExit(pid, (code) => fire(`process ${pid} exited${code === null ? '' : ` with code ${code}`}`)))
  }
  if (typeof condition.fileChanges === 'string' && condition.fileChanges.trim()) {
    const path = condition.fileChanges.trim()
    let timer: ReturnType<typeof setTimeout> | undefined
    // Writes come in bursts; wait for a quiet moment so the worker reads the finished file.
    const changed = (what: string): void => {
      clearTimeout(timer)
      timer = setTimeout(() => fire(what), 500)
    }
    let watcher: FSWatcher | null = null
    try {
      if (existsSync(path)) {
        watcher = watch(path, { persistent: false }, () => changed(`${path} changed`))
      } else {
        const name = basename(path)
        watcher = watch(dirname(path), { persistent: false }, (_event, file) => {
          if (file && String(file) === name && existsSync(path)) changed(`${path} appeared`)
        })
      }
      watcher.on('error', () => watcher?.close())
    } catch {
      // A folder that can't be watched (gone, no permission): the clock still wakes it.
      watcher = null
    }
    stops.push(() => {
      clearTimeout(timer)
      watcher?.close()
    })
  }
  return () => {
    fired = true
    for (const stop of stops) stop()
  }
}

/**
 * Looking at what a worker watches, and deciding whether that wakes it.
 *
 * `look` reads the thing itself: a page fetched as text, a file's contents
 * (or a folder's listing), a check command's exit code and output. `judge`
 * compares that with the last look and the watch's condition. Neither ever
 * calls a model: a worker watching a site for a day costs nothing until the
 * site changes.
 */

/** What one look saw. `ok` is false when the page errored, the file is missing, or the command failed. */
export interface WatchReading {
  ok: boolean
  /** What `change`, `contains` and `missing` compare: page text, file text or listing, command output. */
  content: string
  /** One line for the user and the worker: "HTTP 200 · 14 KB", "missing", "exit code 1". */
  summary: string
}

export interface WatchVerdict {
  met: boolean
  fingerprint: string
  /** Whether this look wakes the worker. */
  fire: boolean
  /** What happened, for the worker's mail: "the page changed", "it recovered". */
  what: string
}

const URL_TIMEOUT_MS = 20_000
const COMMAND_TIMEOUT_MS = 60_000
/** What a look keeps to compare: enough for any real page, small enough to hold for twenty watches. */
const MAX_CONTENT = 200_000
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** Where a watched path is: absolute, `~/…`, or relative to the worker's folder. */
export function watchPath(target: string, folder: string): string {
  const path = target.trim()
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1))
  return isAbsolute(path) ? path : resolve(folder, path)
}

const size = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

async function lookAtUrl(url: string, signal?: AbortSignal): Promise<WatchReading> {
  try {
    const timeout = AbortSignal.timeout(URL_TIMEOUT_MS)
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 Eaon',
        Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5'
      },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    const type = response.headers.get('content-type') ?? ''
    const raw = (await response.text()).slice(0, MAX_CONTENT * 4)
    const content = (/html/.test(type) ? htmlToText(raw) : raw).slice(0, MAX_CONTENT)
    return { ok: response.ok, content, summary: `HTTP ${response.status} · ${size(raw.length)}` }
  } catch (error) {
    const reason = error instanceof Error ? (error.name === 'TimeoutError' ? `no answer in ${URL_TIMEOUT_MS / 1000} s` : error.message) : String(error)
    return { ok: false, content: '', summary: `unreachable: ${reason}` }
  }
}

async function lookAtPath(path: string): Promise<WatchReading> {
  let info
  try {
    info = await stat(path)
  } catch {
    return { ok: false, content: '', summary: 'missing' }
  }
  if (info.isDirectory()) {
    const entries = (await readdir(path, { withFileTypes: true }).catch(() => [])).filter((e) => !e.name.startsWith('.'))
    const lines = await Promise.all(
      entries.slice(0, 2000).map(async (entry) => {
        const inner = await stat(join(path, entry.name)).catch(() => null)
        return `${entry.name}${entry.isDirectory() ? '/' : ''}\t${inner ? `${inner.size}\t${Math.round(inner.mtimeMs)}` : ''}`
      })
    )
    lines.sort()
    return { ok: true, content: lines.join('\n'), summary: `folder · ${entries.length} item${entries.length === 1 ? '' : 's'}` }
  }
  const summary = `${size(info.size)}, modified ${new Date(info.mtimeMs).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
  if (info.size > MAX_FILE_BYTES) return { ok: true, content: `${info.size}:${Math.round(info.mtimeMs)}`, summary }
  const text = await readFile(path, 'utf8').catch(() => null)
  return { ok: true, content: text === null ? `${info.size}:${Math.round(info.mtimeMs)}` : text.slice(0, MAX_CONTENT), summary }
}

function lookAtCommand(command: string, cwd: string, signal?: AbortSignal): Promise<WatchReading> {
  return new Promise((done) => {
    let output = ''
    let settled = false
    const child = spawn(shellLine(command), {
      shell: process.platform === 'win32' ? true : process.env.SHELL || '/bin/bash',
      cwd,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...shellEnv() }
    })
    const finish = (reading: WatchReading): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      done(reading)
    }
    const kill = (): void => {
      try {
        if (child.pid) killTree(child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    const abort = (): void => {
      kill()
      finish({ ok: false, content: output, summary: 'stopped' })
    }
    const timer = setTimeout(() => {
      kill()
      finish({ ok: false, content: output.slice(-MAX_CONTENT), summary: `killed after ${COMMAND_TIMEOUT_MS / 1000} s` })
    }, COMMAND_TIMEOUT_MS)
    signal?.addEventListener('abort', abort, { once: true })
    const take = (chunk: Buffer): void => {
      if (output.length < MAX_CONTENT) output += chunk.toString('utf8')
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', (error) => finish({ ok: false, content: '', summary: `could not run: ${error.message}` }))
    child.on('close', (code, sig) => {
      const last = output.trim().split('\n').pop()?.trim() ?? ''
      const status = sig ? `terminated (${sig})` : `exit code ${code}`
      finish({ ok: code === 0 && !sig, content: output.slice(0, MAX_CONTENT), summary: last ? `${status} · ${last.slice(0, 120)}` : status })
    })
  })
}

/** One look at what `watch` watches. Never throws: a failure to look is a reading too. */
export function look(watch: Pick<WorkerWatch, 'kind' | 'target'>, folder: string, signal?: AbortSignal): Promise<WatchReading> {
  if (watch.kind === 'url') return lookAtUrl(watch.target, signal)
  if (watch.kind === 'file') return lookAtPath(watchPath(watch.target, folder))
  return lookAtCommand(watch.target, folder, signal)
}

/** Whitespace doesn't count as a change. */
export function fingerprint(content: string): string {
  return createHash('sha1').update(content.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)
}

/**
 * Whether this look wakes the worker. `contains` and `missing` fire when the
 * condition starts to hold, not on every look while it does; `fails` fires
 * when it goes down and again when it comes back; `change` fires on any
 * difference after the first look, which only sets the baseline.
 */
export function judge(watch: Pick<WorkerWatch, 'when' | 'text' | 'last'>, reading: WatchReading): WatchVerdict {
  const print = fingerprint(reading.content)
  const last = watch.last
  const needle = watch.text.trim().toLowerCase()
  const has = needle.length > 0 && reading.content.toLowerCase().includes(needle)
  switch (watch.when) {
    case 'change': {
      // A failed look is not a change of content: a site that is briefly down
      // would otherwise wake the worker twice, going and coming back.
      if (!reading.ok) return { met: last?.met ?? false, fingerprint: last?.fingerprint ?? print, fire: false, what: '' }
      const changed = last !== null && last.fingerprint !== print
      return { met: changed, fingerprint: print, fire: changed, what: 'it changed' }
    }
    case 'contains': {
      const met = reading.ok && has
      return { met, fingerprint: print, fire: met && !last?.met, what: `"${watch.text.trim()}" appeared` }
    }
    case 'missing': {
      // Unknown, not missing, when the look itself failed.
      const met = reading.ok && !has
      return { met, fingerprint: print, fire: met && !last?.met, what: `"${watch.text.trim()}" is gone` }
    }
    case 'fails': {
      const met = !reading.ok
      if (met && !last?.met) return { met, fingerprint: print, fire: true, what: 'it is failing' }
      if (!met && last?.met) return { met, fingerprint: print, fire: true, what: 'it recovered' }
      return { met, fingerprint: print, fire: false, what: '' }
    }
  }
}

/**
 * The lines this look has that the last didn't, for a page or file that
 * changed: what the worker most likely needs, without a diff library.
 */
export function newLines(before: string | undefined, after: string, max = 15): string[] {
  if (!before) return []
  const seen = new Set(before.split('\n').map((l) => l.trim()))
  const out: string[] = []
  for (const line of after.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed)
    if (out.length >= max) break
  }
  return out
}
