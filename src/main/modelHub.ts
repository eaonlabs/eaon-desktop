import os from 'node:os'
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { rename, statfs, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { app } from 'electron'
import { diskShortfall } from '@shared/modelLibrary'
import type { DownloadedModel, ModelDetail, ModelSearchResult, ModelVariant } from '@shared/types'
import { store } from './store'
import { checkHfFile } from './ipcGuards'

/**
 * Browse Hugging Face for GGUF models and download them into Eaon's models
 * folder, where Eaon's own llama.cpp runs them (`main/llama/`). Also home to
 * the file fetcher the curated library uses for its variants.
 */

const HF_API = 'https://huggingface.co'

const QUANT_RE = /((?:IQ|Q)\d[\w-]*|F16|F32|BF16)/i

function parseQuant(filename: string): string {
  const match = filename.match(QUANT_RE)
  return match ? match[1].toUpperCase() : 'GGUF'
}

/** A file "fits" if it comfortably sits under the machine's total memory — the
 * same rough heuristic tools like LM Studio and Jan use rather than trying to
 * model exact GPU/CPU memory behavior per quantization. */
function fitsMemory(sizeBytes: number): boolean {
  return sizeBytes > 0 && sizeBytes < os.totalmem() * 0.8
}

interface HfSearchItem {
  id: string
  author?: string
  downloads?: number
  tags?: string[]
  pipeline_tag?: string
  siblings?: { rfilename: string }[]
}

interface HfTreeEntry {
  path: string
  size?: number
}

async function hfJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Hugging Face returned ${response.status}`)
  return (await response.json()) as T
}

function repoName(repoId: string): string {
  return repoId.includes('/') ? repoId.slice(repoId.indexOf('/') + 1) : repoId
}

function capabilitiesOf(item: HfSearchItem): ('tools' | 'multimodal')[] {
  const tags = (item.tags ?? []).map((t) => t.toLowerCase())
  const caps: ('tools' | 'multimodal')[] = []
  if (tags.some((t) => t.includes('tool') || t.includes('function-calling') || t.includes('agent'))) caps.push('tools')
  if (item.pipeline_tag === 'image-text-to-text' || tags.some((t) => t.includes('vision') || t.includes('multimodal') || t.includes('-vl'))) {
    caps.push('multimodal')
  }
  return caps
}

/** Best-effort per-repo file sizes; used to price the one variant a search card shows. */
async function treeSizes(repoId: string): Promise<Map<string, number>> {
  try {
    const tree = await hfJson<HfTreeEntry[]>(`${HF_API}/api/models/${repoId}/tree/main`)
    return new Map(tree.filter((f) => f.size !== undefined).map((f) => [f.path, f.size as number]))
  } catch {
    return new Map()
  }
}

/**
 * Hugging Face doesn't return a curated one-line description for most repos —
 * that's Jan's own hand-written catalog copy, which we have no access to. Best
 * effort here: pull the first substantial prose line out of the real README
 * after stripping frontmatter, headings, and badge/image lines.
 */
async function fetchDescription(repoId: string): Promise<string> {
  try {
    const response = await fetch(`${HF_API}/${repoId}/raw/main/README.md`)
    if (!response.ok) return ''
    const text = await response.text()
    const body = text.replace(/^---[\s\S]*?---\s*/, '')
    for (const raw of body.split('\n')) {
      const line = raw.trim()
      if (!line || line.length < 40) continue
      if (/^(#|>|\[!\[|!\[|\||```)/.test(line)) continue
      return line
        .replace(/\*\*/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .slice(0, 240)
    }
    return ''
  } catch {
    return ''
  }
}

