/**
 * The curated local-model library, shared by the main process (which owns the
 * catalog and talks to Ollama) and the Models page. The sizing logic lives here
 * rather than in either process so it can be unit-tested under plain Node and
 * so the badge a card shows is computed by exactly the code the tests cover.
 *
 * See .eaonbrain/local-model-hub.md for how this fits the rest of the page.
 */

export type LibraryCategory = 'general' | 'coding' | 'reasoning' | 'vision' | 'small' | 'embedding'

export const LIBRARY_CATEGORIES: { id: LibraryCategory; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'coding', label: 'Coding' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'vision', label: 'Vision' },
  { id: 'small', label: 'Small & fast' },
  { id: 'embedding', label: 'Embeddings' }
]

export type LibraryCapability = 'tools' | 'vision' | 'reasoning' | 'coding' | 'embedding'

/**
 * Where a variant is pulled from. Both kinds go through Ollama's `/api/pull`:
 * library tags from registry.ollama.ai, and Hugging Face GGUF repos through
 * Ollama's `hf.co/<repo>:<quant>` integration, which resolves the quant to a
 * file in the repo and brings the chat template and any vision projector with
 * it. That keeps one download path, one progress stream and one copy on disk.
 */
export type VariantSource =
  | {
      kind: 'ollama'
      /** Full library tag, e.g. `qwen3.8:27b`. */
      tag: string
      /** First 12 hex chars of the manifest's sha256 — the ID `ollama list` shows. */
      digest: string
    }
  | {
      kind: 'hf'
      /** GGUF repo on Hugging Face, e.g. `openbmb/MiniCPM5-2B-GGUF`. */
      repo: string
      /** Quant tag Ollama resolves against the repo's files, e.g. `Q4_K_M`. */
      quant: string
      /** The repo files that quant pulls (model, plus mmproj for vision models). */
      files: string[]
    }

export interface LibraryVariant {
  /** Stable within its model, e.g. `q4_k_m`. */
  id: string
  /** Shown to the user, e.g. `Q4_K_M` or `QAT Q4`. */
  quant: string
  /** Total download: every layer of the pull, vision projector included. */
  sizeBytes: number
  source: VariantSource
}

export interface LibraryModel {
  id: string
  name: string
  org: string
  family: string
  /** Display parameter count, e.g. `27B` or `30B-A3B` for mixture-of-experts. */
  params: string
  /** Total parameters in billions. */
  paramsB: number
  description: string
  categories: LibraryCategory[]
  capabilities: LibraryCapability[]
  /** Native context window in tokens. */
  contextLength: number
  license: { name: string; url?: string }
  /** YYYY-MM-DD, from the official repo's creation date or release note. */
  released: string
  links: { huggingFace?: string; ollama?: string }
  variants: LibraryVariant[]
  /**
   * Curated pick per memory tier, ascending: on a machine with at least
   * `ramGB` of memory, pull `variant`. The first row is the model's minimum.
   */
  recommended: { ramGB: number; variant: string }[]
  /** One of the models the user asked for by name; always shown first. */
  featured?: boolean
  /** Set when the current Ollama cannot load this model. Get stays disabled and this explains why. */
  unsupported?: string
}

export type OllamaStatus =
  | { state: 'running'; version: string }
  /** The binary exists but nothing answers on 11434. */
  | { state: 'stopped'; binary: string }
  | { state: 'missing' }

/** One row of Ollama's `GET /api/tags`. */
export interface InstalledModel {
  name: string
  digest: string
  sizeBytes: number
  modifiedAt: string
  parameterSize?: string
  quantization?: string
  family?: string
  /** As Ollama reports them: `completion`, `tools`, `thinking`, `vision`, `embedding`… */
  capabilities?: string[]
  /** Ollama cloud models are aliases with no local weights. */
  cloud?: boolean
}

export interface LibraryState {
  ramBytes: number
  /** Free space on the disk Ollama stores models on; null when it could not be read. */
  freeDiskBytes: number | null
  chip: string
  ollama: OllamaStatus
  installed: InstalledModel[]
}

const GiB = 1024 ** 3

/* ------------------------------------------------------------------ Fit */

export type FitLevel = 'good' | 'tight' | 'too-big'

export const FIT_LABEL: Record<FitLevel, string> = {
  good: 'Fits well',
  tight: 'Tight',
  'too-big': 'Too big'
}

/**
 * Share of RAM the GPU gets on Apple silicon by default. Metal's working-set
 * limit is roughly 2/3 to 3/4 of unified memory depending on macOS version and
 * RAM size (Ollama 0.30.4 on a 24 GB M5 reports 17.8 GiB). A model inside it
 * runs fully on the GPU; past it Ollama offloads layers to the CPU, which
 * still works but is several times slower.
 */
export const GPU_SHARE = 0.72
/** Past this share of RAM the model competes with macOS and open apps for memory and starts to swap. */
export const TIGHT_SHARE = 0.85

/** Weights plus KV cache for a default-sized context and runtime buffers. */
export function memoryNeeded(sizeBytes: number): number {
  return sizeBytes * 1.1 + 0.75 * GiB
}

/** Room a download needs: the weights plus headroom so the disk is not left completely full. */
export function diskNeeded(sizeBytes: number): number {
  return sizeBytes + 2 * GiB
}

/** Why a download of this size should not start on this disk, or null when it fits. */
export function diskShortfall(sizeBytes: number, freeDiskBytes: number | null): string | null {
  if (freeDiskBytes === null || diskNeeded(sizeBytes) <= freeDiskBytes) return null
  return `Needs ${formatModelSize(diskNeeded(sizeBytes))} free; this disk has ${formatModelSize(freeDiskBytes)}.`
}

