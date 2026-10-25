import { app } from 'electron'
import { getDomain } from 'tldts'
import {
  MAX_LOGO_BYTES,
  MIN_LOGO_PIXELS,
  PROVIDER_LOGO_DOCS_URL,
  PROVIDER_MANIFEST_PATH,
  type LogoLookupStep,
  type ProviderLogo,
  type ProviderLogos
} from '@shared/providerLogos'
import { isPrivateHostname, privateAddressOf, resolveAll, type Resolver } from '../netGuard'
import { store } from '../store'
import { getProvider, listProviders } from '.'
import { isEaonGateway } from '../eaonAddress'

/**
 * Logos for providers Eaon doesn't ship one for (docs/provider-logos.md).
 *
 * A custom provider's logo is looked up from its base URL when it's added or
 * its base URL changes, and again now and then: first the provider's own
 * manifest at /.well-known/eaon-provider.json (on the API host, then on the
 * website at the registrable domain, so api.acme.ai finds acme.ai's), then
 * the icons its home page declares, then /favicon.ico. The first image that
 * passes the checks wins. Built-in providers are never looked up on their
 * own: they ship their logos, and Eaon doesn't contact a provider the person
 * hasn't added.
 *
 * Anyone can also pick their own image for any provider, which shows over
 * everything else until it's reset.
 *
 * Everything is checked before it's kept: a real PNG, JPEG, GIF, WebP, ICO or
 * SVG by its bytes (not its name or header), at most 1 MB, at least 16 pixels
 * a side, and an SVG with no scripts, embedded HTML or outside files. Images
 * are kept as data: URLs, which is all the window will show, and shown only
 * in <img>, where an SVG can't run anything. Requests carry no cookies and
 * no API key; a provider on the internet can't send Eaon to an address on
 * this computer or the local network.
 */

const DOC = 'provider-logos.json'
const TIMEOUT_MS = 6_000
const LOOKUP_BUDGET_MS = 30_000
const MAX_REDIRECTS = 5
const MAX_PAGE_BYTES = 512 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024
/** Looked up again after this long: a month when one was found (it may have changed), a week when none was. */
const REFRESH_FOUND_MS = 30 * 24 * 3_600_000
const REFRESH_MISSING_MS = 7 * 24 * 3_600_000

/* ------------------------------------------------------------- images */

export interface ImageInfo {
  mime: string
  /** Pixels; null for SVG, which scales. */
  width: number | null
  height: number | null
}

const u16be = (b: Uint8Array, i: number): number => (b[i] << 8) | b[i + 1]
const u16le = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8)
const u24le = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const u32be = (b: Uint8Array, i: number): number => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])
const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to))

/** What image this is, by its bytes, and its size in pixels. Null: not an image Eaon shows. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const b = bytes
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return { mime: 'image/png', width: u32be(b, 16), height: u32be(b, 20) }
  if (b.length >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return { mime: 'image/gif', width: u16le(b, 6), height: u16le(b, 8) }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // The frame header (SOFn) carries the size; skip the segments before it.
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2
        continue
      }
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (sof) return { mime: 'image/jpeg', width: u16be(b, i + 7), height: u16be(b, i + 5) }
      i += 2 + u16be(b, i + 2)
    }
    return { mime: 'image/jpeg', width: null, height: null }
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') {
    const chunk = ascii(b, 12, 16)
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
    if (chunk === 'VP8L')
      return {
        mime: 'image/webp',
        width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
        height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6))
      }
    if (chunk === 'VP8X') return { mime: 'image/webp', width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) }
    return null
  }
  if (b.length >= 22 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) {
    // An icon file holds several sizes; the largest is what counts.
    const count = u16le(b, 4)
    if (count === 0 || 6 + count * 16 > b.length) return null
    let width = 0
    let height = 0
    for (let n = 0; n < count; n++) {
      const entry = 6 + n * 16
      width = Math.max(width, b[entry] || 256)
      height = Math.max(height, b[entry + 1] || 256)
    }
    return { mime: 'image/x-icon', width, height }
  }
  if (looksLikeSvg(b)) return { mime: 'image/svg+xml', width: null, height: null }
  return null
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^﻿/, '')
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)
}

/**
 * An SVG fit to show: what's wrong with it, or the text to keep. A missing
 * SVG namespace (the most common export mistake, which stops it showing as
 * an image at all) is added rather than refused.
 */
