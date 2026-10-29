import { WORKER_APPS } from './workerApps'

/**
 * The workers' password vault: logins (a website, a username, a password and
 * optionally the secret behind its 2FA codes) and passkeys a worker made on
 * the user's accounts. Main keeps them in the encrypted secrets vault; the
 * renderer and the model only ever see what is here — the website, the
 * username, who may use it — never a password, a 2FA secret or a key.
 *
 * A worker uses a login by asking Eaon to sign it in on the page it has open
 * (sign_in_saved): Eaon types it there only if that page is on the login's
 * own website, so a page pretending to be the bank gets nothing. A passkey
 * is answered by the worker's browser itself, and only the website that made
 * it can ever ask for it.
 */

/** A saved login as the renderer and the model see it. */
export interface VaultLogin {
  id: string
  /** "Netflix", "chase.com" — what the user calls it. */
  site: string
  /** The websites it may be typed into (subdomains included): ["netflix.com"]. */
  domains: string[]
  username: string
  hasPassword: boolean
  /** It has a 2FA secret, so Eaon can make the six-digit codes. */
  hasCode: boolean
  /** Who may use it: every worker, or these worker ids. */
  workers: 'all' | string[]
  /** Each use waits for the user's OK. */
  ask: boolean
  source: 'manual' | 'chat' | 'sign-in' | 'apple'
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

/** A passkey a worker made on one of the user's accounts, as the renderer sees it. */
export interface VaultPasskey {
  id: string
  /** The website it belongs to (its WebAuthn relying party): "github.com". */
  rpId: string
  /** The account it signs in as, as the website named it. */
  userName: string
  /** The worker whose browser holds it. */
  workerId: string
  createdAt: number
  lastUsedAt: number | null
}

export interface VaultState {
  logins: VaultLogin[]
  passkeys: VaultPasskey[]
}

/** What the vault page, the chat's save dialog and the sign-in sheet send to save a login. */
export interface VaultLoginDraft {
  id?: string
  site: string
  domains?: string[]
  username: string
  /** Absent on an edit that keeps the saved one. */
  password?: string
  /** An otpauth:// address or the base32 secret a site shows when setting up an authenticator app. "" removes it. */
  code?: string
  workers: 'all' | string[]
  ask?: boolean
  source?: VaultLogin['source']
}

/* ------------------------------------------------------------ websites */

interface KnownSite {
  name: string
  domains: string[]
  /** Other names people use ("gmail" for Google). */
  aliases?: string[]
}

/** Popular sites by the names people call them, besides the workers' apps. */
const POPULAR: KnownSite[] = [
  { name: 'Netflix', domains: ['netflix.com'] },
  { name: 'Spotify', domains: ['spotify.com'] },
  { name: 'Hulu', domains: ['hulu.com'] },
  { name: 'Disney+', domains: ['disneyplus.com'], aliases: ['disney plus'] },
  { name: 'Max', domains: ['max.com'], aliases: ['hbo max', 'hbo'] },
  { name: 'YouTube', domains: ['youtube.com', 'google.com'] },
  { name: 'Google', domains: ['google.com'], aliases: ['gmail', 'google account'] },
  { name: 'Apple', domains: ['apple.com', 'icloud.com'], aliases: ['icloud', 'apple id', 'apple account'] },
  { name: 'Microsoft', domains: ['microsoft.com', 'live.com', 'outlook.com'], aliases: ['outlook', 'hotmail', 'xbox'] },
  { name: 'Yahoo', domains: ['yahoo.com'] },
  { name: 'Proton', domains: ['proton.me'], aliases: ['protonmail'] },
  { name: 'Facebook', domains: ['facebook.com'] },
  { name: 'Instagram', domains: ['instagram.com'] },
  { name: 'X', domains: ['x.com', 'twitter.com'], aliases: ['twitter'] },
  { name: 'LinkedIn', domains: ['linkedin.com'] },
  { name: 'Reddit', domains: ['reddit.com'] },
  { name: 'TikTok', domains: ['tiktok.com'] },
  { name: 'Pinterest', domains: ['pinterest.com'] },
  { name: 'GitHub', domains: ['github.com'] },
  { name: 'Slack', domains: ['slack.com'] },
  { name: 'Discord', domains: ['discord.com'] },
  { name: 'Zoom', domains: ['zoom.us'] },
  { name: 'Notion', domains: ['notion.so'] },
  { name: 'Dropbox', domains: ['dropbox.com'] },
  { name: 'Adobe', domains: ['adobe.com'] },
  { name: 'Canva', domains: ['canva.com'] },
  { name: 'Figma', domains: ['figma.com'] },
  { name: 'Airbnb', domains: ['airbnb.com'] },
  { name: 'Booking.com', domains: ['booking.com'], aliases: ['booking'] },
  { name: 'Expedia', domains: ['expedia.com'] },
  { name: 'United', domains: ['united.com'], aliases: ['united airlines'] },
  { name: 'Delta', domains: ['delta.com'], aliases: ['delta airlines'] },
  { name: 'American Airlines', domains: ['aa.com'] },
  { name: 'Southwest', domains: ['southwest.com'] },
  { name: 'Grubhub', domains: ['grubhub.com'] },
  { name: 'Costco', domains: ['costco.com'] },
  { name: 'Best Buy', domains: ['bestbuy.com'] },
  { name: 'Home Depot', domains: ['homedepot.com'] },
  { name: 'eBay', domains: ['ebay.com'] },
  { name: 'Etsy', domains: ['etsy.com'] },
  { name: 'PayPal', domains: ['paypal.com'] },
  { name: 'Chase', domains: ['chase.com'] },
  { name: 'Bank of America', domains: ['bankofamerica.com'], aliases: ['bofa'] },
  { name: 'Wells Fargo', domains: ['wellsfargo.com'] },
  { name: 'Capital One', domains: ['capitalone.com'] },
  { name: 'American Express', domains: ['americanexpress.com'], aliases: ['amex'] },
  { name: 'Citi', domains: ['citi.com'], aliases: ['citibank'] },
  { name: 'Discover', domains: ['discover.com'] },
  { name: 'Coinbase', domains: ['coinbase.com'] },
  { name: 'Robinhood', domains: ['robinhood.com'] },
  { name: 'Fidelity', domains: ['fidelity.com'] },
  { name: 'Schwab', domains: ['schwab.com'], aliases: ['charles schwab'] },
  { name: 'Vanguard', domains: ['vanguard.com'] },
  { name: 'Verizon', domains: ['verizon.com'] },
  { name: 'AT&T', domains: ['att.com'], aliases: ['att'] },
  { name: 'T-Mobile', domains: ['t-mobile.com'], aliases: ['tmobile'] },
  { name: 'Xfinity', domains: ['xfinity.com'], aliases: ['comcast'] },
  { name: 'Nest', domains: ['google.com'], aliases: ['google nest'] }
]

/** Every site Eaon knows by name: the workers' apps, then the popular list. */
export const KNOWN_SITES: KnownSite[] = [
  ...WORKER_APPS.filter((a) => a.domains.length > 0).map((a) => ({ name: a.name, domains: a.domains })),
  ...POPULAR
]

const TLDS = 'com|net|org|io|co|app|dev|me|us|uk|ca|de|fr|ai|so|tv|gov|edu|info|biz|shop|store|bank|cash|xyz'
const DOMAIN = new RegExp(`\\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS}))\\b`, 'i')
const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/i

/** The registrable part of a host: "secure.chase.com" → "chase.com" ("co.uk"-style suffixes kept whole). */
export function baseDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  const second = parts[parts.length - 2]
  return (second.length <= 3 && ['co', 'com', 'org', 'net', 'gov', 'ac'].includes(second) ? parts.slice(-3) : parts.slice(-2)).join('.')
}