export function fitFor(sizeBytes: number, ramBytes: number): FitLevel {
  const need = memoryNeeded(sizeBytes)
  if (need <= ramBytes * GPU_SHARE) return 'good'
  if (need <= ramBytes * TIGHT_SHARE) return 'tight'
  return 'too-big'
}

/**
 * Marketing memory sizes are binary gigabytes, but Windows and Linux report a
 * little less than the installed amount once firmware reservations are taken
 * out — rounding keeps a "16 GB" PC in the 16 GB tier.
 */
export function nominalRamGB(ramBytes: number): number {
  return Math.round(ramBytes / GiB)
}

export function minRamGB(model: LibraryModel): number {
  return model.recommended[0]?.ramGB ?? 0
}

export interface VariantPick {
  variant: LibraryVariant
  fit: FitLevel
  /** The tier the pick came from, or null when this machine is below the model's minimum. */
  tierGB: number | null
}

/**
 * The variant Get pulls on this machine: the curated pick for the largest tier
 * the machine reaches. Below the model's minimum there is no good answer, so
 * it offers the smallest variant and lets the fit badge say so.
 */
export function pickVariant(model: LibraryModel, ramBytes: number): VariantPick {
  const ram = nominalRamGB(ramBytes)
  const tier = [...model.recommended].reverse().find((row) => row.ramGB <= ram)
  const byId = new Map(model.variants.map((v) => [v.id, v]))
  const variant = (tier && byId.get(tier.variant)) || [...model.variants].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]
  return { variant, fit: fitFor(variant.sizeBytes, ramBytes), tierGB: tier ? tier.ramGB : null }
}

const FIT_RANK: Record<FitLevel, number> = { good: 0, tight: 1, 'too-big': 2 }

/**
 * "Suggested for this Mac": the featured models first, whatever their fit —
 * the user asked for them by name and the badge tells the truth — then the
 * newest models that fit well, one per primary category so the row is not
 * five near-identical chat models. Embedding models are left out; they are
 * not something you talk to.
 */
export function suggestFor(models: LibraryModel[], ramBytes: number, limit = 6): LibraryModel[] {
  const featured = models.filter((m) => m.featured)
  const picked = new Set(featured.map((m) => m.id))
  const seenCategory = new Set<LibraryCategory>()
  const rest = models
    .filter((m) => !m.featured && !m.unsupported && !m.categories.includes('embedding'))
    .map((m) => ({ model: m, pick: pickVariant(m, ramBytes) }))
    .filter(({ pick }) => pick.fit === 'good')
    .sort((a, b) => b.model.released.localeCompare(a.model.released) || FIT_RANK[a.pick.fit] - FIT_RANK[b.pick.fit])
  const out = [...featured]
  for (const { model } of rest) {
    if (out.length >= limit) break
    const primary = model.categories[0]
    if (seenCategory.has(primary) || picked.has(model.id)) continue
    seenCategory.add(primary)
    picked.add(model.id)
    out.push(model)
  }
  return out
}

/* --------------------------------------------------------- Ollama naming */

/** The name to pass to `/api/pull` — and the name the model is listed under afterwards. */
export function pullRef(variant: LibraryVariant): string {
  return variant.source.kind === 'ollama' ? variant.source.tag : `hf.co/${variant.source.repo}:${variant.source.quant}`
}

/** Ollama treats a bare name as `:latest` and matches case-insensitively. */
export function normalizeModelName(name: string): string {
  const lower = name.trim().toLowerCase()
  const lastSegment = lower.slice(lower.lastIndexOf('/') + 1)
  return lastSegment.includes(':') ? lower : `${lower}:latest`
}

/**
 * The installed model this variant corresponds to, if any. Library tags also
 * match by digest, so `gemma4:e2b` pulled as `gemma4:e2b-it-q4_K_M` (the same
 * manifest under another tag) still counts as installed.
 */
export function findInstalled(variant: LibraryVariant, installed: InstalledModel[]): InstalledModel | undefined {
  const want = normalizeModelName(pullRef(variant))
  const digest = variant.source.kind === 'ollama' ? variant.source.digest : null
  return installed.find(
    (m) => normalizeModelName(m.name) === want || (digest !== null && m.digest.toLowerCase().startsWith(digest))
  )
}

/** The first of a model's variants that is installed, preferring the one this machine would pick. */
export function findInstalledVariant(
  model: LibraryModel,
  installed: InstalledModel[],
  preferred?: LibraryVariant
): { variant: LibraryVariant; installed: InstalledModel } | undefined {
  const order = preferred ? [preferred, ...model.variants.filter((v) => v !== preferred)] : model.variants
  for (const variant of order) {
    const match = findInstalled(variant, installed)
    if (match) return { variant, installed: match }
  }
  return undefined
}

/**
 * Progress for library pulls rides the same `models:download-progress` channel
 * and `modelDownloads` store map as Hugging Face file downloads, so the header
 * Downloads panel shows both. The panel titles a row with the part of `repoId`
 * after the first slash, hence the `library/` prefix.
 */
export function libraryProgressKey(model: LibraryModel, variant: LibraryVariant): { repoId: string; filename: string } {
  return { repoId: `library/${model.name}`, filename: pullRef(variant) }
}

/* ------------------------------------------------------------ Formatting */

/** Model sizes in decimal gigabytes — the unit Hugging Face and ollama.com both show. */
export function formatModelSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_048_576).toFixed(1)}M`
  if (tokens < 1024) return String(tokens)
  return `${Math.round(tokens / 1024)}K`
}