export function checkSvg(text: string): { svg: string } | { problem: string } {
  if (/<script[\s>]/i.test(text)) return { problem: 'It’s an SVG with a script in it, which Eaon won’t show.' }
  if (/<foreignObject[\s>]/i.test(text)) return { problem: 'It’s an SVG with HTML inside (<foreignObject>), which Eaon won’t show.' }
  if (/<!ENTITY/i.test(text)) return { problem: 'It’s an SVG that declares XML entities, which Eaon won’t show.' }
  if (/<(image|use|feImage)\b[^>]*\bhref\s*=\s*["']\s*(https?:|\/\/)/i.test(text))
    return { problem: 'It’s an SVG that loads an image from another address, which wouldn’t show. Put everything in the one file.' }
  const svg = text.replace(/<svg\b([^>]*)>/i, (tag, attributes: string) =>
    /\sxmlns\s*=/.test(attributes) ? tag : `<svg xmlns="http://www.w3.org/2000/svg"${attributes}>`
  )
  return { svg }
}

export type CheckedImage = { ok: true; src: string; info: ImageInfo } | { ok: false; reason: string }

/** A file that might be a logo: the data: URL to keep, or why it can't be one. */
export function checkImage(bytes: Uint8Array): CheckedImage {
  if (bytes.length === 0) return { ok: false, reason: 'The file is empty.' }
  if (bytes.length > MAX_LOGO_BYTES) return { ok: false, reason: `It’s ${(bytes.length / 1024 / 1024).toFixed(1)} MB; a logo can be at most 1 MB.` }
  const info = sniffImage(bytes)
  if (!info) return { ok: false, reason: 'It isn’t an image Eaon can show (SVG, PNG, JPEG, WebP, GIF or ICO).' }
  if (info.mime === 'image/svg+xml') {
    const checked = checkSvg(new TextDecoder().decode(bytes).replace(/^﻿/, ''))
    if ('problem' in checked) return { ok: false, reason: checked.problem }
    return { ok: true, info, src: `data:image/svg+xml;base64,${Buffer.from(checked.svg, 'utf8').toString('base64')}` }
  }
  if (info.width !== null && info.height !== null) {
    const shorter = Math.min(info.width, info.height)
    if (shorter < MIN_LOGO_PIXELS) return { ok: false, reason: `It’s ${info.width}×${info.height} pixels; a logo needs at least ${MIN_LOGO_PIXELS} on each side.` }
    if (Math.max(info.width, info.height) > 8192) return { ok: false, reason: `It’s ${info.width}×${info.height} pixels; a logo can be at most 8192 on a side.` }
  }
  return { ok: true, info, src: `data:${info.mime};base64,${Buffer.from(bytes).toString('base64')}` }
}

/* ---------------------------------------------------------- web pages */

export interface IconCandidate {
  url: string
  /** The larger side it declares, in pixels; Infinity for SVG; 0 when it doesn't say. */
  size: number
}

const attributesOf = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const match of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[match[1].toLowerCase()] = (match[3] ?? match[4] ?? match[5] ?? '').trim()
  }
  return out
}

const largestSide = (sizes: string | undefined): number => {
  if (!sizes) return 0
  if (/\bany\b/i.test(sizes)) return Infinity
  return Math.max(0, ...[...sizes.matchAll(/(\d+)\s*[xX×]\s*(\d+)/g)].map((m) => Math.max(Number(m[1]), Number(m[2]))))
}

