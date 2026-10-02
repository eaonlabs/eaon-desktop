import type { ModelInfo } from '@shared/types'
import { store } from '../store'
import generated from './catalog.generated.json'
import { fromModelsDev, MODELS_DEV_SOURCES, PI_SOURCES, type CatalogModel } from './catalogSources'

/**
 * The model catalog at runtime: what shipped with the app
 * (`catalog.generated.json`, from Pi's data and models.dev — see
 * `scripts/generate-models.mjs`), topped up from models.dev while the app
 * runs, so a model released after this build still appears.
 *
 * models.dev is public and needs no key, so this works before any provider is
 * set up. It is checked at most once a day in the background, and whenever
 * the user presses refresh on a provider.
 */

const CACHE_FILE = 'models-dev.json'
const MODELS_DEV_URL = 'https://models.dev/api.json'
const DAY = 24 * 60 * 60 * 1000

/**
 * For providers whose shipped list comes from Pi, models.dev only adds what Pi
 * could not have had yet: models released within a month of the build or
 * after. Older models absent from Pi's data were left out on purpose (dead
 * aliases, models the endpoint does not really serve).
 */
const PI_GRACE_MS = 30 * DAY

interface Cache {
  fetchedAt: number
  providers: Record<string, CatalogModel[]>
}

const shipped = generated as unknown as { generatedAt: string; providers: Record<string, CatalogModel[]> }
const shippedAt = Date.parse(shipped.generatedAt)

let cache: Cache | null | undefined
let inflight: Promise<CatalogResult> | null = null

function loadCache(): Cache | null {
  if (cache === undefined) {
    const saved = store.getJson<Cache | null>(CACHE_FILE, null)
    cache = saved && typeof saved.fetchedAt === 'number' && saved.providers ? saved : null
  }
  return cache
}

/** True when the catalog has an opinion about this provider's models. */
export function hasCatalog(providerId: string): boolean {
  return providerId in shipped.providers || providerId in MODELS_DEV_SOURCES
}

const loose = (id: string): string => id.toLowerCase().replace(/\./g, '-')

/** Every model the catalog knows for a provider, newest first. */
export function catalogFor(providerId: string): ModelInfo[] {
  const base = shipped.providers[providerId] ?? []
  const fresh = loadCache()?.providers[providerId]
  let models: CatalogModel[]
  if (!fresh) models = base
  else if (!PI_SOURCES[providerId]) {
    // Same source as the shipped list, only newer: it wins outright.
    models = fresh
  } else {
    const known = new Set(base.map((m) => loose(m.id)))
    const cutoff = shippedAt - PI_GRACE_MS
    const added = fresh.filter((m) => !known.has(loose(m.id)) && m.released && Date.parse(m.released) >= cutoff)
    models = added.length ? [...added, ...base] : base
  }
  return models
    .slice()
    .sort((a, b) => (b.released ?? '').localeCompare(a.released ?? ''))
    .map(({ released: _released, ...model }) => ({ ...model, providerId }))
}

export interface CatalogResult {
  /** When the catalog was last read from models.dev, or null if never. */
  fetchedAt: number | null
  /** Model ids that appeared since the previous fetch, by provider. */
  added: Record<string, string[]>
}

/**
 * Reads models.dev and caches the providers Eaon knows. Concurrent callers
 * share one request; `maxAge` skips the fetch when the cache is fresh enough.
 */
export function refreshCatalog(maxAge = 0): Promise<CatalogResult> {
  const current = loadCache()
  if (current && Date.now() - current.fetchedAt < maxAge) return Promise.resolve({ fetchedAt: current.fetchedAt, added: {} })
  if (inflight) return inflight
  inflight = (async () => {
    const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`models.dev returned ${response.status}`)
    const api = (await response.json()) as Record<string, unknown>
    const before = Object.fromEntries(Object.keys(MODELS_DEV_SOURCES).map((id) => [id, new Set(catalogFor(id).map((m) => m.id))]))
    const providers: Record<string, CatalogModel[]> = {}
    for (const [id, source] of Object.entries(MODELS_DEV_SOURCES)) {
      if (api[source]) providers[id] = fromModelsDev(api[source], id)
    }
    // A malformed or empty answer must not wipe what the app knows.
    if (Object.keys(providers).length < Object.keys(MODELS_DEV_SOURCES).length / 2) throw new Error('models.dev returned an unexpected catalog')
    cache = { fetchedAt: Date.now(), providers }
    store.setJson(CACHE_FILE, cache)
    const added: Record<string, string[]> = {}
    for (const id of Object.keys(providers)) {
      const fresh = catalogFor(id)
        .map((m) => m.id)
        .filter((m) => !before[id]?.has(m))
      if (fresh.length) added[id] = fresh
    }
    return { fetchedAt: cache.fetchedAt, added }
  })().finally(() => {
    inflight = null
  })
  return inflight
}

/** Background check at launch: at most daily, and silent on failure (offline is normal). */
export function refreshCatalogInBackground(): Promise<boolean> {
  return refreshCatalog(DAY).then(
    (result) => Object.keys(result.added).length > 0,
    () => false
  )
}

export function catalogFetchedAt(): number | null {
  return loadCache()?.fetchedAt ?? null
}
