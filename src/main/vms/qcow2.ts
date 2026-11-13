import { open, type FileHandle } from 'node:fs/promises'
import * as zlib from 'node:zlib'

/**
 * Turns a qcow2 disk image (how Ubuntu and Debian publish their cloud images)
 * into a raw one, which is what Apple's Virtualization framework boots. Only
 * the clusters that hold data are written, so the raw file stays sparse: a
 * 3 GB image with 1 GB in use takes 1 GB.
 *
 * It reads what cloud images use — version 2 and 3, zlib or zstd compressed
 * clusters, no backing file, no encryption — and refuses anything else by
 * name rather than writing a disk that won't boot. The format is QEMU's
 * docs/interop/qcow2.txt.
 */

const MAGIC = 0x514649fb
/** Incompatible feature bits that change how the file is read, which this doesn't do. */
const EXTERNAL_DATA = 1n << 2n
const EXTENDED_L2 = 1n << 4n
const OFFSET_MASK = 0x00fffffffffffe00n
const COMPRESSED = 1n << 62n
const ZERO = 1n

export interface Qcow2Info {
  version: number
  clusterBits: number
  virtualSize: number
  compression: 'zlib' | 'zstd'
  l1Size: number
  l1Offset: number
}

export async function readQcow2Header(file: FileHandle): Promise<Qcow2Info> {
  const header = Buffer.alloc(112)
  await file.read(header, 0, header.length, 0)
  if (header.readUInt32BE(0) !== MAGIC) throw new Error('That isn’t a qcow2 disk image.')
  const version = header.readUInt32BE(4)
  if (version !== 2 && version !== 3) throw new Error(`qcow2 version ${version} isn’t supported.`)
  if (header.readBigUInt64BE(8) !== 0n) throw new Error('The disk image depends on another image (a backing file).')
  const clusterBits = header.readUInt32BE(20)
  if (clusterBits < 9 || clusterBits > 21) throw new Error('The disk image is damaged (cluster size).')
  if (header.readUInt32BE(32) !== 0) throw new Error('The disk image is encrypted.')
  let compression: Qcow2Info['compression'] = 'zlib'
  if (version === 3) {
    const incompatible = header.readBigUInt64BE(72)
    if (incompatible & EXTERNAL_DATA) throw new Error('The disk image keeps its data in another file.')
    if (incompatible & EXTENDED_L2) throw new Error('The disk image uses subclusters, which aren’t supported.')
    const length = header.readUInt32BE(100)
    if (length > 104 && header[104] === 1) compression = 'zstd'
  }
  return {
    version,
    clusterBits,
    virtualSize: Number(header.readBigUInt64BE(24)),
    compression,
    l1Size: header.readUInt32BE(36),
    l1Offset: Number(header.readBigUInt64BE(40))
  }
}

function decompress(data: Buffer, kind: Qcow2Info['compression'], size: number): Buffer {
  let out: Buffer
  if (kind === 'zlib') {
    // Raw deflate, and the compressed run ends somewhere inside its last sector: stop at the stream's end.
    out = zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
  } else {
    const zstd = (zlib as unknown as { zstdDecompressSync?: (buffer: Buffer, options?: object) => Buffer }).zstdDecompressSync
    if (!zstd) throw new Error('The disk image is compressed with zstd, which this version of Eaon can’t read.')
    out = zstd(data)
  }
  if (out.length < size) throw new Error('A compressed part of the disk image is damaged.')
  return out.subarray(0, size)
}

const isZero = (buffer: Buffer): boolean => {
  for (let i = 0; i < buffer.length; i += 8) if (buffer.readBigUInt64LE(i) !== 0n) return false
  return true
}

export interface ConvertProgress {
  done: number
  total: number
}

/**
 * Writes `source`'s disk as a raw image at `target`, at least `minSize` bytes
 * long (a VM's disk is usually bigger than the image it starts from; the
 * guest grows its partition to fill it on first boot).
 */
export async function qcow2ToRaw(source: string, target: string, options: { minSize?: number; onProgress?: (p: ConvertProgress) => void; signal?: AbortSignal } = {}): Promise<Qcow2Info> {
  const input = await open(source, 'r')
  try {
    const info = await readQcow2Header(input)
    const clusterSize = 1 << info.clusterBits
    const perL2 = clusterSize / 8
    const l1 = Buffer.alloc(info.l1Size * 8)
    await input.read(l1, 0, l1.length, info.l1Offset)
    const { size: fileSize } = await input.stat()

    const output = await open(target, 'w')
    try {
      await output.truncate(Math.max(info.virtualSize, options.minSize ?? 0))
      const l2 = Buffer.alloc(clusterSize)
      const cluster = Buffer.alloc(clusterSize)
      // A compressed cluster spans at most a cluster plus a sector of the file.
      const packed = Buffer.alloc(clusterSize + 1024)
      const total = info.l1Size
      for (let i = 0; i < info.l1Size; i++) {
        if (options.signal?.aborted) throw new Error('Stopped.')
        const l2Offset = Number(l1.readBigUInt64BE(i * 8) & OFFSET_MASK)
        if (l2Offset !== 0) {
          await input.read(l2, 0, clusterSize, l2Offset)
          for (let j = 0; j < perL2; j++) {
            const entry = l2.readBigUInt64BE(j * 8)
            const at = (i * perL2 + j) * clusterSize
            if (at >= info.virtualSize) break
            if (entry === 0n) continue
            let data: Buffer
            if (entry & COMPRESSED) {
              const offsetBits = BigInt(62 - (info.clusterBits - 8))
              const host = Number(entry & ((1n << offsetBits) - 1n))
              const sectors = Number((entry >> offsetBits) & ((1n << (62n - offsetBits)) - 1n))
              const length = Math.min((sectors + 1) * 512 - (host & 511), packed.length, fileSize - host)
              const { bytesRead } = await input.read(packed, 0, length, host)
              data = decompress(packed.subarray(0, bytesRead), info.compression, clusterSize)
            } else {
              if (entry & ZERO) continue
              const host = Number(entry & OFFSET_MASK)
              if (host === 0) continue
              await input.read(cluster, 0, clusterSize, host)
              data = cluster
            }
            if (isZero(data)) continue
            const length = Math.min(clusterSize, info.virtualSize - at)
            await output.write(data, 0, length, at)
          }
        }
        options.onProgress?.({ done: i + 1, total })
      }
    } finally {
      await output.close()
    }
    return info
  } finally {
    await input.close()
  }
}