const resolveUrl = (href: string, base: string): string | null => {
  try {
    const url = new URL(href, base)
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'data:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * The icons a home page declares (<link rel="icon">, apple-touch-icon) and
 * its web app manifest, best first: SVG, then the largest declared size, an
 * apple-touch-icon counting as the 180 pixels it nearly always is.
 */
export function pageIcons(html: string, pageUrl: string): { icons: IconCandidate[]; manifest: string | null } {
  const head = html.slice(0, MAX_PAGE_BYTES)
  const baseTag = head.match(/<base\b[^>]*>/i)
  const base = (baseTag && resolveUrl(attributesOf(baseTag[0]).href ?? '', pageUrl)) || pageUrl
  const icons: IconCandidate[] = []
  let manifest: string | null = null
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributesOf(tag)
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/)
    const url = attrs.href ? resolveUrl(attrs.href, base) : null
    if (!url) continue
    if (rel.includes('manifest')) {
      manifest ??= url
      continue
    }
    const touch = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')
    if (!touch && !rel.includes('icon')) continue
    const svg = (attrs.type ?? '').includes('svg') || /\.svg(\?|#|$)/i.test(url)
    icons.push({ url, size: svg ? Infinity : largestSide(attrs.sizes) || (touch ? 180 : 0) })
  }
  return { icons: rankIcons(icons), manifest }
}

/** A web app manifest's icons, best first; "monochrome" ones are left out (they're masks, not logos). */
export function manifestIcons(text: string, manifestUrl: string): IconCandidate[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  const list = (json as { icons?: unknown })?.icons
  if (!Array.isArray(list)) return []
  const icons: IconCandidate[] = []
  for (const icon of list as { src?: unknown; sizes?: unknown; type?: unknown; purpose?: unknown }[]) {
    if (typeof icon?.src !== 'string') continue
    const purpose = typeof icon.purpose === 'string' ? icon.purpose.toLowerCase().split(/\s+/) : ['any']
    if (!purpose.includes('any') && !purpose.includes('maskable')) continue
    const url = resolveUrl(icon.src, manifestUrl)
    if (!url) continue
    const svg = (typeof icon.type === 'string' && icon.type.includes('svg')) || /\.svg(\?|#|$)/i.test(url)
    // A maskable icon keeps its logo inside a safe zone, so it comes out small: second choice.
    const size = svg ? Infinity : largestSide(typeof icon.sizes === 'string' ? icon.sizes : undefined)
    icons.push({ url, size: purpose.includes('any') ? size : Math.min(size, 63) })
  }
  return rankIcons(icons)
}

const rankIcons = (icons: IconCandidate[]): IconCandidate[] =>
  icons.filter((icon, i) => icons.findIndex((other) => other.url === icon.url) === i).sort((a, b) => b.size - a.size)

/* ----------------------------------------------------- the manifest */

export interface ProviderManifest {
  logo: string
  dark?: string
  name?: string
}

/**
 * /.well-known/eaon-provider.json as a provider wrote it. The documented form
 * is `{ "name", "logo", "logo_dark" }` with URLs (absolute, or relative to
 * the file); `icon`, camelCase and a `logo: { light, dark }` object are taken
 * too, so a near miss still works.
 */
export function readManifest(text: string, manifestUrl: string): ProviderManifest | { problem: string } {
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return { problem: 'Not valid JSON.' }
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { problem: 'Not a JSON object.' }
  const doc = json as Record<string, unknown>
  const pick = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === 'string' && value.trim() !== '')?.trim()
  const nested = (doc.logo ?? doc.icon) as Record<string, unknown> | undefined
  const object = typeof nested === 'object' && nested !== null ? nested : {}
  const logo = pick(doc.logo, doc.icon, doc.logo_url, doc.logoUrl, object.light, object.default, object.url)
  const dark = pick(doc.logo_dark, doc.logoDark, doc.icon_dark, doc.iconDark, object.dark)
  if (!logo) return { problem: 'It has no "logo".' }
  const logoUrl = resolveUrl(logo, manifestUrl)
  if (!logoUrl) return { problem: `"logo" isn’t a web address or data: URL: ${logo.slice(0, 80)}` }
  const darkUrl = dark ? resolveUrl(dark, manifestUrl) : null
  const name = pick(doc.name)?.slice(0, 80)
  return { logo: logoUrl, ...(darkUrl ? { dark: darkUrl } : {}), ...(name ? { name } : {}) }
}

/* -------------------------------------------------------- the network */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface LookupDeps {
  fetch: FetchLike
  resolve: Resolver
  now: () => number
}

const defaultDeps = (): LookupDeps => ({ fetch: (url, init) => fetch(url, init), resolve: resolveAll, now: Date.now })

type Got = { ok: true; url: string; bytes: Uint8Array } | { ok: false; reason: string }

const sizeText = (bytes: number): string => (bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MB` : `${Math.round(bytes / 1024)} KB`)

interface Session {
  deps: LookupDeps
  /** The base URL is on the internet: nothing may lead to this computer or the local network. */
  publicOnly: boolean
  deadline: number
  steps: LogoLookupStep[]
}

const userAgent = (): string => {
  let version = ''
  try {
    version = app.getVersion()
  } catch {
    // Not in Electron (the CLI, tests).
  }
  return `Eaon/${version || 'dev'} (provider logo lookup; ${PROVIDER_LOGO_DOCS_URL})`
}

const plainNetworkError = (error: unknown): string => {
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { cause?: { code?: string } }).cause?.code ?? '')}` : String(error)
  if (/TimeoutError|aborted/i.test(text)) return `No answer in ${TIMEOUT_MS / 1000} seconds`
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return 'No such address'
  if (/ECONNREFUSED/.test(text)) return 'Connection refused'
  if (/CERT|SSL|TLS/i.test(text)) return 'Its HTTPS certificate isn’t valid'
  return 'Couldn’t connect'
}

/** GET with every check: its own redirects, the time and size caps, and the private-network rule. */
async function get(session: Session, address: string, accept: string, maxBytes: number): Promise<Got> {
  if (address.startsWith('data:')) return decodeDataUrl(address)
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return { ok: false, reason: 'Not a web address' }
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'Not a web address' }
    if (session.publicOnly && (isPrivateHostname(url.hostname) || (await privateAddressOf(url.hostname, session.deps.resolve))))
      return { ok: false, reason: 'Leads to this computer or the local network, which a provider on the internet can’t point Eaon to' }
    const left = session.deadline - session.deps.now()
    if (left <= 0) return { ok: false, reason: 'Skipped: the look-up ran out of time' }
    let response: Response
    try {
      response = await session.deps.fetch(url.href, {
        redirect: 'manual',
        credentials: 'omit',
        headers: { accept, 'user-agent': userAgent() },
        signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, left))
      })
    } catch (error) {
      return { ok: false, reason: plainNetworkError(error) }
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) return { ok: false, reason: `Redirect (${response.status}) with nowhere to go` }
      url = new URL(location, url)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, reason: response.status === 404 ? 'Not found (404)' : `The server answered ${response.status}` }
    }
    const declared = Number(response.headers.get('content-length'))
    if (declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, reason: `Larger than ${sizeText(maxBytes)}` }
    }
    const bytes = await readCapped(response, maxBytes)
    if (!bytes) return { ok: false, reason: `Larger than ${sizeText(maxBytes)}` }
    return { ok: true, url: url.href, bytes }
  }
  return { ok: false, reason: `Redirected more than ${MAX_REDIRECTS} times` }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(await response.arrayBuffer())
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    parts.push(value)
  }
  return Buffer.concat(parts)
}

