#!/usr/bin/env node
/**
 * Fetches Cua Driver (github.com/trycua/cua, MIT), the computer-use engine
 * Eaon embeds, into resources/cua-driver/<target>/ for electron-builder to
 * ship (main/features/computer/cua.ts runs it from there).
 *
 * The version and every archive's SHA-256 are pinned here: a release is only
 * taken after it has been tried, and a download that doesn't match is refused.
 * To move to a newer release, update VERSION and the hashes from that
 * release's SHA256SUMS, then test computer use on each platform.
 *
 *   node scripts/fetch-cua-driver.mjs             this computer's platform
 *   node scripts/fetch-cua-driver.mjs --all       every platform Eaon ships
 *   node scripts/fetch-cua-driver.mjs linux-x64   one target
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.34.0'
const TAG = `cua-driver-rs-v${VERSION}`

/** Eaon's target → the release archive and its SHA-256 (from the release's SHA256SUMS). */
const TARGETS = {
  // One universal binary serves both Mac architectures.
  darwin: { file: `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`, sha256: '940dc008e0f7c5d217d14c0f247d1ebab91b1bac965f4a649d19e8c789bdfd81' },
  'linux-x64': { file: `cua-driver-rs-${VERSION}-linux-x86_64-binary.tar.gz`, sha256: '629ac96eff829d4dfd5cf221f3f2165c2d813aed91e5efb7b20777a741cd70a7' },
  'linux-arm64': { file: `cua-driver-rs-${VERSION}-linux-arm64-binary.tar.gz`, sha256: '9db8b9084add57eb97be8164367b24b6be54ed4f3dc01213e64b72d7fc09fddb' },
  'win32-x64': { file: `cua-driver-rs-${VERSION}-windows-x86_64-binary.zip`, sha256: 'bcc520e50861c7092cf775846fec76ae386d7dcd6b5b408608b0ea4423a8b888' },
  'win32-arm64': { file: `cua-driver-rs-${VERSION}-windows-arm64-binary.zip`, sha256: 'df5786c6e7841d2f0d88f31c627c487181463ed99614b03efc0e907acfc698c3' }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'resources', 'cua-driver')

function here() {
  if (process.platform === 'darwin') return 'darwin'
  return `${process.platform}-${process.arch}`
}

async function fetchTarget(target) {
  const spec = TARGETS[target]
  if (!spec) throw new Error(`cua-driver: no build for ${target} (have: ${Object.keys(TARGETS).join(', ')})`)
  const exe = target.startsWith('win32') ? 'cua-driver.exe' : 'cua-driver'
  const dest = join(out, target)
  const stamp = join(dest, 'VERSION')
  if (existsSync(join(dest, exe)) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === VERSION) {
    console.log(`cua-driver ${VERSION} ${target}: already here`)
    return
  }
  const url = `https://github.com/trycua/cua/releases/download/${TAG}/${spec.file}`
  console.log(`cua-driver ${VERSION} ${target}: downloading ${spec.file}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`cua-driver: ${url} answered ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== spec.sha256) throw new Error(`cua-driver: ${spec.file} has SHA-256 ${got}, expected ${spec.sha256}. Not using it.`)

  const work = join(tmpdir(), `eaon-cua-${process.pid}-${target}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const archive = join(work, spec.file)
  writeFileSync(archive, bytes)
  if (spec.file.endsWith('.zip')) execFileSync(process.platform === 'win32' ? 'tar' : 'unzip', process.platform === 'win32' ? ['-xf', archive, '-C', work] : ['-q', archive, '-d', work])
  else execFileSync('tar', ['-xzf', archive, '-C', work])
  const found = findFile(work, exe)
  if (!found) throw new Error(`cua-driver: ${exe} isn't in ${spec.file}`)

  // Only the driver itself: the SDK library, Node addon and headers in the archive are for other embedders.
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  // Copied, not renamed: the temp folder can be on another drive (it is on GitHub's Windows machines).
  copyFileSync(found, join(dest, exe))
  if (!exe.endsWith('.exe')) chmodSync(join(dest, exe), 0o755)
  writeFileSync(stamp, `${VERSION}\n`)
  rmSync(work, { recursive: true, force: true })
  console.log(`cua-driver ${VERSION} ${target}: ${join('resources', 'cua-driver', target, exe)}`)
}

function findFile(dir, name) {
  for (const entry of execFileSync(process.platform === 'win32' ? 'cmd' : 'find', process.platform === 'win32' ? ['/c', 'dir', '/s', '/b', dir] : [dir, '-type', 'f'], { encoding: 'utf8' }).split(/\r?\n/)) {
    if (entry.endsWith(`/${name}`) || entry.endsWith(`\\${name}`)) return entry
  }
  return null
}

const args = process.argv.slice(2)
const targets = args.includes('--all') ? Object.keys(TARGETS) : args.length ? args : [here()]
for (const target of targets) await fetchTarget(target)
