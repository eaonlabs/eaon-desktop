import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  compareVersions,
  modAccess,
  OFFICIAL_PREFIX,
  parseManifest,
  type ClaudePluginParts,
  type ModInfo,
  type ModManifest,
  type ModsList,
  type ModSource,
  type ModSourceInfo
} from '@shared/mods'
import { store } from '../../store'
import { isPrivateHostname, privateAddressOf } from '../../netGuard'
import {
  bundledRoot,
  claudeParts,
  diskFiles,
  memoryFiles,
  modDataFile,
  modDir,
  modsRoot,
  readInstalledManifest,
  readModFolder,
  readModPack,
  writeModFiles,
  type ReadMod
} from './files'

/**
 * Which mods are installed, from where, and whether each is on; installing,
 * updating and removing them; and the indexes added as mod sources. The
 * state is one store file (`mods.json`); the mods themselves are folders
 * under `modsRoot()`.
 */

interface Installed {
  enabled: boolean
  version: string
  source: ModSource
  installedAt: number
}

interface ModsState {
  installed: Record<string, Installed>
  sources: { url: string; name: string }[]
}

const STATE_FILE = 'mods.json'

const loadState = (): ModsState => {
  const saved = store.getJson<Partial<ModsState>>(STATE_FILE, {}) ?? {}
  return { installed: saved.installed ?? {}, sources: saved.sources ?? [] }
}
const saveState = (state: ModsState): void => store.setJson(STATE_FILE, state)

const listeners = new Set<() => void>()
/** Called whenever what's installed, or on, changes. */
export function onModsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let enabledCache: ModManifest[] | null = null
const changed = (): void => {
  enabledCache = null
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('[mods] a listener failed:', error)
    }
  }
}

/** Every installed mod that is on, read from disk once per change. */
export function enabledMods(): ModManifest[] {
  if (enabledCache) return enabledCache
  const state = loadState()
  enabledCache = Object.entries(state.installed)
    .filter(([, rec]) => rec.enabled)
    .map(([id]) => readInstalledManifest(id))
    .filter((m): m is ModManifest => Boolean(m))
  return enabledCache
}

/** The folder of an installed mod that is on, for serving its panels and loading its CLI parts. */
export function enabledModDir(id: string): string | null {
  return enabledMods().some((m) => m.id === id) ? modDir(id) : null
}

/* ------------------------------------------------------------ bundled mods */

let bundledCache: Map<string, ReadMod & { ok: true }> | null = null

/** Eaon's own mods, read once a run: they only change with the app. */
function bundled(): Map<string, ReadMod & { ok: true }> {
  if (bundledCache) return bundledCache
  bundledCache = new Map()
  const root = bundledRoot()
  if (!root) return bundledCache
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith('.')) continue
    const read = readModFolder(join(root, name))
    if (!read.ok) {
      console.error(`[mods] bundled mod ${name} doesn't load: ${read.error}`)
      continue
    }
    if (!read.manifest.id.startsWith(OFFICIAL_PREFIX)) {
      console.error(`[mods] bundled mod ${name} isn't an eaon. id`)
      continue
    }
    bundledCache.set(read.manifest.id, read)
  }
  return bundledCache
}

/** For tests: forget what was read, so a changed bundle is read again. */
export function resetModsCache(): void {
  bundledCache = null
  enabledCache = null
  partsCache.clear()
  indexes.clear()
}

const partsCache = new Map<string, ClaudePluginParts | null>()

function installedParts(manifest: ModManifest): ClaudePluginParts | null {
  const key = `${manifest.id}@${manifest.version}`
  if (!partsCache.has(key)) {
    partsCache.set(key, manifest.contributes.claudePlugin ? claudeParts(diskFiles(modDir(manifest.id)), manifest.contributes.claudePlugin) : null)
  }
  return partsCache.get(key) ?? null
}