function decodeDataUrl(address: string): Got {
  const match = address.match(/^data:([^,;]*)((?:;[^,;]*)*?)(;base64)?,(.*)$/s)
  if (!match) return { ok: false, reason: 'Not a valid data: URL' }
  try {
    const bytes = match[3] ? Buffer.from(match[4], 'base64') : Buffer.from(decodeURIComponent(match[4]), 'utf8')
    return { ok: true, url: 'data:', bytes }
  } catch {
    return { ok: false, reason: 'Not a valid data: URL' }
  }
}

/** The places to look, in order: the base URL's own origin, then the website at its registrable domain. */
export function lookupOrigins(baseUrl: string): string[] {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return []
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return []
  const origins = [url.origin]
  // An IP address or a name only this network knows has no website elsewhere.
  if (!isPrivateHostname(url.hostname)) {
    // Shared hosting (github.io, vercel.app, workers.dev) counts as its own domain: one site there never takes another's logo.
    const domain = getDomain(url.hostname, { allowPrivateDomains: true })
    if (domain && domain !== url.hostname) origins.push(`https://${domain}`)
  }
  return origins
}

/* ------------------------------------------------------------- lookup */

export interface FoundLogo {
  src: string
  dark?: string
  from: string
  name?: string
}

export interface LookupResult {
  logo: FoundLogo | null
  steps: LogoLookupStep[]
}

