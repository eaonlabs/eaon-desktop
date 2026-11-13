import { crc32, deflateSync } from 'node:zlib'

/**
 * A PNG from raw RGBA pixels: what a VM's screenshot is sent to a model as.
 * Plain Node (zlib) so it works on a worker computer too, which may have no
 * Electron to encode images with. Written as RGB, since a screen has no
 * transparency, with each row filtered against the one above, which suits
 * screens' large flat areas.
 */

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0)
  return Buffer.concat([head, data, crc])
}

export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  if (rgba.length < width * height * 4) throw new Error('Not enough pixels for that size.')
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  const row = Buffer.alloc(stride)
  const above = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4
      row[x * 3] = rgba[from]
      row[x * 3 + 1] = rgba[from + 1]
      row[x * 3 + 2] = rgba[from + 2]
    }
    const at = y * (stride + 1)
    // Filter 2 (Up): each byte minus the one above it.
    raw[at] = 2
    for (let i = 0; i < stride; i++) raw[at + 1 + i] = (row[i] - above[i]) & 0xff
    row.copy(above)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}
