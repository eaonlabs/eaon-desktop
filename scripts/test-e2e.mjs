#!/usr/bin/env node
/**
 * Runs the end-to-end suite: the built app, driven over DevTools, against a
 * fake model server (test/e2e). Each scenario is a node:test test.
 *
 *   npm run test:e2e                 build if needed, then every scenario
 *   npm run test:e2e -- chat         only files whose name contains "chat"
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
 *
 * On Linux it needs a display; CI runs it under `xvfb-run`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const noBuild = args.includes('--no-build')
const repeatAt = args.indexOf('--repeat')
const repeat = repeatAt === -1 ? 1 : Math.max(1, Number(args[repeatAt + 1]) || 1)
const filter = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--repeat')[0] ?? ''

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
  .filter((f) => f.endsWith('.e2e.mjs') && f.includes(filter))
  .sort()
  .map((f) => join(dir, f))
if (files.length === 0) {
  console.log('No scenarios matched.')
  process.exit(0)
}

let status = 0
for (let run = 1; run <= repeat; run++) {
  if (repeat > 1) console.log(`\n=== Run ${run} of ${repeat} ===`)
  // One app at a time: windows compete for focus and the machine's cores,
  // and timing-sensitive checks (a stream held open in two windows) are only
  // meaningful without other apps starting beside them.
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  })
  if (result.status !== 0) status = result.status ?? 1
}
process.exit(status)
