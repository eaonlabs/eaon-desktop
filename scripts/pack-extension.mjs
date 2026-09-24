#!/usr/bin/env node
/**
 * Packs extension/ into dist/eaon-browser-extension-<version>.zip, ready to
 * upload to the Chrome Web Store developer dashboard.
 *
 *   node scripts/pack-extension.mjs
 *
 * The zip is written by hand with node:zlib rather than by shelling out to
 * `zip`, which Windows does not have, or adding a dependency for forty lines
 * of format. Before packing it checks the things the store rejects an upload
 * for, so a mistake shows up here rather than after a review round-trip.
 */
import { deflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = join(root, 'extension')
const outDir = join(root, 'dist')

/** Kept in the repo for the publisher, not shipped to users. */
const EXCLUDE = new Set(['STORE_LISTING.md', '.DS_Store', 'Thumbs.db'])

function fail(message) {
  console.error(`pack-extension: ${message}`)
  process.exit(1)
}

// ------------------------------------------------------------------ Checks

const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'))
if (manifest.manifest_version !== 3) fail('manifest_version must be 3.')
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version ?? '')) fail(`"${manifest.version}" is not a valid extension version (1–4 dot-separated integers).`)
if (manifest.key) fail('Remove "key" from manifest.json; the Web Store assigns the key itself.')
if ((manifest.name ?? '').length > 75) fail('The name is longer than the store allows (75 characters).')
if ((manifest.description ?? '').length > 132) fail(`The description is ${manifest.description.length} characters; the store allows 132.`)
for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  if (!existsSync(join(source, path))) fail(`Icon ${size} (${path}) is missing.`)
}
if (!manifest.icons?.['128']) fail('The store requires a 128×128 icon.')

// ------------------------------------------------------------------- Files

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (EXCLUDE.has(name) || name.startsWith('.')) return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const files = walk(source).sort()
for (const file of files) {
  const text = file.endsWith('.js') ? readFileSync(file, 'utf8') : ''
  // Remote code is banned in MV3 and is the most common rejection reason.
  if (/\beval\(|new Function\(|importScripts\(\s*['"]https?:/.test(text)) fail(`${relative(source, file)} appears to evaluate code at runtime.`)
}

// --------------------------------------------------------------------- Zip

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS date and time, which is what zip headers carry. */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

const locals = []
const centrals = []
let offset = 0
const { time, day } = dosDateTime(new Date())

for (const file of files) {
  // Forward slashes inside the archive, whatever the host OS uses.
  const name = Buffer.from(relative(source, file).split(sep).join('/'), 'utf8')
  const data = readFileSync(file)
  const deflated = deflateRawSync(data, { level: 9 })
  const stored = deflated.length >= data.length
  const body = stored ? data : deflated
  const crc = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6) // UTF-8 names
  local.writeUInt16LE(stored ? 0 : 8, 8)
  local.writeUInt16LE(time, 10)
  local.writeUInt16LE(day, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)
  locals.push(local, name, body)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(stored ? 0 : 8, 10)
  central.writeUInt16LE(time, 12)
  central.writeUInt16LE(day, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(offset, 42)
  centrals.push(central, name)

  offset += local.length + name.length + body.length
}

const centralSize = centrals.reduce((n, b) => n + b.length, 0)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(centralSize, 12)
end.writeUInt32LE(offset, 16)

mkdirSync(outDir, { recursive: true })
const target = join(outDir, `eaon-browser-extension-${manifest.version}.zip`)
const zip = Buffer.concat([...locals, ...centrals, end])
writeFileSync(target, zip)
console.log(`Packed ${files.length} files (${(zip.length / 1024).toFixed(1)} KB) → ${relative(root, target)}`)