/**
 * Which website some text is about: a web address or domain in it, else the
 * name of a site Eaon knows ("my Netflix login", "for chase"). Null when it
 * can't tell — the save dialog then asks.
 */
export function siteFrom(text: string): { name: string; domains: string[] } | null {
  const lower = text.toLowerCase()
  // An email's domain is where the email lives, not the site the login is for.
  const withoutEmails = lower.replace(new RegExp(EMAIL.source, 'gi'), ' ')
  const domain = DOMAIN.exec(withoutEmails)?.[1]
  if (domain) {
    const base = baseDomain(domain)
    const known = KNOWN_SITES.find((s) => s.domains.includes(base))
    return { name: known?.name ?? base, domains: known?.domains ?? [base] }
  }
  // Longest names first, so "Uber Eats" isn't taken for "Uber".
  const names = KNOWN_SITES.flatMap((s) => [s.name, ...(s.aliases ?? [])].map((n) => ({ n: n.toLowerCase(), site: s }))).sort((a, b) => b.n.length - a.n.length)
  for (const { n, site } of names) {
    if (n.length < 2) continue
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(withoutEmails)) return { name: site.name, domains: site.domains }
  }
  return null
}

/** Domains a user typed for a login ("chase.com, chase.co.uk", "https://www.netflix.com/login"), cleaned. */
export function domainsFrom(text: string): string[] {
  const out = new Set<string>()
  for (const raw of text.split(/[\s,]+/)) {
    let host = raw.trim().toLowerCase()
    if (!host) continue
    try {
      if (/^https?:\/\//.test(host)) host = new URL(host).hostname
    } catch {
      continue
    }
    host = host.replace(/\/.*$/, '').replace(/^www\./, '')
    if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) out.add(baseDomain(host))
  }
  return [...out]
}

/* ------------------------------------------------------------ passwords in a message */

export interface FoundLogin {
  site: { name: string; domains: string[] } | null
  username: string
  password: string
  /** The message with the password taken out, to send instead. */
  redacted: string
}

