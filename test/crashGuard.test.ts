import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { crashLogPath, installCrashGuard, logCrash, ReloadBudget } from '../src/main/crashGuard'

/**
 * Crashes leave a line in crashes.log, and a crashed window comes back — a few
 * times, then the user decides. The guard's Electron listeners are captured
 * from the stub and fired by hand.
 */

const appHandlers = new Map<string, (...args: unknown[]) => void>()
const ipcHandlers = new Map<string, (...args: unknown[]) => void>()
Object.assign(app, { on: (event: string, handler: (...args: unknown[]) => void) => appHandlers.set(event, handler) })
Object.assign(ipcMain, { on: (channel: string, handler: (...args: unknown[]) => void) => ipcHandlers.set(channel, handler) })
const dialogs: string[] = []
Object.assign(dialog, {
  showMessageBox: async (_window: unknown, options: { message: string }) => {
    dialogs.push(options.message)
    return { response: -1 }
  }
})
const window = new BrowserWindow()
Object.assign(BrowserWindow, { fromWebContents: () => window })

// The guard's own process listeners, called directly: emitting the events would reach the test runner's too.
const runnerListeners = new Set<unknown>([...process.listeners('uncaughtException'), ...process.listeners('unhandledRejection')])
/** Pages the guard is told belong to Eaon's own windows; any other window is a helper (a worker's browser). */
const appPages = new Set<unknown>()
installCrashGuard((page) => appPages.has(page))
const added = (event: 'uncaughtException' | 'unhandledRejection'): ((...args: unknown[]) => void) =>
  process.listeners(event).find((listener) => !runnerListeners.has(listener)) as (...args: unknown[]) => void
const onException = added('uncaughtException')
const onRejection = added('unhandledRejection')
test.after(() => {
  process.removeListener('uncaughtException', onException)
  process.removeListener('unhandledRejection', onRejection)
})

const log = (): string => (existsSync(crashLogPath()) ? readFileSync(crashLogPath(), 'utf8') : '')
const contents = (type: string, appWindow = true) => {
  const reloads = { count: 0 }
  const page = { getType: () => type, getURL: () => 'file:///index.html', reload: () => reloads.count++ }
  if (appWindow) appPages.add(page)
  return { reloads, contents: page }
}

test('a main-process exception or rejection nobody caught is logged, not fatal', () => {
  onException(new Error('socket hung up'))
  onRejection(new Error('fetch failed'), Promise.resolve())
  assert.match(log(), /\[main: uncaught exception\] Error: socket hung up\n\s+at /)
  assert.match(log(), /\[main: unhandled rejection\] Error: fetch failed/)
})

test('a renderer error reported by the window lands in the log, with its stack', () => {
  ipcHandlers.get('app:report-error')!({}, { message: 'x is undefined', stack: 'TypeError: x is undefined\n    at ChatView', source: 'render' })
  ipcHandlers.get('app:report-error')!({}, { nonsense: true })
  assert.match(log(), /\[renderer: render\] TypeError: x is undefined\n    at ChatView/)
  assert.doesNotMatch(log(), /nonsense/)
})

test('a worker’s hidden browser window is logged, not reloaded, and leaves the budget alone', () => {
  const gone = appHandlers.get('render-process-gone')!
  const worker = contents('window', false)
  for (let i = 0; i < 5; i++) gone({}, worker.contents, { reason: 'crashed', exitCode: 5 })
  assert.equal(worker.reloads.count, 0)
  assert.deepEqual(dialogs, [])
  assert.match(log(), /\[renderer gone \(window\)\] crashed, exit code 5/)
  // The next test's three reloads show the budget is still whole.
})

test('a crashed window is reloaded three times, then the user is asked', () => {
  const gone = appHandlers.get('render-process-gone')!
  const main = contents('window')
  for (let i = 0; i < 3; i++) gone({}, main.contents, { reason: 'crashed', exitCode: 11 })
  assert.equal(main.reloads.count, 3)
  assert.deepEqual(dialogs, [])
  gone({}, main.contents, { reason: 'oom', exitCode: 0 })
  assert.equal(main.reloads.count, 3, 'a fourth crash in five minutes is not reloaded')
  assert.deepEqual(dialogs, ['Eaon’s window keeps crashing'])
  assert.match(log(), /\[renderer gone \(window\)\] crashed, exit code 11/)
  assert.match(log(), /\[renderer gone \(window\)\] oom/)
})

test('a webview’s crash, or a renderer that exited cleanly, is not reloaded', () => {
  const gone = appHandlers.get('render-process-gone')!
  const webview = contents('webview')
  gone({}, webview.contents, { reason: 'crashed', exitCode: 11 })
  assert.equal(webview.reloads.count, 0)
  assert.match(log(), /\[renderer gone \(webview\)\] crashed/)
  const clean = contents('window')
  gone({}, clean.contents, { reason: 'clean-exit', exitCode: 0 })
  assert.equal(clean.reloads.count, 0)
})

test('the reload budget refills after five minutes', () => {
  const budget = new ReloadBudget(3, 5 * 60_000)
  const t = 1_000_000
  assert.deepEqual([budget.take(t), budget.take(t + 1), budget.take(t + 2), budget.take(t + 3)], [true, true, true, false])
  assert.equal(budget.take(t + 5 * 60_000 + 1), true)
})

test('the log keeps the last megabyte and starts a fresh file', () => {
  writeFileSync(crashLogPath(), 'x'.repeat(1_000_001))
  logCrash('test', 'after rotation')
  assert.match(readFileSync(crashLogPath(), 'utf8'), /^\S+ \[test\] after rotation\n$/)
  assert.equal(readFileSync(join(crashLogPath(), '..', 'crashes.old.log'), 'utf8').length, 1_000_001)
})