export async function searchModels(query: string, sort: 'downloads' | 'newest'): Promise<ModelSearchResult[]> {
  const params = new URLSearchParams({
    filter: 'gguf',
    sort: sort === 'newest' ? 'createdAt' : 'downloads',
    direction: '-1',
    limit: '30',
    // `siblings` (the file listing each card needs to price a default variant)
    // is only included in the response when `full` is set — without it every
    // card silently has no size, no Fits badge, and no file count.
    full: 'true'
  })
  if (query.trim()) params.set('search', query.trim())
  const items = await hfJson<HfSearchItem[]>(`${HF_API}/api/models?${params}`)

  // Bounded concurrency so a 30-item page doesn't fire 30 simultaneous tree
  // lookups at once, but still resolves in parallel rather than one at a time.
  const queue = [...items]
  const results: ModelSearchResult[] = []
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const item = queue.shift()
        if (!item) return
        const files = (item.siblings ?? []).map((s) => s.rfilename).filter((f) => f.toLowerCase().endsWith('.gguf'))
        let defaultVariant: ModelVariant | null = null
        if (files.length > 0) {
          const sizes = await treeSizes(item.id)
          const preferred = files.find((f) => /q4_k_m/i.test(f)) ?? files[0]
          const sizeBytes = sizes.get(preferred) ?? 0
          defaultVariant = { filename: preferred, quant: parseQuant(preferred), sizeBytes, fits: fitsMemory(sizeBytes) }
        }
        results.push({
          repoId: item.id,
          name: repoName(item.id),
          author: item.author ?? item.id.split('/')[0],
          downloads: item.downloads ?? 0,
          description: '',
          tags: item.tags ?? [],
          capabilities: capabilitiesOf(item),
          fileCount: files.length,
          defaultVariant
        })
      }
    })
  )

  // The concurrent workers finish out of order; restore Hugging Face's ranking.
  const order = new Map(items.map((item, i) => [item.id, i]))
  results.sort((a, b) => (order.get(a.repoId) ?? 0) - (order.get(b.repoId) ?? 0))
  return results
}

export async function getModelDetail(repoId: string): Promise<ModelDetail> {
  const [info, tree, description] = await Promise.all([
    hfJson<HfSearchItem>(`${HF_API}/api/models/${repoId}`),
    hfJson<HfTreeEntry[]>(`${HF_API}/api/models/${repoId}/tree/main`),
    fetchDescription(repoId)
  ])

  const variants: ModelVariant[] = tree
    .filter((f) => f.path.toLowerCase().endsWith('.gguf') && f.size)
    .map((f) => ({ filename: f.path, quant: parseQuant(f.path), sizeBytes: f.size as number, fits: fitsMemory(f.size as number) }))
    .sort((a, b) => a.sizeBytes - b.sizeBytes)

  const paramMatch = repoId.match(/(\d+(?:\.\d+)?)\s*b\b/i)

  return {
    repoId,
    name: repoName(repoId),
    author: info.author ?? repoId.split('/')[0],
    downloads: info.downloads ?? 0,
    description,
    parameterSize: paramMatch ? `${paramMatch[1]}b` : null,
    variants
  }
}

export function modelsDir(): string {
  const dir = join(app.getPath('userData'), 'models')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

type DownloadProgress = { receivedBytes: number; totalBytes: number; phase: 'downloading' | 'registering' }

/**
 * Downloads in flight, by destination file: a second click on the same file
 * joins the first instead of writing it twice at once, and quitting can stop
 * them and remove their partial files.
 */
const downloads = new Map<string, { controller: AbortController; part: string; promise: Promise<DownloadedModel> }>()

export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir)
    return info.bavail * info.bsize
  } catch {
    return null
  }
}

/**
 * Where a repo's file lands: `<models>/<owner>__<repo>/<file>` (subfolders
 * kept). Both come from the renderer, so they are checked first: a `..` in
 * the file name or a `?` in the repo id must never place a download (or a
 * later delete) outside that folder.
 */
export function localPathFor(repoId: string, filename: string): string {
  return checkHfFile(repoId, filename, modelsDir()).dest
}

/**
 * Streams one file of a Hugging Face repo to `dest`. Written under `.part`
 * and renamed when complete, so an interrupted download never passes for the
 * finished file; `pipeline` handles backpressure, and a write error (a full
 * disk) or an abort rejects here and closes both ends. `onBytes` gets the
 * running total, at most a few times a second.
 */
