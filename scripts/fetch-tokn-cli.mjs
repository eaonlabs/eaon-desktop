#!/usr/bin/env node
/**
 * Fetches the tokn command (npm package `toknhq`, github.com/toknlabs/Tokn,
 * GPL-3.0-or-later) into resources/tokn-cli/ for electron-builder to ship.
 * Eaon runs it with its own Node (ELECTRON_RUN_AS_NODE) and puts a `tokn`
 * command on PATH that does the same (main/features/toknCli.ts), so it
 * needs no Node on the computer. It is plain JavaScript with no
 * dependencies: one copy serves every platform.
 *
 * The version and the package's integrity are pinned here: a release is only
 * taken after it has been tried, and a download that doesn't match is
 * refused. To move to a newer release, update VERSION and INTEGRITY from
 * `npm view toknhq@<version> dist.integrity`, then try `tokn` from Eaon.
 *
 *   node scripts/fetch-tokn-cli.mjs
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.1.3'
const INTEGRITY = 'sha512-tQWgFSaIzJAPpcFZijRx23SYwNceym9M53uAY/xeRRjEBKa09yRya+w/ltmL4GYG05hOVXriWfUY6Wqm0mcThg=='

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'resources', 'tokn-cli')

function installedVersion() {
  try {
    return JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

if (installedVersion() === VERSION && existsSync(join(dest, 'dist', 'index.js'))) {
  console.log(`tokn ${VERSION}: already here`)
  process.exit(0)
}

const url = `https://registry.npmjs.org/toknhq/-/toknhq-${VERSION}.tgz`
console.log(`tokn ${VERSION}: downloading ${url}`)
const response = await fetch(url)
if (!response.ok) throw new Error(`tokn: ${url} answered ${response.status}`)
const bytes = Buffer.from(await response.arrayBuffer())
const got = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
if (got !== INTEGRITY) throw new Error(`tokn: toknhq-${VERSION}.tgz has integrity ${got}, expected ${INTEGRITY}. Not using it.`)

const work = join(tmpdir(), `eaon-tokn-${process.pid}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const archive = join(work, 'toknhq.tgz')
writeFileSync(archive, bytes)
execFileSync('tar', ['-xzf', archive, '-C', work])
const unpacked = join(work, 'package')
if (!existsSync(join(unpacked, 'dist', 'index.js'))) throw new Error('tokn: dist/index.js isn’t in the package')

rmSync(dest, { recursive: true, force: true })
// Copied, not renamed: the temp folder can be on another drive (it is on GitHub's Windows machines).
cpSync(unpacked, dest, { recursive: true })
rmSync(work, { recursive: true, force: true })
console.log(`tokn ${VERSION}: ${join('resources', 'tokn-cli')}`)
