import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

/**
 * A local file as an HTTP response for the `eaon-file://` scheme (main/index.ts),
 * answering a byte range when one is asked for. A video element asks for
 * ranges to find an MP4's index (at the end of most files that weren't made
 * for streaming, and of every QuickTime screen recording) and to loop; served
 * whole, those failed with "format not supported". Pictures come whole.
 */

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm'
}

const body = (path: string, start?: number, end?: number): ReadableStream =>
  Readable.toWeb(createReadStream(path, start === undefined ? {} : { start, end })) as unknown as ReadableStream

/** `cors`: readable by any page, so a video's frames can be drawn into a canvas and read back (the wallpaper's styles). */
export async function fileResponse(path: string, range: string | null, { cors = false }: { cors?: boolean } = {}): Promise<Response> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return new Response('Not found', { status: 404 })
  const size = info.size
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const open: Record<string, string> = cors ? { 'Access-Control-Allow-Origin': '*' } : {}
  const asked = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (asked && (asked[1] || asked[2])) {
    // "bytes=100-", "bytes=100-199", or the last N bytes as "bytes=-N".
    const start = asked[1] ? Number(asked[1]) : Math.max(0, size - Number(asked[2]))
    const end = asked[1] && asked[2] ? Math.min(Number(asked[2]), size - 1) : size - 1
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    return new Response(body(path, start, end), {
      status: 206,
      headers: { ...open, 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' }
    })
  }
  return new Response(body(path), { status: 200, headers: { ...open, 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
}