/** A quoted password, taken whole — spaces and all: password "correct horse battery". */
const QUOTED_PASSWORD = /\b(?:password|passwd|passcode|pass|pwd|pw)\b\s*(?:is|was|=|:|-|→)?\s*["“'‘]([^"”'’\n]{4,128})["”'’]/i
const KEYWORD_PASSWORD = /\b(?:password|passwd|passcode|pass|pwd|pw)\b\s*(?:is|was|=|:|-|→)?\s*["“'‘]?([^\s"”'’]{4,128})/i
const KEYWORD_USER = /\b(?:username|user\s*name|user|login|email|e-mail|account|id)\b\s*(?:is|=|:|-|→)?\s*["“'‘]?([^\s"”'’,;]{2,128})/i
/** "sam@example.com / hunter22" (or "samlee | hunter22") after a word like login; "login:" itself is a label, not a pair. */
const PAIR_EMAIL = /(\S+@\S+\.\w+)\s*(?:\/|\||:)\s*(\S{4,128})/
const PAIR = /\b([\w.-]{3,64})\s*(?:\/|\|)\s*(\S{4,128})/
const LABELS = /^(login|log|username|user|email|e-mail|account|id|password|pass|pw)$/i

const NOT_A_PASSWORD = /^(is|was|for|the|and|to|of|reset|manager|please|here|below|change|forgot)$/i
/** Sentence punctuation after a password ("…is hunter22.") isn't part of it; the save dialog shows what was taken. */
const trimEnd = (s: string): string => s.replace(/[.,;)\]]+$/, '')

/**
 * A login someone typed into a message ("my Netflix login is sam@x.com,
 * password hunter22"): the site it is for when it can tell, the username,
 * and the password. Null when there is no password in it — an ordinary
 * message, or one that only talks about passwords.
 */
export function findLogin(text: string): FoundLogin | null {
  let password = ''
  let at = -1
  const quoted = QUOTED_PASSWORD.exec(text)
  const keyword = quoted ?? KEYWORD_PASSWORD.exec(text)
  if (keyword && !NOT_A_PASSWORD.test(keyword[1])) {
    password = quoted ? keyword[1] : trimEnd(keyword[1])
    at = keyword.index + keyword[0].lastIndexOf(keyword[1])
  }
  let username = ''
  if (!password && /\b(login|log in|sign in|credentials|account)\b/i.test(text)) {
    const pair = PAIR_EMAIL.exec(text) ?? PAIR.exec(text)
    if (pair && !NOT_A_PASSWORD.test(pair[2]) && !LABELS.test(pair[1])) {
      username = pair[1]
      password = trimEnd(pair[2])
      at = pair.index + pair[0].lastIndexOf(pair[2])
    }
  }
  if (!password || password.length < 4) return null
  if (!username) {
    const email = EMAIL.exec(text)?.[0]
    const user = KEYWORD_USER.exec(text)
    username = email ?? (user && !NOT_A_PASSWORD.test(user[1]) && user[1] !== password ? trimEnd(user[1]) : '')
  }
  const redacted = at >= 0 ? `${text.slice(0, at)}•••• (saved to the vault)${text.slice(at + password.length)}` : text
  return { site: siteFrom(text.replace(password, ' ')), username, password, redacted }
}

/* ------------------------------------------------------------ Apple Passwords export */

/** One row of a CSV file, quotes and doubled quotes handled. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      if (row.some((f) => f !== '')) rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  row.push(field)
  if (row.some((f) => f !== '')) rows.push(row)
  return rows
}

/**
 * The logins in an export from Apple's Passwords app (File → Export All
 * Passwords to File): columns Title, URL, Username, Password, Notes and
 * OTPAuth, found by name so a reordered file still reads. Rows with no
 * website or no password are left out (passkeys aren't in the file at all).
 */
export function loginsFromAppleCsv(text: string): { site: string; domains: string[]; username: string; password: string; code: string }[] {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''))
  if (!header) return []
  const col = (name: string): number => header.findIndex((h) => h.trim().toLowerCase() === name)
  const iTitle = col('title')
  const iUrl = col('url')
  const iUser = col('username')
  const iPass = col('password')
  const iOtp = col('otpauth')
  if (iUrl === -1 || iPass === -1) throw new Error('That isn’t an export from the Passwords app: it needs URL and Password columns.')
  const out: { site: string; domains: string[]; username: string; password: string; code: string }[] = []
  for (const r of rows) {
    const domains = domainsFrom(r[iUrl] ?? '')
    const password = r[iPass] ?? ''
    if (domains.length === 0 || !password) continue
    const title = (iTitle >= 0 ? r[iTitle] : '')?.trim()
    out.push({
      site: title || domains[0],
      domains,
      username: (iUser >= 0 ? r[iUser] : '')?.trim() ?? '',
      password,
      code: (iOtp >= 0 ? r[iOtp] : '')?.trim() ?? ''
    })
  }
  return out
}

/** Whether `host` is one of `domains` or under one. */
export function hostMatches(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return domains.some((d) => h === d || h.endsWith(`.${d}`))
}