const readParts = (read: ReadMod & { ok: true }): ClaudePluginParts | null =>
  read.manifest.contributes.claudePlugin ? claudeParts(memoryFiles(read.files), read.manifest.contributes.claudePlugin) : null

/** Two access lists that would show the same install screen. */
const sameAccess = (a: ModInfo['access'], b: ModInfo['access']): boolean => JSON.stringify(a) === JSON.stringify(b)

/* ------------------------------------------------------------------ listing */

interface IndexEntry {
  url: string
  manifest: ModManifest
}
/** Each mod source's index as last read this run. */
const indexes = new Map<string, { name: string; entries: IndexEntry[]; error: string | null }>()

export function listMods(): ModsList {
  const state = loadState()
  const mods: ModInfo[] = []
  const shown = new Set<string>()
  const pack = bundled()

  for (const [id, rec] of Object.entries(state.installed)) {
    const manifest = readInstalledManifest(id)
    if (!manifest) continue
    const claude = installedParts(manifest)
    const access = modAccess(manifest, claude)
    const fromBundle = rec.source.kind === 'bundled' ? pack.get(id) : undefined
    let update: string | null = null
    if (fromBundle && compareVersions(fromBundle.manifest.version, manifest.version) > 0) update = fromBundle.manifest.version
    const fromIndex = [...indexes.entries()].find(([, index]) => index.entries.some((e) => e.manifest.id === id))
    if (rec.source.kind === 'url' && fromIndex) {
      const entry = fromIndex[1].entries.find((e) => e.manifest.id === id)!
      if (compareVersions(entry.manifest.version, manifest.version) > 0) update = entry.manifest.version
    }
    mods.push({
      manifest,
      official: rec.source.kind === 'bundled' && id.startsWith(OFFICIAL_PREFIX),
      installed: true,
      enabled: rec.enabled,
      source: rec.source,
      from: rec.source.kind === 'bundled' ? 'bundled' : fromIndex?.[0] ?? '',
      update,
      claude,
      access,
      installedAt: rec.installedAt
    })
    shown.add(id)
  }

  for (const [id, read] of pack) {
    if (shown.has(id)) continue
    const claude = readParts(read)
    mods.push({ manifest: read.manifest, official: true, installed: false, enabled: false, source: null, from: 'bundled', update: null, claude, access: modAccess(read.manifest, claude), installedAt: null })
    shown.add(id)
  }

  for (const [url, index] of indexes) {
    for (const entry of index.entries) {
      if (shown.has(entry.manifest.id)) continue
      // Not read yet: the install screen shows what the packed mod really holds.
      mods.push({ manifest: entry.manifest, official: false, installed: false, enabled: false, source: null, from: url, update: null, claude: null, access: modAccess(entry.manifest, null), installedAt: null })
      shown.add(entry.manifest.id)
    }
  }

  const sources = state.sources.map((s): ModSourceInfo => {
    const index = indexes.get(s.url)
    return { url: s.url, name: index?.name ?? s.name, count: index ? index.entries.length : null, error: index?.error ?? null }
  })
  return { mods, sources }
}

/* ------------------------------------------------------------- installing */

/** Moves a mod's files into place, replacing an older copy, and records it. */
function place(read: ReadMod & { ok: true }, source: ModSource, keepEnabled: boolean): void {
  const { manifest } = read
  if (source.kind !== 'bundled' && manifest.id.startsWith(OFFICIAL_PREFIX)) {
    throw new Error(`Mod ids starting with "${OFFICIAL_PREFIX}" are kept for Eaon’s own mods. Give this one an id of your own.`)
  }
  const root = modsRoot()
  const temp = join(root, `.incoming-${randomUUID()}`)
  writeModFiles(temp, read.files)
  const target = modDir(manifest.id)
  try {
    rmSync(target, { recursive: true, force: true })
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { recursive: true, force: true })
    throw error
  }
  const state = loadState()
  const was = state.installed[manifest.id]
  state.installed[manifest.id] = {
    enabled: keepEnabled && was ? was.enabled : true,
    version: manifest.version,
    source,
    installedAt: Date.now()
  }
  saveState(state)
  partsCache.clear()
  changed()
}

