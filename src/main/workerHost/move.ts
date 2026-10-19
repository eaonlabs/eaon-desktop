import { createReadStream, existsSync, lstatSync, readdirSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/**
 * Workers moving between computers: everything that makes a worker itself —
 * the list (`workers.json`), each one's thread, the group chats — as one
 * snapshot, plus the files in each worker's folder, sent in chunks.
 *
 * A worker's folder is where it works, so it moves too, to a folder of the
 * same name under the other computer's Eaon folder. Paths inside the snapshot
 * that pointed into the old folder (its own folder, job logs, watches,
 * mentions in its thread) are rewritten to the new one, so the worker picks up
 * where it left off.
 */

export const WORKERS_FILE = 'workers.json'
export const ROOMS_FILE = 'worker-rooms.json'
export const threadFile = (id: string): string => `worker-${id}.json`

export interface WorkersSnapshot {
  workers: unknown[]
  threads: Record<string, unknown>
  rooms: unknown | null
}

interface StoreLike {
  getJson<T>(name: string, fallback: T): T
  setJson(name: string, value: unknown): void
}

const idOf = (worker: unknown): string | null => {
  const id = (worker as { id?: unknown })?.id
  return typeof id === 'string' && /^[\w-]+$/.test(id) ? id : null
}
const folderOf = (worker: unknown): string => {
  const folder = (worker as { folder?: unknown })?.folder
  return typeof folder === 'string' ? folder : ''
}

export function readSnapshot(store: StoreLike): WorkersSnapshot {
  const raw = store.getJson<unknown>(WORKERS_FILE, [])
  const workers = Array.isArray(raw) ? raw.filter((w) => idOf(w)) : []
  const threads: Record<string, unknown> = {}
  for (const worker of workers) {
    const id = idOf(worker)!
    const thread = store.getJson<unknown>(threadFile(id), null)
    if (thread) threads[id] = thread
  }
  return { workers, threads, rooms: store.getJson<unknown>(ROOMS_FILE, null) }
}

/** Writes a snapshot as the workers' files, replacing what was there. */
export function writeSnapshot(store: StoreLike, snapshot: WorkersSnapshot): void {
  for (const worker of snapshot.workers) {
    const id = idOf(worker)
    if (id && snapshot.threads[id]) store.setJson(threadFile(id), snapshot.threads[id])
  }
  store.setJson(ROOMS_FILE, snapshot.rooms ?? { rooms: [], posts: {}, seen: {} })
  store.setJson(WORKERS_FILE, snapshot.workers)
}

/** Replaces every string that starts with (or mentions) `from` with `to`, anywhere in a JSON value. */
export function rewritePaths<T>(value: T, from: string, to: string): T {
  if (!from || from === to) return value
  const swap = (text: string): string => (text.includes(from) ? text.split(from).join(to) : text)
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return swap(node)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(node)) out[key] = walk(child)
      return out
    }
    return node
  }
  return walk(value) as T
}

export interface Relocation {
  id: string
  from: string
  to: string
}

/**
 * The snapshot as it should be on a computer whose workers' folders live
 * under `root`: each folder moved to `root/<its name>` (or to `keep[id]`,
 * where a worker came from), with every path into it rewritten.
 */
export function relocate(snapshot: WorkersSnapshot, root: string, keep: Record<string, string> = {}, pathSep = sep): { snapshot: WorkersSnapshot; moves: Relocation[] } {
  const moves: Relocation[] = []
  const taken = new Set<string>()
  const workers: unknown[] = []
  const threads: Record<string, unknown> = {}
  let rooms = snapshot.rooms
  for (const worker of snapshot.workers) {
    const id = idOf(worker)!
    const from = folderOf(worker)
    const name = from ? from.split(/[\\/]/).filter(Boolean).pop() ?? id : id
    let to = keep[id] ?? `${root}${pathSep}${name}`
    for (let n = 2; taken.has(to.toLowerCase()); n++) to = `${root}${pathSep}${name}-${n}`
    taken.add(to.toLowerCase())
    moves.push({ id, from, to })
    workers.push(rewritePaths(from ? worker : { ...(worker as object), folder: to }, from, to))
    if (snapshot.threads[id]) threads[id] = rewritePaths(snapshot.threads[id], from, to)
    rooms = rewritePaths(rooms, from, to)
  }
  return { snapshot: { workers, threads, rooms }, moves }
}

/* ------------------------------------------------------------- folders */

export interface FolderEntry {
  /** Relative to the folder, with forward slashes. */
  path: string
  size: number
}

/** Folders a worker's files never need to travel with: they're rebuilt, or huge. */
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', '.cache'])
/** What one worker's folder may carry across; the rest stays behind, and the user is told. */
export const FOLDER_CAP = 512 * 1024 * 1024
export const CHUNK = 512 * 1024

/** The files in a folder worth moving, biggest last, up to `cap` bytes; and how many were left behind. */
export function listFolder(folder: string, cap = FOLDER_CAP): { files: FolderEntry[]; skipped: number } {
  const files: FolderEntry[] = []
  let skipped = 0
  if (!folder || !existsSync(folder)) return { files, skipped }
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      let stat
      try {
        stat = lstatSync(full)
      } catch {
        continue
      }
      // Links could point anywhere on the computer; only the folder's own files go.
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (SKIP.has(name)) skipped++
        else walk(full, depth + 1)
      } else if (stat.isFile()) {
        files.push({ path: relative(folder, full).split(sep).join('/'), size: stat.size })
      }
    }
  }
  walk(folder, 0)
  files.sort((a, b) => a.size - b.size)
  let total = 0
  const kept: FolderEntry[] = []
  for (const file of files) {
    if (total + file.size > cap) {
      skipped++
      continue
    }
    total += file.size
    kept.push(file)
  }
  return { files: kept, skipped }
}

/** Resolves a relative path inside `folder`, refusing anything that climbs out of it. */
export function inside(folder: string, rel: string): string {
  const target = resolve(folder, ...rel.split('/'))
  const base = resolve(folder)
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`${rel} is outside the folder.`)
  return target
}

/** Reads a file in chunks of `CHUNK` bytes. */
export async function* readChunks(path: string): AsyncGenerator<Buffer> {
  const stream = createReadStream(path, { highWaterMark: CHUNK })
  for await (const chunk of stream) yield chunk as Buffer
}

/** Writes one chunk at `offset` (0 starts the file afresh). */
export async function writeChunk(path: string, offset: number, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  if (offset === 0) await rm(path, { force: true })
  const handle = await open(path, offset === 0 ? 'w' : 'r+')
  try {
    await handle.write(data, 0, data.length, offset)
  } finally {
    await handle.close()
  }
}

export const safeName = (name: string): string => basename(name).replace(/[^\w.\- ()]+/g, '_').slice(0, 120) || 'file'
