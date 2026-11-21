import fs from 'node:fs'
import path from 'node:path'
import { app, nativeImage } from 'electron'
import { avatarSteps, ownerKey, ownerOfRemote, type RepoOwner } from '@shared/repoAvatar'
import { remoteUrl } from './ade/git'
import { checkImage } from '../providers/logos'
import { isPrivateHostname, privateAddressOf } from '../netGuard'
import { store } from '../store'
import type { Feature } from './types'

/**
 * Projects' pictures (shared/repoAvatar.ts): the avatar of whoever owns a
 * project's repository on GitHub, GitLab, Codeberg or Bitbucket, for the
 * sidebars' project tags. Looked up from the folder's `origin` remote and
 * kept, one per owner, as a small data: URL: a week when found, a day when
 * the owner has none, so a sidebar full of one organisation's repositories
 * asks once. Requests go only to those forges' public addresses (and where
 * they redirect, never this computer or the local network), carry no
 * cookies or tokens, and only an image that passes the provider-logo
 * checks is kept. Channels: `project-avatars:get` (a folder's), and
 * `project-avatars:github` (a GitHub account's, by login).
 */

const DOC = 'project-avatars.json'
const FOUND_FOR_MS = 7 * 24 * 3_600_000
const MISSING_FOR_MS = 24 * 3_600_000
/** A folder's remote is read again after this long (it was added, or changed). */
const REMOTE_FOR_MS = 10 * 60_000
const TIMEOUT_MS = 6_000
const MAX_REDIRECTS = 5
const MAX_JSON_BYTES = 256 * 1024
const MAX_IMAGE_BYTES = 1024 * 1024
/** Kept at this many pixels a side: twice the largest tag, for Retina screens. */
const SIDE = 64

interface Kept {
  /** The picture, or null: the owner has none (or is gone). */
  src: string | null
  at: number
}

function read(): Record<string, Kept> {
  const raw = store.getJson<unknown>(DOC, {})
  const out: Record<string, Kept> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const kept = value as Partial<Kept> | null
    if (!kept || typeof kept.at !== 'number') continue
    if (kept.src !== null && !(typeof kept.src === 'string' && kept.src.startsWith('data:image/'))) continue
    out[key] = { src: kept.src, at: kept.at }
  }
  return out
}

function keep(key: string, src: string | null): void {
  store.setJson(DOC, { ...read(), [key]: { src, at: Date.now() } })
}

const remotes = new Map<string, { owner: RepoOwner | null; at: number }>()

async function ownerOf(folder: string): Promise<RepoOwner | null> {
  const known = remotes.get(folder)
  if (known && Date.now() - known.at < REMOTE_FOR_MS) return known.owner
  const owner = ownerOfRemote(await remoteUrl(folder))
  remotes.set(folder, { owner, at: Date.now() })
  return owner
}

const userAgent = (): string => `Eaon/${app.getVersion() || 'dev'} (project pictures)`

/** What a request came to: the bytes, a clear "there is none" (404, nothing to show), or no answer worth keeping (offline, rate-limited). */
type Got = { ok: true; bytes: Uint8Array; type: string } | { ok: false; none: boolean }

/** GET over HTTPS, following redirects itself so none leads to this computer or the local network. */
async function get(address: string, accept: string, maxBytes: number): Promise<Got> {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return { ok: false, none: true }
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' || isPrivateHostname(url.hostname) || (await privateAddressOf(url.hostname))) return { ok: false, none: true }
    let response: Response
    try {
      response = await fetch(url.href, { redirect: 'manual', credentials: 'omit', headers: { accept, 'user-agent': userAgent() }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      return { ok: false, none: false }
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      try {
        url = new URL(location ?? '', url)
      } catch {
        return { ok: false, none: true }
      }
      if (!location) return { ok: false, none: true }
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, none: response.status === 404 || response.status === 410 }
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, none: true }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > maxBytes) return { ok: false, none: true }
    return { ok: true, bytes, type: response.headers.get('content-type') ?? '' }
  }
  return { ok: false, none: true }
}

/** The picture as a data: URL, made small; null when it isn't an image Eaon shows. */
function shrink(bytes: Uint8Array): string | null {
  const checked = checkImage(bytes)
  if (!checked.ok) return null
  const { mime, width, height } = checked.info
  if ((mime === 'image/png' || mime === 'image/jpeg') && width && height && Math.max(width, height) > SIDE) {
    const image = nativeImage.createFromBuffer(Buffer.from(bytes))
    if (!image.isEmpty()) {
      const small = width >= height ? image.resize({ width: SIDE, quality: 'best' }) : image.resize({ height: SIDE, quality: 'best' })
      return `data:image/png;base64,${small.toPNG().toString('base64')}`
    }
  }
  return checked.src
}

/** Asks the owner's forge for their picture: its data: URL, null when they have none, undefined when there was no telling. */
async function lookUp(owner: RepoOwner): Promise<string | null | undefined> {
  let unsure = false
  for (const step of avatarSteps(owner)) {
    let address: string | null = step.url
    if (step.kind === 'json') {
      const got = await get(step.url, 'application/json', MAX_JSON_BYTES)
      if (!got.ok) {
        unsure ||= !got.none
        continue
      }
      try {
        address = step.pick(JSON.parse(new TextDecoder().decode(got.bytes)))
      } catch {
        address = null
      }
      if (!address) continue
    }
    const image = await get(address, 'image/*', MAX_IMAGE_BYTES)
    if (!image.ok) {
      unsure ||= !image.none
      continue
    }
    const src = shrink(image.bytes)
    if (src) return src
  }
  return unsure ? undefined : null
}

const asking = new Map<string, Promise<string | null | undefined>>()

/** A project folder's picture: kept, or looked up now (a stale one is shown while it's looked up again). */
export async function projectAvatar(folder: string): Promise<string | null> {
  const owner = await ownerOf(folder)
  return owner ? pictureOf(owner) : null
}

/** A GitHub account's login: letters, digits and single hyphens, up to 39. */
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i

/** A GitHub account's picture by its login (the Pull requests page's conversation), kept like a project's. */
export async function githubAvatar(login: string): Promise<string | null> {
  return GITHUB_LOGIN.test(login) ? pictureOf({ forge: 'github', owner: login, namespace: login }) : null
}

async function pictureOf(owner: RepoOwner): Promise<string | null> {
  const key = ownerKey(owner)
  const kept = read()[key]
  if (kept && Date.now() - kept.at < (kept.src ? FOUND_FOR_MS : MISSING_FOR_MS)) return kept.src
  let pending = asking.get(key)
  if (!pending) {
    pending = lookUp(owner)
      .then((src) => {
        if (src !== undefined) keep(key, src)
        return src
      })
      .catch(() => undefined)
      .finally(() => asking.delete(key))
    asking.set(key, pending)
  }
  if (kept?.src) return kept.src
  return (await pending) ?? null
}

const isFolder = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || !path.isAbsolute(value)) return false
  try {
    return fs.statSync(value).isDirectory()
  } catch {
    return false
  }
}

export const projectAvatarsFeature: Feature = {
  id: 'project-avatars',
  register: ({ ipcMain }) => {
    ipcMain.handle('project-avatars:get', (_event, folder: unknown) => (isFolder(folder) ? projectAvatar(folder).catch(() => null) : null))
    ipcMain.handle('project-avatars:github', (_event, login: unknown) => (typeof login === 'string' ? githubAvatar(login).catch(() => null) : null))
  }
}