export function installBundled(id: string): void {
  const read = bundled().get(id)
  if (!read) throw new Error('That mod isn’t one of Eaon’s.')
  place(read, { kind: 'bundled' }, true)
}

/**
 * Bundled mods installed from an earlier Eaon, brought up to this one's
 * copies, when the new copy asks for nothing more. One that does waits for
 * the user to review it (the card says "Review update").
 */
export function syncBundledMods(): void {
  const state = loadState()
  for (const [id, rec] of Object.entries(state.installed)) {
    if (rec.source.kind !== 'bundled') continue
    const read = bundled().get(id)
    const current = readInstalledManifest(id)
    if (!read) continue
    if (current && compareVersions(read.manifest.version, current.version) <= 0) continue
    const before = current ? modAccess(current, installedParts(current)) : []
    if (current && !sameAccess(before, modAccess(read.manifest, readParts(read)))) continue
    try {
      place(read, { kind: 'bundled' }, true)
    } catch (error) {
      console.error(`[mods] couldn't update ${id}:`, error)
    }
  }
}

/** A mod read for review and not yet installed. Dropped after a while, or when installed or discarded. */
interface Staged {
  read: ReadMod & { ok: true }
  source: ModSource
  at: number
}
const staged = new Map<string, Staged>()
const STAGED_FOR_MS = 30 * 60 * 1000

export interface Inspected {
  token: string
  info: ModInfo
}

function stage(read: ReadMod, source: ModSource): Inspected {
  if (!read.ok) throw new Error(read.error)
  if (read.manifest.id.startsWith(OFFICIAL_PREFIX)) {
    throw new Error(`Mod ids starting with "${OFFICIAL_PREFIX}" are kept for Eaon’s own mods. This one can’t be installed from outside the app.`)
  }
  for (const [token, item] of staged) if (Date.now() - item.at > STAGED_FOR_MS) staged.delete(token)
  const token = randomUUID()
  staged.set(token, { read, source, at: Date.now() })
  const claude = readParts(read)
  const rec = loadState().installed[read.manifest.id]
  return {
    token,
    info: {
      manifest: read.manifest,
      official: false,
      installed: Boolean(rec),
      enabled: rec?.enabled ?? false,
      source,
      from: source.kind === 'url' ? source.url : '',
      update: null,
      claude,
      access: modAccess(read.manifest, claude),
      installedAt: rec?.installedAt ?? null
    }
  }
}

export function inspectFolder(path: string): Inspected {
  return stage(readModFolder(path), { kind: 'folder', path })
}

export function inspectPackText(text: string, source: ModSource): Inspected {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('That file isn’t JSON. A packed mod is a .json file with "eaonMod": 1.')
  }
  // A mod.json picked on its own: its folder holds the rest.
  if (typeof raw === 'object' && raw !== null && 'schema' in raw && !('eaonMod' in raw) && source.kind === 'file') {
    return inspectFolder(join(source.path, '..'))
  }
  return stage(readModPack(raw), source)
}

export async function inspectUrl(url: string): Promise<Inspected> {
  const text = await fetchText(url)
  return inspectPackText(text, { kind: 'url', url })
}

export function installStaged(token: string): void {
  const item = staged.get(token)
  if (!item) throw new Error('That review has expired. Open the mod again to install it.')
  staged.delete(token)
  place(item.read, item.source, true)
}

export function discardStaged(token: string): void {
  staged.delete(token)
}

export function uninstall(id: string): void {
  const state = loadState()
  if (!state.installed[id]) return
  delete state.installed[id]
  saveState(state)
  rmSync(modDir(id), { recursive: true, force: true })
  rmSync(modDataFile(id), { force: true })
  partsCache.clear()
  changed()
}

