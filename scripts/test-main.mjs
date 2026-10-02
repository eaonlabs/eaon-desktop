#!/usr/bin/env node
/**
 * Runs the main-process tests under plain Node.
 *
 * Each test/*.test.ts is bundled with esbuild — `electron` aliased to a small
 * stub, `@shared` to src/shared — and run with node --test. Bundling rather
 * than a TS loader keeps the imports identical to what electron-vite builds.
 *
 *   npm run test:main            all tests
 *   npm run test:main -- agent   only files whose name contains "agent"
 */
import { build } from 'esbuild'
import { readdirSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const filter = process.argv[2] ?? ''
const files = readdirSync(join(root, 'test'))
  .filter((f) => f.endsWith('.test.ts') && f.includes(filter))
  .map((f) => join(root, 'test', f))
if (files.length === 0) {
  console.log('No tests matched.')
  process.exit(0)
}

// EAON_TEST_OUT (a folder name under out/) lets a quick run go elsewhere while a
// long live run still uses out/test. It stays inside the repo so node_modules resolves.
const out = join(root, 'out', process.env.EAON_TEST_OUT || 'test')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  entryPoints: files,
  outdir: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  alias: {
    electron: join(root, 'test/stubs/electron.ts'),
    '@shared': join(root, 'src/shared')
  },
  // Real dependencies load from node_modules as they do in the app.
  packages: 'external',
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning'
})

const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...readdirSync(out).filter((f) => f.endsWith('.mjs')).map((f) => join(out, f))], {
  stdio: 'inherit',
  env: { ...process.env }
})
process.exit(result.status ?? 1)
