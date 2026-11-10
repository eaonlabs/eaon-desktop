#!/usr/bin/env node
/**
 * Builds the macOS app-control engine (native/app-control/mac/main.swift)
 * into resources/app-control/darwin/eaon-app-control, one universal binary
 * for both Mac architectures, for electron-builder to ship and sign with the
 * app (main/features/appControl/platform.ts runs it from there).
 *
 * Needs the Swift compiler from Xcode or the Command Line Tools. Windows and
 * Linux need nothing built: their engines are scripts in resources/app-control.
 *
 *   node scripts/build-app-control.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('app-control: only the macOS engine is compiled; nothing to do here.')
  process.exit(0)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'native', 'app-control', 'mac', 'main.swift')
const outDir = join(root, 'resources', 'app-control', 'darwin')
const out = join(outDir, 'eaon-app-control')
// The oldest macOS the bundled Electron runs on. Newer Command Line Tools no
// longer carry the x86_64 Swift compatibility libraries that target needs,
// so an architecture that won't link for it is built for macOS 13 instead
// (an Intel Mac still on macOS 12 then reports the engine as unavailable).
const TARGETS = ['12.0', '13.0']

const work = join(tmpdir(), `eaon-app-control-${process.pid}`)
mkdirSync(work, { recursive: true })
mkdirSync(outDir, { recursive: true })
try {
  const slices = []
  for (const arch of ['arm64', 'x86_64']) {
    const slice = join(work, arch)
    let built = null
    for (const target of TARGETS) {
      try {
        execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos${target}`, source, '-o', slice], { stdio: ['ignore', 'ignore', 'pipe'] })
        built = target
        break
      } catch (error) {
        if (target === TARGETS.at(-1)) {
          process.stderr.write(String(error.stderr ?? error))
          throw new Error(`app-control: couldn't build the ${arch} engine`)
        }
      }
    }
    console.log(`app-control: ${arch} for macOS ${built}+`)
    slices.push(slice)
  }
  execFileSync('lipo', ['-create', ...slices, '-output', out], { stdio: 'inherit' })
  execFileSync('chmod', ['755', out])
  console.log(`app-control: built ${out}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
