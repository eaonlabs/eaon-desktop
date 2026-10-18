import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { killTree, shellEnv, shellLine } from '../../localTools'

/**
 * Workers' background jobs, as processes: a command started outside any
 * turn, its output going to a log file, killed at its time limit, and a
 * callback when it ends. The engine keeps the record (`WorkerJob`) and turns
 * the end into mail; this only runs processes, so tests can stand in a fake.
 */

export interface JobSpec {
  id: string
  command: string
  cwd: string
  log: string
  timeoutMs: number
}

export interface JobEnd {
  /** "exit code 0", "terminated (SIGTERM)", "stopped", "timed out after 6 h". */
  result: string
  ok: boolean
  /** The last of its output. */
  tail: string
}

export interface JobHost {
  /** Starts it; `onEnd` is called once, however it ends. Throws when it can't start. */
  start: (spec: JobSpec, onEnd: (end: JobEnd) => void) => { pid: number | null }
  /** Ends it (and everything it started). False when it isn't running. */
  stop: (id: string) => boolean
  /** The last `lines` lines of a log, read from the end. */
  tail: (log: string, lines?: number) => Promise<string>
  /** Ends every job, for quitting. */
  stopAll: () => void
}

const TAIL_BYTES = 64 * 1024

/** The last `lines` lines of a file, reading at most its last 64 KB. Empty when it can't be read. */
export async function readTail(path: string, lines = 40): Promise<string> {
  try {
    const info = await stat(path)
    const length = Math.min(info.size, TAIL_BYTES)
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, info.size - length)
      const text = buffer.toString('utf8')
      const all = text.split('\n')
      // A cut at the front leaves half a line; drop it.
      if (info.size > length) all.shift()
      while (all.length && !all[all.length - 1].trim()) all.pop()
      return all.slice(-lines).join('\n')
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

export function hoursText(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`
}

export function createJobHost(): JobHost {
  const running = new Map<string, { child: ChildProcess; stopped: boolean; timer: ReturnType<typeof setTimeout> }>()

  const kill = (child: ChildProcess): void => {
    if (!child.pid || child.exitCode !== null) return
    try {
      killTree(child.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
    // Whatever ignores SIGTERM goes a little later.
    setTimeout(() => {
      try {
        if (child.pid && child.exitCode === null) killTree(child.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }, 5000).unref()
  }

  return {
    start(spec, onEnd) {
      mkdirSync(dirname(spec.log), { recursive: true })
      const out = createWriteStream(spec.log, { flags: 'a' })
      out.on('error', () => {})
      const child = spawn(shellLine(spec.command), {
        shell: process.platform === 'win32' ? true : process.env.SHELL || '/bin/bash',
        cwd: spec.cwd,
        // Its own process group, so stopping it stops what it started.
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...shellEnv() }
      })
      let timedOut = false
      const entry = {
        child,
        stopped: false,
        timer: setTimeout(() => {
          timedOut = true
          kill(child)
        }, spec.timeoutMs)
      }
      entry.timer.unref?.()
      running.set(spec.id, entry)
      child.stdout?.pipe(out, { end: false })
      child.stderr?.pipe(out, { end: false })
      let ended = false
      const end = (result: string, ok: boolean): void => {
        if (ended) return
        ended = true
        clearTimeout(entry.timer)
        running.delete(spec.id)
        out.end(() => {
          void readTail(spec.log).then((tail) => onEnd({ result, ok, tail }))
        })
      }
      child.on('error', (error) => end(`could not start: ${error.message}`, false))
      child.on('close', (code, signal) => {
        if (entry.stopped) end('stopped', false)
        else if (timedOut) end(`timed out after ${hoursText(spec.timeoutMs)}`, false)
        else end(signal ? `terminated (${signal})` : `exit code ${code}`, code === 0)
      })
      return { pid: child.pid ?? null }
    },
    stop(id) {
      const entry = running.get(id)
      if (!entry) return false
      entry.stopped = true
      kill(entry.child)
      return true
    },
    tail: readTail,
    stopAll() {
      for (const entry of running.values()) {
        entry.stopped = true
        kill(entry.child)
      }
    }
  }
}