const short = (url: string): string => (url.startsWith('data:') ? 'an image inside the manifest' : url)

/** Fetches one image and checks it, noting the outcome. */
async function tryImage(session: Session, url: string): Promise<{ src: string; from: string } | null> {
  const got = await get(session, url, 'image/svg+xml,image/png,image/webp,image/*;q=0.8', MAX_LOGO_BYTES)
  if (!got.ok) {
    session.steps.push({ url: short(url), result: got.reason })
    return null
  }
  const checked = checkImage(got.bytes)
  if (!checked.ok) {
    session.steps.push({ url: short(url), result: checked.reason })
    return null
  }
  session.steps.push({ url: short(url), result: 'Found' })
  return { src: checked.src, from: got.url === 'data:' ? url.slice(0, 64) : got.url }
}

async function fromManifest(session: Session, origin: string): Promise<FoundLogo | null> {
  const address = origin + PROVIDER_MANIFEST_PATH
  const got = await get(session, address, 'application/json', MAX_MANIFEST_BYTES)
  if (!got.ok) {
    session.steps.push({ url: address, result: got.reason })
    return null
  }
  const manifest = readManifest(new TextDecoder().decode(got.bytes), got.url)
  if ('problem' in manifest) {
    session.steps.push({ url: address, result: manifest.problem })
    return null
  }
  session.steps.push({ url: address, result: manifest.name ? `Manifest for ${manifest.name}` : 'Manifest' })
  const logo = await tryImage(session, manifest.logo)
  if (!logo) return null
  const dark = manifest.dark ? await tryImage(session, manifest.dark) : null
  return { src: logo.src, from: address, ...(dark ? { dark: dark.src } : {}), ...(manifest.name ? { name: manifest.name } : {}) }
}

async function fromHomePage(session: Session, origin: string): Promise<FoundLogo | null> {
  const address = `${origin}/`
  const got = await get(session, address, 'text/html', MAX_PAGE_BYTES)
  if (!got.ok) {
    session.steps.push({ url: address, result: got.reason })
    return null
  }
  const { icons, manifest } = pageIcons(new TextDecoder().decode(got.bytes), got.url)
  let candidates = icons
  if (manifest) {
    const web = await get(session, manifest, 'application/manifest+json,application/json', MAX_MANIFEST_BYTES)
    if (web.ok) candidates = rankIcons([...icons, ...manifestIcons(new TextDecoder().decode(web.bytes), web.url)])
  }
  if (candidates.length === 0) {
    session.steps.push({ url: address, result: 'The page declares no icons' })
    return null
  }
  session.steps.push({ url: address, result: `The page declares ${candidates.length} icon${candidates.length === 1 ? '' : 's'}` })
  // The best few; a page that lists twenty sizes doesn't get twenty requests.
  for (const candidate of candidates.slice(0, 4)) {
    const logo = await tryImage(session, candidate.url)
    if (logo) return { src: logo.src, from: logo.from }
  }
  return null
}