export async function fetchHfFile(
  repoId: string,
  filename: string,
  dest: string,
  signal: AbortSignal,
  onBytes: (received: number, total: number) => void
): Promise<number> {
  checkHfFile(repoId, filename, modelsDir())
  const part = `${dest}.part`
  const url = `${HF_API}/${repoId}/resolve/main/${filename.split('/').map(encodeURIComponent).join('/')}`
  let received = 0
  try {
    const response = await fetch(url, { signal })
    if (!response.ok || !response.body) throw new Error(`Download of ${filename} failed: ${response.status}`)
    const total = Number(response.headers.get('content-length') ?? 0)
    mkdirSync(dirname(dest), { recursive: true })
    let lastReport = 0
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          received += chunk.byteLength
          const now = Date.now()
          if (now - lastReport > 150) {
            lastReport = now
            onBytes(received, total)
          }
          yield chunk
        }
      },
      createWriteStream(part),
      { signal }
    )
    await rename(part, dest)
    onBytes(received, total || received)
    return received
  } catch (error) {
    await unlink(part).catch(() => {})
    if (signal.aborted) throw new Error('Download cancelled')
    throw error
  }
}

export function downloadModel(
  repoId: string,
  filename: string,
  onProgress: (progress: DownloadProgress) => void
): Promise<DownloadedModel> {
  const dest = localPathFor(repoId, filename)
  const running = downloads.get(dest)
  if (running) return running.promise
  const controller = new AbortController()
  const part = `${dest}.part`
  const promise = fetchModelFile(repoId, filename, dest, controller.signal, onProgress).finally(() => downloads.delete(dest))
  downloads.set(dest, { controller, part, promise })
  return promise
}

/**
 * Called on quit. The partial file goes synchronously: the process may be gone
 * before an async unlink runs, and a leftover would sit in the models folder,
 * gigabytes large and listed nowhere.
 */
export function cancelAllDownloads(): void {
  for (const { controller, part } of downloads.values()) {
    controller.abort()
    try {
      rmSync(part, { force: true })
    } catch {
      /* still open on Windows; the next download of this file overwrites it */
    }
  }
}

/** "Browse Hugging Face": one GGUF file, run by Eaon's own llama.cpp once it lands. */
async function fetchModelFile(
  repoId: string,
  filename: string,
  dest: string,
  signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void
): Promise<DownloadedModel> {
  // A file that fills the disk fails late and leaves the system short of space.
  const head = await fetch(`${HF_API}/${repoId}/resolve/main/${filename.split('/').map(encodeURIComponent).join('/')}`, { method: 'HEAD', redirect: 'follow', signal }).catch(() => null)
  const expected = Number(head?.headers.get('content-length') ?? 0)
  const shortfall = expected > 0 ? diskShortfall(expected, await freeBytes(modelsDir())) : null
  if (shortfall) throw new Error(shortfall)

  const sizeBytes = await fetchHfFile(repoId, filename, dest, signal, (receivedBytes, totalBytes) =>
    onProgress({ receivedBytes, totalBytes, phase: 'downloading' })
  )
  const quant = parseQuant(filename)
  const model: DownloadedModel = {
    repoId,
    filename,
    quant,
    sizeBytes,
    path: dest,
    downloadedAt: Date.now(),
    label: `${repoName(repoId).replace(/-gguf$/i, '')} · ${quant}`
  }
  const existing = store.getDownloadedModels().filter((m) => !(m.repoId === repoId && m.filename === filename))
  store.saveDownloadedModels([...existing, model])
  return model
}

export function getDownloadedModels(): DownloadedModel[] {
  return store.getDownloadedModels()
}

/** Deletes a downloaded model's files (its projector too) and forgets it. */
export async function deleteDownloadedModel(repoId: string, filename: string): Promise<void> {
  const models = store.getDownloadedModels()
  const target = models.find((m) => m.repoId === repoId && m.filename === filename)
  if (target) {
    await unlink(target.path).catch(() => {})
    // Split models: the other shards sit next to the first.
    const shard = /-00001-of-(\d{5})\.gguf$/.exec(target.path)
    if (shard) {
      for (let i = 2; i <= Number(shard[1]); i++) {
        await unlink(target.path.replace(/-00001-of-/, `-${String(i).padStart(5, '0')}-of-`)).catch(() => {})
      }
    }
    // A projector shared by another variant of the same repo stays.
    const sharedProjector = models.some((m) => m !== target && m.mmprojPath === target.mmprojPath)
    if (target.mmprojPath && !sharedProjector) await unlink(target.mmprojPath).catch(() => {})
  }
  store.saveDownloadedModels(models.filter((m) => !(m.repoId === repoId && m.filename === filename)))
}
