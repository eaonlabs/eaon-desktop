import { copyFile, lstat, mkdir, readdir, readlink, realpath, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { CREDENTIAL_PATHS } from '@shared/commandRisk'

/**
 * Copying files from one worker to another (message_worker, hand_off,
 * post_to_room). A folder is copied file by file so a big transfer reports
 * how far it got and can be stopped, and a stopped or failed copy removes
 * what it had written rather than leaving half a folder behind. Symlinks are
 * copied as links, never followed, so a link can't pull in what lies outside
 * the folder being sent; and credential stores (SSH and cloud keys, the
 * keychain) are never sent at all, the same paths read_file refuses.
 */

export interface TransferProgress {
  bytes: number
  total: number
  files: number
}

/** Why a path may not be sent, or null. Checked on the path as given and on where it really points. */
export async function transferRefusal(source: string): Promise<string | null> {
  const real = await realpath(source).catch(() => source)
  for (const path of [source, real]) {
    if (CREDENTIAL_PATHS.test(path)) return `${source} holds credentials (keys, tokens or the keychain), so it can't be sent to another worker.`
  }
  return null
}

/** Bytes under `path`, without following symlinks; stops counting past `limit`. */
export async function sizeOf(path: string, limit: number): Promise<number> {
  const info = await lstat(path)
  if (!info.isDirectory()) return info.isSymbolicLink() ? 0 : info.size
  let total = 0
  for (const entry of await readdir(path)) {
    total += await sizeOf(join(path, entry), limit)
    if (total > limit) return total
  }
  return total
}

/**
 * Copies `source` to `dest` (which must not exist yet). Calls `onProgress`
 * at most every `everyMs`; aborting `signal` stops it and removes `dest`.
 */
export async function copyTree(
  source: string,
  dest: string,
  options: { signal?: AbortSignal; total: number; onProgress?: (progress: TransferProgress) => void; everyMs?: number }
): Promise<void> {
  const progress: TransferProgress = { bytes: 0, total: options.total, files: 0 }
  let last = 0
  const report = (force = false): void => {
    const now = Date.now()
    if (!options.onProgress || (!force && now - last < (options.everyMs ?? 1000))) return
    last = now
    options.onProgress({ ...progress })
  }
  const walk = async (from: string, to: string): Promise<void> => {
    if (options.signal?.aborted) throw new Error('The transfer was stopped.')
    const info = await lstat(from)
    if (info.isSymbolicLink()) {
      await symlink(await readlink(from), to)
    } else if (info.isDirectory()) {
      await mkdir(to, { recursive: false })
      for (const entry of await readdir(from)) await walk(join(from, entry), join(to, entry))
    } else if (info.isFile()) {
      // COPYFILE_EXCL: never replace a file that is somehow already there.
      await copyFile(from, to, 1)
      progress.bytes += info.size
      progress.files++
      report()
    }
    // Sockets, devices and pipes aren't files anyone means to send; they are left out.
  }
  // Something already there is never touched — not overwritten, and not
  // removed by the clean-up below, which only takes back what this copy made.
  if (await lstat(dest).then(() => true, () => false)) throw Object.assign(new Error(`EEXIST: ${dest} already exists`), { code: 'EEXIST' })
  try {
    await walk(source, dest)
    report(true)
  } catch (error) {
    await rm(dest, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
