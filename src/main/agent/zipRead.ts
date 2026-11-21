import { inflateRawSync } from 'node:zlib'

/**
 * Reading entries out of a zip file, for the Office formats (.docx, .xlsx),
 * which are zips of XML.
 *
 * Read-only and in memory: an entry is looked up by its exact name and
 * inflated under a size cap, and nothing is ever written to disk, so a hostile
 * archive can neither escape a folder nor fill one. A zip that says its entry
 * is small and inflates to gigabytes (a zip bomb) stops at the cap. Zip64,
 * encryption and unusual compression are refused rather than guessed at.
 */

export class ZipError extends Error {}

export interface Zip {
  /** Every entry's name. */
  names: string[]
  /** The entry's bytes, or null if there is none by that name. Throws ZipError past `maxBytes`. */
  read(name: string, maxBytes: number): Buffer | null
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** An Office file has dozens of entries; this is far beyond any real one and bounds the directory walk. */
const MAX_ENTRIES = 20_000

interface Entry {
  method: number
  flags: number
  compressed: number
  size: number
  offset: number
}

export function openZip(data: Buffer): Zip {
  if (data.length < 22) throw new ZipError('not a zip file')
  // The end-of-central-directory record is at the very end, before a comment of up to 64 KB.
  let eocd = -1
  for (let at = data.length - 22, stop = Math.max(0, data.length - 22 - 0xffff); at >= stop; at--) {
    if (data.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at
      break
    }
  }
  if (eocd === -1) throw new ZipError('not a zip file')
  const count = data.readUInt16LE(eocd + 10)
  const directoryOffset = data.readUInt32LE(eocd + 16)
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new ZipError('zip64 files are not supported')
  if (count > MAX_ENTRIES) throw new ZipError('too many entries')

  const entries = new Map<string, Entry>()
  let at = directoryOffset
  for (let i = 0; i < count; i++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new ZipError('damaged zip directory')
    const nameLength = data.readUInt16LE(at + 28)
    const extraLength = data.readUInt16LE(at + 30)
    const commentLength = data.readUInt16LE(at + 32)
    if (at + 46 + nameLength > data.length) throw new ZipError('damaged zip directory')
    entries.set(data.toString('utf8', at + 46, at + 46 + nameLength), {
      flags: data.readUInt16LE(at + 8),
      method: data.readUInt16LE(at + 10),
      compressed: data.readUInt32LE(at + 20),
      size: data.readUInt32LE(at + 24),
      offset: data.readUInt32LE(at + 42)
    })
    at += 46 + nameLength + extraLength + commentLength
  }

  return {
    names: [...entries.keys()],
    read(name, maxBytes) {
      const entry = entries.get(name)
      if (!entry) return null
      if (entry.flags & 1) throw new ZipError('the file is encrypted')
      if (entry.size > maxBytes) throw new ZipError(`${name} is too large to read`)
      const local = entry.offset
      if (local + 30 > data.length || data.readUInt32LE(local) !== LOCAL_SIGNATURE) throw new ZipError('damaged zip entry')
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
      const end = start + entry.compressed
      if (end > data.length) throw new ZipError('damaged zip entry')
      const bytes = data.subarray(start, end)
      if (entry.method === 0) {
        if (bytes.length > maxBytes) throw new ZipError(`${name} is too large to read`)
        return bytes
      }
      if (entry.method !== 8) throw new ZipError('unsupported zip compression')
      try {
        // The cap applies to what comes out, whatever the header claimed.
        return inflateRawSync(bytes, { maxOutputLength: maxBytes })
      } catch (error) {
        if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipError(`${name} is too large to read`)
        throw new ZipError('damaged zip entry')
      }
    }
  }
}
