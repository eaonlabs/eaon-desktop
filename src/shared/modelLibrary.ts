/**
 * The curated local-model library, shared by the main process (which owns the
 * catalog and downloads models for Eaon's llama.cpp) and the Models page. The sizing logic lives here
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
 * Where a variant comes from: GGUF files in a Hugging Face repo — the model,
 * plus a vision projector (mmproj) for models that see images. Eaon downloads
 * them directly and runs them with its own llama.cpp.
 */
export type VariantSource = {
  kind: 'hf'
  /** GGUF repo on Hugging Face, e.g. `openbmb/MiniCPM5-2B-GGUF`. */
  repo: string
  /** The quantisation, as the repo names it (`Q4_K_M`, `UD-Q3_K_XL`). */
  quant: string
  /** Every file the variant downloads: the model's shards, then any mmproj. */
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
  links: { huggingFace?: string }
  variants: LibraryVariant[]
  /**
   * Curated pick per memory tier, ascending: on a machine with at least
   * `ramGB` of memory, pull `variant`. The first row is the model's minimum.
   */
  recommended: { ramGB: number; variant: string }[]
  /** One of the models the user asked for by name; always shown first. */
  featured?: boolean
  /** Set when the model can't run anywhere yet. Get stays disabled and this explains why. */
  unsupported?: string
  /**
   * The model's architecture needs a llama.cpp pull request that is not
   * upstream yet. Eaon's build carries it (native/llama-fork.json); a runtime
   * built without it can't load the model, and the page says so.
   */
  requires?: { pull: number; architecture: string }
}

/** Eaon's own llama.cpp runtime, as the Models page shows it. */
export interface RuntimeInfo {
  /** This build of Eaon ships llama-server for this machine. */
  available: boolean
  /** llama-server's version line, e.g. "0.5.0-dev (build 11311, commit f7b384c)". */
  version: string | null
  /** llama.cpp pull requests the bundled build carries beyond upstream (native/llama-fork.json). */
  pulls: number[]
  /** The chat model loaded right now, if any. */
  loaded: { modelId: string; state: 'loading' | 'ready' } | null
}

/** A model downloaded on this computer — from the library or Browse Hugging Face. */
export interface InstalledModel {
  /** The id it has in the model picker ("On this computer"). */
  id: string
  label: string
  repoId: string
  /** The model's GGUF (the first shard of a split model). */
  filename: string
  quant: string
  sizeBytes: number
  downloadedAt: number
  library?: { modelId: string; variantId: string }
  vision: boolean
  embedding: boolean
}

export interface LibraryState {
  ramBytes: number
  /** Free space on the disk Eaon keeps models on; null when it could not be read. */
  freeDiskBytes: number | null
  chip: string
  runtime: RuntimeInfo
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
 * RAM size (llama.cpp and Ollama both report about 17.8 GiB on a 24 GB M5). A
 * model inside it runs fully on the GPU; past it llama.cpp keeps layers on the CPU, which
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

/* --------------------------------------------------------- Files and matching */

/** The variant's model file (the first shard of a split model), as opposed to its vision projector. */
export function mainFile(variant: LibraryVariant): string {
  return variant.source.files.find((f) => !/mmproj/i.test(f)) ?? variant.source.files[0]
}

/** The variant's vision projector, if it has one. */
export function projectorFile(variant: LibraryVariant): string | undefined {
  return variant.source.files.find((f) => /mmproj/i.test(f))
}

/** The downloaded copy of this variant, if there is one. */
export function findInstalled(variant: LibraryVariant, installed: InstalledModel[]): InstalledModel | undefined {
  return installed.find((m) => m.repoId === variant.source.repo && m.filename === mainFile(variant))
}

/** The first of a model's variants that is downloaded, preferring the one this machine would pick. */
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
 * Why this model can't run on the bundled runtime, or null when it can: its
 * architecture needs a llama.cpp PR this build doesn't carry.
 */
export function runtimeGap(model: LibraryModel, runtime: RuntimeInfo | undefined): string | null {
  if (model.unsupported) return model.unsupported
  if (!model.requires || !runtime) return null
  if (runtime.pulls.includes(model.requires.pull)) return null
  return `This build's llama.cpp can't load the ${model.requires.architecture} architecture yet (it needs llama.cpp PR #${model.requires.pull}).`
}

/**
 * Library downloads ride the same `models:download-progress` channel and
 * `modelDownloads` store map as Browse Hugging Face files, so the header's
 * Downloads panel shows both. The panel titles a row with the part of
 * `repoId` after the first slash, hence the `library/` prefix.
 */
export function libraryProgressKey(model: LibraryModel, variant: LibraryVariant): { repoId: string; filename: string } {
  return { repoId: `library/${model.name}`, filename: `${variant.source.repo}:${variant.quant}` }
}

/* ------------------------------------------------------------ Formatting */

/** Model sizes in decimal gigabytes — the unit Hugging Face shows. */
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
