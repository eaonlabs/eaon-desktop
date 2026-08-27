import os from 'node:os'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { DownloadedModel, ModelDetail, ModelSearchResult, ModelVariant } from '@shared/types'
import { store } from './store'

/**
 * Browse and download GGUF models from Hugging Face, then hand them to a local
 * Ollama daemon to actually run — Ollama's `/api/create` accepts a `FROM
 * <local-path>` modelfile, which is the standard way to import a raw GGUF file
 * without shelling out to the `ollama` CLI. Ollama always listens on 11434
 * regardless of what the "Ollama" provider's own (OpenAI-compatible) baseUrl
 * has been changed to, so that port is hardcoded here rather than shared with
 * providers.ts.
 */

const HF_API = 'https://huggingface.co'
const OLLAMA_ROOT = 'http://127.0.0.1:11434'

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

function modelsDir(): string {
  const dir = join(app.getPath('userData'), 'models')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

async function registerWithOllama(name: string, ggufPath: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${OLLAMA_ROOT}/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, modelfile: `FROM ${ggufPath}`, stream: false })
    })
  } catch {
    throw new Error('Could not reach Ollama — make sure it is installed and running.')
  }
  if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${(await response.text()).slice(0, 300)}`)
}

export async function downloadModel(
  repoId: string,
  filename: string,
  onProgress: (progress: { receivedBytes: number; totalBytes: number; phase: 'downloading' | 'registering' }) => void
): Promise<DownloadedModel> {
  const url = `${HF_API}/${repoId}/resolve/main/${filename}`
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`)
  const totalBytes = Number(response.headers.get('content-length') ?? 0)

  const dir = join(modelsDir(), repoId.replace('/', '__'))
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, filename)

  let receivedBytes = 0
  const reader = response.body.getReader()
  const out = createWriteStream(dest)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      receivedBytes += value.byteLength
      onProgress({ receivedBytes, totalBytes, phase: 'downloading' })
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  } catch (error) {
    out.destroy()
    await unlink(dest).catch(() => {})
    throw error
  }

  const quant = parseQuant(filename)
  const ollamaName = `${repoName(repoId)}-${quant}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  onProgress({ receivedBytes, totalBytes: totalBytes || receivedBytes, phase: 'registering' })

  let ollamaError: string | null = null
  try {
    await registerWithOllama(ollamaName, dest)
  } catch (error) {
    ollamaError = error instanceof Error ? error.message : String(error)
  }

  const model: DownloadedModel = {
    repoId,
    filename,
    quant,
    sizeBytes: totalBytes || receivedBytes,
    path: dest,
    downloadedAt: Date.now(),
    ollamaName: ollamaError ? null : ollamaName,
    ollamaError
  }
  const existing = store.getDownloadedModels().filter((m) => !(m.repoId === repoId && m.filename === filename))
  store.saveDownloadedModels([...existing, model])
  return model
}

export function getDownloadedModels(): DownloadedModel[] {
  return store.getDownloadedModels()
}

export async function deleteDownloadedModel(repoId: string, filename: string): Promise<void> {
  const models = store.getDownloadedModels()
  const target = models.find((m) => m.repoId === repoId && m.filename === filename)
  if (target) {
    await unlink(target.path).catch(() => {})
    if (target.ollamaName) {
      await fetch(`${OLLAMA_ROOT}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: target.ollamaName })
      }).catch(() => {})
    }
  }
  store.saveDownloadedModels(models.filter((m) => !(m.repoId === repoId && m.filename === filename)))
}