/**
 * Looks for a provider's logo from its base URL: its manifest, then its home
 * page's icons, then its favicon, on the API host and then the website.
 * Never throws; `steps` says what was tried, for Settings to show.
 */
export async function discoverLogo(baseUrl: string, deps: LookupDeps = defaultDeps()): Promise<LookupResult> {
  const steps: LogoLookupStep[] = []
  const origins = lookupOrigins(baseUrl)
  if (origins.length === 0) return { logo: null, steps: [{ url: baseUrl || '(none)', result: 'Not a web address' }] }
  const host = new URL(baseUrl).hostname
  const publicOnly = !isPrivateHostname(host) && !(await privateAddressOf(host, deps.resolve))
  const session: Session = { deps, publicOnly, deadline: deps.now() + LOOKUP_BUDGET_MS, steps }
  for (const origin of origins) {
    const logo = await fromManifest(session, origin)
    if (logo) return { logo, steps }
  }
  for (const origin of origins) {
    const logo = await fromHomePage(session, origin)
    if (logo) return { logo, steps }
  }
  for (const origin of origins) {
    const logo = await tryImage(session, `${origin}/favicon.ico`)
    if (logo) return { logo: { src: logo.src, from: logo.from }, steps }
  }
  return { logo: null, steps }
}

/* -------------------------------------------------------------- store */

const isDataImage = (value: unknown): value is string => typeof value === 'string' && value.startsWith('data:image/')

/** The saved records, keeping only what's well formed: a bad entry is dropped, not shown. */
export function readLogos(): ProviderLogos {
  const raw = store.getJson<unknown>(DOC, {})
  const out: ProviderLogos = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const record = value as ProviderLogo
    const clean: ProviderLogo = {}
    if (record.user && isDataImage(record.user.src)) clean.user = { src: record.user.src, setAt: Number(record.user.setAt) || 0 }
    // What was found at Eaon's gateway would name its address, which is never shown (eaonAddress.ts).
    if (record.site && isDataImage(record.site.src) && typeof record.site.baseUrl === 'string' && !isEaonGateway(record.site.baseUrl)) {
      clean.site = {
        src: record.site.src,
        ...(isDataImage(record.site.dark) ? { dark: record.site.dark } : {}),
        from: String(record.site.from ?? ''),
        ...(typeof record.site.name === 'string' ? { name: record.site.name } : {}),
        baseUrl: record.site.baseUrl,
        foundAt: Number(record.site.foundAt) || 0
      }
    }
    if (record.lookup && typeof record.lookup.baseUrl === 'string' && Array.isArray(record.lookup.steps) && !isEaonGateway(record.lookup.baseUrl)) {
      clean.lookup = {
        baseUrl: record.lookup.baseUrl,
        at: Number(record.lookup.at) || 0,
        found: Boolean(record.lookup.found),
        steps: record.lookup.steps
          .filter((step) => typeof step?.url === 'string' && typeof step?.result === 'string')
          .map((step) => ({ url: step.url, result: step.result }))
      }
    }
    if (clean.user || clean.site || clean.lookup) out[id] = clean
  }
  return out
}

let listener: ((logos: ProviderLogos) => void) | null = null

/** Called with every record after any change (the feature sends them to the windows). */
export function onLogosChanged(fn: (logos: ProviderLogos) => void): void {
  listener = fn
}

function edit(providerId: string, change: (record: ProviderLogo) => ProviderLogo | null): ProviderLogos {
  const logos = readLogos()
  const next = change({ ...logos[providerId] })
  if (next && (next.user || next.site || next.lookup)) logos[providerId] = next
  else delete logos[providerId]
  store.setJson(DOC, logos)
  listener?.(logos)
  return logos
}