export function setEnabled(id: string, enabled: boolean): void {
  const state = loadState()
  const rec = state.installed[id]
  if (!rec || rec.enabled === enabled) return
  rec.enabled = enabled
  saveState(state)
  changed()
}

/* ------------------------------------------------------------ mod sources */

const MAX_DOWNLOAD = 3 * 1024 * 1024

/**
 * An https document, refused when it lives on this computer or the local
 * network (checked again at every redirect) or is larger than a mod can be.
 */
export async function fetchText(raw: string): Promise<string> {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('That isn’t a link.')
  }
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== 'https:') throw new Error('Mods are only downloaded over https.')
    if (isPrivateHostname(url.hostname) || (await privateAddressOf(url.hostname))) throw new Error('Mods aren’t downloaded from this computer or the local network.')
    const response = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'Eaon', Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location')!, url)
      continue
    }
    if (!response.ok) throw new Error(`The server answered ${response.status}.`)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_DOWNLOAD) throw new Error('That download is larger than a mod can be.')
    const body = await response.arrayBuffer()
    if (body.byteLength > MAX_DOWNLOAD) throw new Error('That download is larger than a mod can be.')
    return Buffer.from(body).toString('utf8')
  }
  throw new Error('That link redirects too many times.')
}

/** An index's mods, each a packed mod's URL and its manifest. Entries that don't check out are left out. */
export function parseIndex(text: string, base: string): { name: string; entries: IndexEntry[] } {
  let raw: { name?: unknown; mods?: unknown }
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('That isn’t a mod index: it isn’t JSON.')
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.mods)) throw new Error('That isn’t a mod index: it has no "mods" list.')
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : new URL(base).hostname
  const entries: IndexEntry[] = []
  for (const item of raw.mods.slice(0, 200) as { url?: unknown; manifest?: unknown }[]) {
    const parsed = parseManifest(item?.manifest)
    if (!parsed.ok || typeof item.url !== 'string') continue
    if (parsed.manifest.id.startsWith(OFFICIAL_PREFIX)) continue
    try {
      const url = new URL(item.url, base)
      if (url.protocol === 'https:') entries.push({ url: url.toString(), manifest: parsed.manifest })
    } catch {
      // A bad link: left out.
    }
  }
  return { name, entries }
}

async function readSource(url: string): Promise<void> {
  try {
    const index = parseIndex(await fetchText(url), url)
    indexes.set(url, { ...index, error: null })
  } catch (error) {
    const was = indexes.get(url)
    indexes.set(url, { name: was?.name ?? new URL(url).hostname, entries: was?.entries ?? [], error: error instanceof Error ? error.message : String(error) })
  }
}

export async function addSource(url: string): Promise<void> {
  const clean = new URL(url.trim()).toString()
  const index = parseIndex(await fetchText(clean), clean)
  indexes.set(clean, { ...index, error: null })
  const state = loadState()
  if (!state.sources.some((s) => s.url === clean)) state.sources.push({ url: clean, name: index.name })
  saveState(state)
  changed()
}

export function removeSource(url: string): void {
  const state = loadState()
  state.sources = state.sources.filter((s) => s.url !== url)
  saveState(state)
  indexes.delete(url)
  changed()
}

/** Reads every source's index again. */
export async function refreshSources(): Promise<void> {
  await Promise.all(loadState().sources.map((s) => readSource(s.url)))
  changed()
}

/** The packed-mod link an index lists for `id`, to inspect it. */
export function indexedUrl(id: string): string | null {
  for (const index of indexes.values()) {
    const entry = index.entries.find((e) => e.manifest.id === id)
    if (entry) return entry.url
  }
  return null
}

/** Whether the mods folder exists yet (it's made on the first install). */
export const modsFolderExists = (): boolean => existsSync(modsRoot())
