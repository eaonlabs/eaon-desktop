import { existsSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { watchProcessExit } from '../../localTools'

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
