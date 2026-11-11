import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'

/**
 * Downloads for VMs: OS images (hundreds of MB) and macOS restore images
 * (about 18 GB), on home connections that drop. A download goes to
 * `<file>.part` and carries on from where it stopped, and an image counts as
 * downloaded only once its checksum matches the one its publisher lists.
 */

export interface DownloadProgress {
  received: number
  total: number | null
}

export async function download(url: string, file: string, options: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {}): Promise<void> {
  const part = `${file}.part`
  let have = existsSync(part) ? statSync(part).size : 0
  const response = await fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal: options.signal, redirect: 'follow' })
  if (response.status === 416) {
    // Already all here.
    await rename(part, file)
    return
  }
  if (!response.ok) throw new Error(`The download failed (HTTP ${response.status}) from ${new URL(url).host}.`)
  if (have > 0 && response.status !== 206) have = 0
  const length = Number(response.headers.get('content-length') ?? '')
  const total = Number.isFinite(length) && length > 0 ? have + length : null
  const handle = await open(part, have > 0 ? 'a' : 'w')
  try {
    let received = have
    let last = 0
    const reader = response.body?.getReader()
    if (!reader) throw new Error('The download came back empty.')
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await handle.write(value)
      received += value.length
      const now = Date.now()
      if (now - last > 250) {
        last = now
        options.onProgress?.({ received, total })
      }
    }
    options.onProgress?.({ received, total })
    if (total !== null && received < total) throw new Error('The download stopped part way; it will carry on from there next time.')
  } finally {
    await handle.close()
  }
  await rename(part, file)
}

export function hashFile(file: string, algorithm: 'sha256' | 'sha512', onProgress?: (done: number, total: number) => void): Promise<string> {
  const total = statSync(file).size
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm)
    let done = 0
    createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      .on('data', (chunk) => {
        hash.update(chunk)
        done += chunk.length
        onProgress?.(done, total)
      })
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** The checksum a SHA256SUMS / SHA512SUMS file lists for `name` ("<hash>  name" or "<hash> *name"). */
export function checksumFor(sums: string, name: string): string | null {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64,128})\s+\*?(.+)$/i.exec(line.trim())
    if (match && match[2].trim() === name) return match[1].toLowerCase()
  }
  return null
}

/**
 * Makes sure `file` holds `url`'s image, checked against the publisher's
 * checksums: a file already there and matching is kept, one that doesn't
 * match is downloaded again once.
 */
export async function fetchVerified(
  url: string,
  file: string,
  sums: { url: string; algorithm: 'sha256' | 'sha512' },
  options: { onProgress?: (step: string, fraction: number | null) => void; signal?: AbortSignal } = {}
): Promise<void> {
  const name = new URL(url).pathname.split('/').pop() ?? ''
  const list = await fetch(sums.url, { signal: options.signal })
  if (!list.ok) throw new Error(`The image’s checksums couldn’t be read (HTTP ${list.status}).`)
  const expected = checksumFor(await list.text(), name)
  if (!expected) throw new Error(`The publisher doesn’t list a checksum for ${name}.`)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!existsSync(file)) {
      await download(url, file, { signal: options.signal, onProgress: (p) => options.onProgress?.('Downloading', p.total ? p.received / p.total : null) })
    }
    options.onProgress?.('Checking the download', 0)
    const actual = await hashFile(file, sums.algorithm, (done, total) => options.onProgress?.('Checking the download', done / total))
    if (actual === expected) return
    await rm(file, { force: true })
  }
  throw new Error(`${name} didn’t match its published checksum twice, so it wasn’t used.`)
}
