#!/usr/bin/env node
/**
 * Runs the end-to-end suite: the built app, driven over DevTools, against a
 * fake model server (test/e2e). Each scenario is a node:test test.
 *
 *   npm run test:e2e                 build if needed, then every scenario
 *   npm run test:e2e -- chat         only files whose name contains "chat" (several names: chat windows)
 *   npm run test:e2e -- --no-build   use out/ as it is
 *   npm run test:e2e -- --repeat 3   run the whole selection three times
 *
 * The app is rebuilt when out/ is missing or older than anything it is built
 * from (src/, the electron-vite config, package.json).
 *
 * Environment:
 *   EAON_E2E_ARTIFACTS  where profiles, logs and screenshots go (default out/e2e)
 *   EAON_E2E_SCREENS    screenshots only (default <artifacts>/screens)
 *   EAON_E2E_KEEP=1     keep each scenario's profile and HOME afterwards
 *   EAON_E2E_TIMEOUT_SCALE=<n>  stretch every timeout n times (default: 1, up to 4
 *                       when the machine's load average is high; see timing.mjs)
 *
 * On Linux it needs a display; CI runs it under `xvfb-run`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { loadavg, cpus } from 'node:os'
import { timeoutScale } from '../test/e2e/timing.mjs'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const noBuild = args.includes('--no-build')
const repeatAt = args.indexOf('--repeat')
const repeat = repeatAt === -1 ? 1 : Math.max(1, Number(args[repeatAt + 1]) || 1)
const filters = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--repeat')

/** Newest modification time under a path (files only). */
function newest(path) {
  if (!existsSync(path)) return 0
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.mtimeMs
  let latest = 0
  for (const entry of readdirSync(path)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    latest = Math.max(latest, newest(join(path, entry)))
  }
  return latest
}

const built = Math.min(newest(join(root, 'out', 'main', 'index.js')), newest(join(root, 'out', 'renderer', 'index.html')), newest(join(root, 'out', 'preload')))
const sources = Math.max(newest(join(root, 'src')), newest(join(root, 'electron.vite.config.ts')), newest(join(root, 'package.json')))
if (!noBuild && (built === 0 || built < sources)) {
  console.log(built === 0 ? 'No build in out/; building…' : 'out/ is older than src/; rebuilding…')
  const result = spawnSync('npx', ['electron-vite', 'build'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' })
  if (result.status !== 0) {
    console.error(`${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-8000))
    process.exit(result.status ?? 1)
  }
  console.log('Built.')
} else if (built === 0) {
  console.error('No build in out/ and --no-build was given. Run `npx electron-vite build` first.')
  process.exit(1)
}

const dir = join(root, 'test', 'e2e')
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.e2e.mjs') && (filters.length === 0 || filters.some((name) => f.includes(name))))
  .sort()
  .map((f) => join(dir, f))
if (files.length === 0) {
  console.log('No scenarios matched.')
  process.exit(0)
}

// A Mac that goes to sleep mid-run (idle, on battery) stalls every timer and
// leaves scenarios "timing out" after an hour of wall clock. Held awake for as
// long as this process lives; the lid being closed still sleeps it, which the
// scenarios report when it happens.
if (process.platform === 'darwin') {
  try {
    spawn('caffeinate', ['-dim', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref()
  } catch {
    /* no caffeinate: the run still works */
  }
}

if (timeoutScale > 1) {
  console.log(`Load average ${loadavg()[0].toFixed(0)} on ${cpus().length} cores: every timeout is stretched ${timeoutScale}x.`)
}

let status = 0
for (let run = 1; run <= repeat; run++) {
  if (repeat > 1) console.log(`\n=== Run ${run} of ${repeat} ===`)
  // One app at a time: windows compete for focus and the machine's cores,
  // and timing-sensitive checks (a stream held open in two windows) are only
  // meaningful without other apps starting beside them.
  // Repeated runs keep their own screenshots and logs, so a failure in the
  // second is not overwritten by the third.
  const base = process.env.EAON_E2E_ARTIFACTS ?? join(root, 'out', 'e2e')
  const env = repeat > 1 ? { ...process.env, EAON_E2E_ARTIFACTS: join(base, `run-${run}`), EAON_E2E_SCREENS: '' } : process.env
  if (repeat > 1) delete env.EAON_E2E_SCREENS
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], {
    cwd: root,
    stdio: 'inherit',
    env
  })
  if (result.status !== 0) status = result.status ?? 1
}
process.exit(status)
