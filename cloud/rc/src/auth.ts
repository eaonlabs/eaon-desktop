/**
 * Who is signed in: a GitHub account, kept in an HttpOnly cookie signed with
 * SESSION_SECRET (HMAC-SHA256). The account is always a GitHub one, signed in
 * either through GitHub or with the password set for it (passwords.ts).
 *
 * Nothing about a GitHub session is stored server-side, so signing those out
 * everywhere means rotating the secret. A password session also carries the
 * account's session version, checked on every request: changing the password
 * or 2-step signs out every password session at once.
 */

export interface Env {
  ASSETS: Fetcher
  ACCOUNTS: DurableObjectNamespace
  LINKS: DurableObjectNamespace
  PASSWORDS: DurableObjectNamespace
  THROTTLE: DurableObjectNamespace
  PUBLIC_URL: string
  SESSION_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  /** Keys password hashes and seals 2-step secrets (password.ts). Unset: no password sign-in. */
  PASSWORD_PEPPER?: string
  /** "1" only in `wrangler dev`: /auth/dev signs in without GitHub. */
  DEV_LOGIN?: string
}

export interface User {
  /** GitHub's numeric user id, as text: stable across renames. */
  uid: string
  login: string
  avatar: string
}

export const SESSION_COOKIE = 'rc_session'
export const STATE_COOKIE = 'rc_oauth'
const SESSION_DAYS = 30
/** Changing how you sign in needs a GitHub sign-in this recent. */
const FRESH_MS = 10 * 60_000

export type Via = 'github' | 'password'

interface Session extends User {
  exp: number
  /** When it was signed in (sessions from before this field count as not fresh). */
  at?: number
  via?: Via
  /** A password session's account session version (passwords.ts). */
  v?: number
}

const enc = new TextEncoder()

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of arr) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/** `payload.signature`, both base64url. */
export async function sign(secret: string, value: unknown): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(value)))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload))
  return `${payload}.${b64url(sig)}`
}

export async function verify<T>(secret: string, token: string | null | undefined): Promise<T | null> {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(token.slice(dot + 1)), enc.encode(payload))
    if (!ok) return null
    return JSON.parse(new TextDecoder().decode(fromB64url(payload))) as T
  } catch {
    return null
  }
}

export async function sha256(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)))
}

/** Constant-time comparison of two strings of the same kind. */
export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function cookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? ''
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

export function setCookie(env: Env, name: string, value: string, maxAgeS: number): string {
  const secure = env.PUBLIC_URL.startsWith('https://') ? '; Secure' : ''
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`
}

export async function sessionCookie(env: Env, user: User, via: Via = 'github', version?: number): Promise<string> {
  const now = Date.now()
  const value: Session = { ...user, exp: now + SESSION_DAYS * 86_400_000, at: now, via, ...(via === 'password' ? { v: version } : {}) }
  return setCookie(env, SESSION_COOKIE, await sign(env.SESSION_SECRET, value), SESSION_DAYS * 86_400)
}

/** The account's password and 2-step state (passwords.ts). */
export const passwordsOf = (env: Env, uid: string): DurableObjectStub => env.PASSWORDS.get(env.PASSWORDS.idFromName(`uid:${uid}`))

async function session(env: Env, request: Request): Promise<Session | null> {
  const value = await verify<Session>(env.SESSION_SECRET, cookie(request, SESSION_COOKIE))
  if (!value || typeof value.exp !== 'number' || value.exp < Date.now()) return null
  if (value.via === 'password') {
    const owner = (await (await passwordsOf(env, value.uid).fetch('https://do/owner')).json()) as { version: number }
    if (owner.version !== value.v) return null
  }
  return value
}

export async function currentUser(env: Env, request: Request): Promise<User | null> {
  const value = await session(env, request)
  return value ? { uid: value.uid, login: value.login, avatar: value.avatar } : null
}

/** Signed in through GitHub in the last few minutes: what setting a password or 2-step needs. */
export async function freshFromGitHub(env: Env, request: Request): Promise<boolean> {
  const value = await session(env, request)
  return !!value && value.via !== 'password' && typeof value.at === 'number' && Date.now() - value.at < FRESH_MS
}

/**
 * A state-changing request from the web app must come from the web app: the
 * cookie is SameSite=Lax, and the Origin (always sent on POST and WebSocket
 * upgrades by browsers) must be ours.
 */
export function sameOrigin(env: Env, request: Request): boolean {
  const origin = request.headers.get('Origin')
  return origin === new URL(env.PUBLIC_URL).origin
}

/** Where to go after signing in: a path on this site only, never another host. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'
}