/** The person's own image for a provider, from a file's bytes. */
export function setUserLogo(providerId: string, bytes: Uint8Array): { ok: true; logos: ProviderLogos } | { ok: false; reason: string } {
  const checked = checkImage(bytes)
  if (!checked.ok) return checked
  return { ok: true, logos: edit(providerId, (record) => ({ ...record, user: { src: checked.src, setAt: Date.now() } })) }
}

/** Back to the built-in logo, or the one found, or initials. */
export function clearUserLogo(providerId: string): ProviderLogos {
  return edit(providerId, ({ user: _user, ...rest }) => rest)
}

/** A provider that was deleted takes its logos with it. */
export function forgetLogo(providerId: string): void {
  if (readLogos()[providerId]) edit(providerId, () => null)
}

const running = new Map<string, Promise<ProviderLogos>>()

/**
 * Looks up a provider's logo from its base URL now and keeps what's found.
 * One that turns up nothing keeps the logo it had for the same base URL (the
 * site may just be down); a different base URL drops it.
 */
export function lookUpLogo(providerId: string, deps?: LookupDeps): Promise<ProviderLogos> {
  const pending = running.get(providerId)
  if (pending) return pending
  const work = (async () => {
    const provider = getProvider(providerId)
    if (!provider || isEaonGateway(provider.baseUrl)) return readLogos()
    const baseUrl = provider.baseUrl.trim()
    const { logo, steps } = baseUrl ? await discoverLogo(baseUrl, deps) : { logo: null, steps: [{ url: '(none)', result: 'The provider has no base URL' }] }
    const at = (deps ?? defaultDeps()).now()
    return edit(providerId, (record) => {
      const keep = record.site && record.site.baseUrl === baseUrl ? record.site : undefined
      const site = logo ? { ...logo, baseUrl, foundAt: at } : keep
      return { ...(record.user ? { user: record.user } : {}), ...(site ? { site } : {}), lookup: { baseUrl, at, found: Boolean(logo), steps } }
    })
  })().finally(() => running.delete(providerId))
  running.set(providerId, work)
  return work
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** A custom provider's base URL was saved: look its logo up shortly (a burst of saves looks once). */
export function noteBaseUrlChanged(providerId: string): void {
  const provider = getProvider(providerId)
  if (!provider || provider.builtIn) return
  clearTimeout(timers.get(providerId))
  timers.set(
    providerId,
    setTimeout(() => {
      timers.delete(providerId)
      void lookUpLogo(providerId)
    }, 1_500)
  )
}

/** Whether a custom provider is due a look-up: never looked up for this base URL, or not for a while. */
export function lookupDue(record: ProviderLogo | undefined, baseUrl: string, now: number): boolean {
  const lookup = record?.lookup
  if (!lookup || lookup.baseUrl !== baseUrl) return true
  return now - lookup.at > (lookup.found ? REFRESH_FOUND_MS : REFRESH_MISSING_MS)
}

let sweeping: Promise<void> | null = null

/**
 * Looks up every custom provider that is due, one at a time: at startup, now
 * and then, and when Settings lists the logos, so a provider added from the
 * Eaon CLI gets its logo too.
 */
export function sweepLogos(): Promise<void> {
  sweeping ??= (async () => {
    const logos = readLogos()
    const now = Date.now()
    for (const provider of listProviders()) {
      if (provider.builtIn || !provider.baseUrl.trim() || isEaonGateway(provider.baseUrl)) continue
      if (lookupDue(logos[provider.id], provider.baseUrl.trim(), now)) await lookUpLogo(provider.id).catch(() => undefined)
    }
  })().finally(() => {
    sweeping = null
  })
  return sweeping
}

/** Stops the pending look-ups' timers (quitting). */
export function stopLogoTimers(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}
