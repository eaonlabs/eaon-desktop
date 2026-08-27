import { secrets } from './secrets'
import { store } from './store'
import { getProvider } from './providers'

/**
 * Embeddings for the code index, using whichever key the user already has.
 *
 * Every supported endpoint speaks one of two shapes: OpenAI's `/v1/embeddings`
 * (OpenAI, Gemini's compatible endpoint, most gateways, and Ollama's own
 * compatible route) or Ollama's native `/api/embed`. Anthropic has no
 * embeddings API at all, which is exactly why the index has to stay useful
 * without vectors — see `codeIndex.ts`, which falls back to lexical scoring
 * when `isEmbeddingConfigured()` is false.
 */

/** Models we know the dimensions and wire format of, offered in Settings. */
export const EMBEDDING_MODELS: { providerId: string; modelId: string; label: string; dimensions: number }[] = [
  { providerId: 'openai', modelId: 'text-embedding-3-small', label: 'OpenAI · text-embedding-3-small', dimensions: 1536 },
  { providerId: 'openai', modelId: 'text-embedding-3-large', label: 'OpenAI · text-embedding-3-large', dimensions: 3072 },
  { providerId: 'gemini', modelId: 'text-embedding-004', label: 'Gemini · text-embedding-004', dimensions: 768 },
  { providerId: 'ollama', modelId: 'nomic-embed-text', label: 'Ollama · nomic-embed-text (local)', dimensions: 768 },
  { providerId: 'ollama', modelId: 'mxbai-embed-large', label: 'Ollama · mxbai-embed-large (local)', dimensions: 1024 }
]

/** Ollama always serves its native API here regardless of the provider baseUrl. */
const OLLAMA_ROOT = 'http://127.0.0.1:11434'

/** Requests are batched; OpenAI accepts up to 2048 inputs but smaller batches fail softer. */
const BATCH_SIZE = 96

/** Roughly 8k tokens is the input cap on every model here; clip well under it. */
const MAX_CHARS_PER_INPUT = 24_000

export interface EmbeddingConfig {
  providerId: string
  modelId: string
}

export function getEmbeddingConfig(): EmbeddingConfig | null {
  const { embeddingProviderId, embeddingModelId } = store.getSettings().codeIndex
  if (!embeddingProviderId || !embeddingModelId) return null
  return { providerId: embeddingProviderId, modelId: embeddingModelId }
}

/**
 * True when embeddings can actually be produced right now. A configured remote
 * provider with no key is *not* usable, so the index falls back to lexical
 * rather than failing every search.
 */
export function isEmbeddingConfigured(): boolean {
  const config = getEmbeddingConfig()
  if (!config) return false
  if (config.providerId === 'ollama') return true
  return secrets.has(config.providerId)
}

/** Human-readable reason embeddings are off, for the Settings UI. */
export function describeEmbeddingState(): string {
  const config = getEmbeddingConfig()
  if (!config) return 'No embedding model selected — search uses keyword matching only.'
  if (config.providerId !== 'ollama' && !secrets.has(config.providerId)) {
    return `No API key for ${getProvider(config.providerId)?.name ?? config.providerId} — search uses keyword matching only.`
  }
  return `Semantic search enabled via ${config.modelId}.`
}

async function embedOllama(texts: string[], modelId: string): Promise<number[][]> {
  const response = await fetch(`${OLLAMA_ROOT}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, input: texts })
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Ollama embeddings failed (${response.status}): ${detail.slice(0, 200)}`)
  }
  const body = (await response.json()) as { embeddings?: number[][] }
  if (!body.embeddings) throw new Error('Ollama returned no embeddings — is the model pulled?')
  return body.embeddings
}

async function embedOpenAICompatible(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  const provider = getProvider(config.providerId)
  if (!provider) throw new Error(`Unknown embedding provider "${config.providerId}"`)
  const baseUrl = provider.baseUrl.replace(/\/$/, '')
  if (!baseUrl) throw new Error(`No base URL configured for ${provider.name}`)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = secrets.get(config.providerId)
  if (key) headers.Authorization = `Bearer ${key}`

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.modelId, input: texts })
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${provider.name} embeddings failed (${response.status}): ${detail.slice(0, 200)}`)
  }
  const body = (await response.json()) as { data?: { embedding: number[]; index: number }[] }
  if (!body.data) throw new Error(`${provider.name} returned no embedding data`)
  // The API is documented to preserve input order, but it also returns an
  // explicit index — sort by it rather than trusting position.
  return [...body.data].sort((a, b) => a.index - b.index).map((entry) => entry.embedding)
}

/** Embed one batch, choosing the wire format from the provider. */
async function embedBatch(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  const clipped = texts.map((text) => (text.length > MAX_CHARS_PER_INPUT ? text.slice(0, MAX_CHARS_PER_INPUT) : text))
  return config.providerId === 'ollama'
    ? embedOllama(clipped, config.modelId)
    : embedOpenAICompatible(clipped, config)
}

/**
 * Embed many texts, in batches, reporting progress. Vectors come back
 * L2-normalized so similarity is a plain dot product at query time.
 */
export async function embedAll(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<Float32Array[]> {
  const config = getEmbeddingConfig()
  if (!config) throw new Error('No embedding model configured')

  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    if (signal?.aborted) throw new Error('Indexing cancelled')
    const batch = texts.slice(i, i + BATCH_SIZE)
    const vectors = await embedBatch(batch, config)
    for (const vector of vectors) out.push(normalize(vector))
    onProgress?.(Math.min(i + BATCH_SIZE, texts.length), texts.length)
  }
  return out
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const [vector] = await embedAll([text])
  return vector
}

/** Unit-length so cosine similarity reduces to a dot product. */
export function normalize(vector: number[] | Float32Array): Float32Array {
  const out = new Float32Array(vector.length)
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i]
  const magnitude = Math.sqrt(sum) || 1
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / magnitude
  return out
}

/** Both vectors are already normalized, so this is cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) sum += a[i] * b[i]
  return sum
}
