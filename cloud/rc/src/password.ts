import { b64url, fromB64url, same } from './auth'

/**
 * The cryptography behind password sign-in (passwords.ts): hashing, the rules
 * a new password must meet, and 2-step codes (TOTP, RFC 6238, the kind any
 * authenticator app reads from a QR code).
 *
 * A password is hashed with PBKDF2-SHA256 over an HMAC of it keyed with
 * PASSWORD_PEPPER, a Worker secret. Stolen storage alone (without the
 * secret) can't be guessed against, and with it every guess still costs
 * 100,000 rounds. 2-step secrets are kept sealed with AES-GCM under a key
 * from the same secret.
 */

const enc = new TextEncoder()

export const MIN_LENGTH = 12
export const MAX_LENGTH = 256
/** The most PBKDF2 rounds Workers allow. */
export const ITERATIONS = 100_000

export interface PasswordHash {
  iter: number
  salt: string
  hash: string
}

const hmac = async (key: Uint8Array, data: Uint8Array, hash = 'SHA-256'): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash }, false, ['sign']), data))

async function derive(pepper: string, password: string, salt: Uint8Array, iter: number): Promise<string> {
  const peppered = await hmac(enc.encode(pepper), enc.encode(password.normalize('NFKC')))
  const key = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits'])
  return b64url(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256))
}

export async function hashPassword(pepper: string, password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return { iter: ITERATIONS, salt: b64url(salt), hash: await derive(pepper, password, salt, ITERATIONS) }
}

export async function checkPassword(pepper: string, password: string, stored: PasswordHash): Promise<boolean> {
  return same(await derive(pepper, password, fromB64url(stored.salt), stored.iter), stored.hash)
}

/** A username that has no password still costs a full hash, so it answers as slowly as one that does. */
const DUMMY: PasswordHash = { iter: ITERATIONS, salt: 'AAAAAAAAAAAAAAAAAAAAAA', hash: 'A'.repeat(43) }
export const checkNothing = (pepper: string, password: string): Promise<boolean> => checkPassword(pepper, password, DUMMY).then(() => false)

/** Why a new password can't be used, or null. Length over rules: no "one capital, one symbol". */
export function passwordProblem(password: string, login: string): string | null {
  if (password.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`
  if (password.length > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters.`
  if (new Set(password).size < 5) return 'That password repeats too few characters. Try a few unrelated words.'
  if (password.toLowerCase().includes(login.toLowerCase())) return 'Don’t put your username in your password.'
  return null
}

/**
 * Whether a password is in Have I Been Pwned's list of leaked passwords. Only
 * the first 5 characters of its SHA-1 leave the Worker (k-anonymity), and the
 * answer is padded so its size gives nothing away. If the service can't be
 * reached, the password isn't refused for it.
 */
export async function leaked(password: string): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', enc.encode(password)))
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${hex.slice(0, 5)}`, { headers: { 'Add-Padding': 'true', 'User-Agent': 'eaon-rc' }, signal: AbortSignal.timeout(3000) })
    if (!res.ok) return false
    const rest = hex.slice(5)
    return (await res.text()).split('\n').some((line) => {
      const [suffix, count] = line.trim().split(':')
      return suffix === rest && Number(count) > 0
    })
  } catch {
    return false
  }
}

// ---- 2-step codes

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_S = 30

export function toBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function fromBase32(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const c of clean) {
    value = (value << 5) | BASE32.indexOf(c)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

export const newTotpSecret = (): Uint8Array => crypto.getRandomValues(new Uint8Array(20))

/** The 6-digit code for one 30-second step. */
export async function totpCode(secret: Uint8Array, step: number): Promise<string> {
  const counter = new Uint8Array(8)
  new DataView(counter.buffer).setBigUint64(0, BigInt(step))
  const mac = await hmac(secret, counter, 'SHA-1')
  const offset = mac[19] & 15
  const n = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(n % 1_000_000).padStart(6, '0')
}

/**
 * The step a code belongs to, allowing one step either side for a phone's
 * clock, or null. A step at or before `usedStep` never counts again, so a
 * code seen over someone's shoulder can't be replayed.
 */
export async function totpStep(secret: Uint8Array, code: string, now: number, usedStep: number): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null
  const current = Math.floor(now / 1000 / STEP_S)
  for (const step of [current - 1, current, current + 1]) {
    if (step > usedStep && same(await totpCode(secret, step), code)) return step
  }
  return null
}

export const otpauthUri = (secret: Uint8Array, login: string): string =>
  `otpauth://totp/${encodeURIComponent(`Eaon Remote:${login}`)}?secret=${toBase32(secret)}&issuer=${encodeURIComponent('Eaon Remote')}&algorithm=SHA1&digits=6&period=${STEP_S}`

async function sealKey(pepper: string): Promise<CryptoKey> {
  const raw = await hmac(enc.encode(pepper), enc.encode('rc 2-step secrets'))
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function seal(pepper: string, secret: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const box = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(pepper), secret))
  return `${b64url(iv)}.${b64url(box)}`
}

export async function unseal(pepper: string, sealed: string): Promise<Uint8Array> {
  const [iv, box] = sealed.split('.')
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) }, await sealKey(pepper), fromB64url(box)))
}
