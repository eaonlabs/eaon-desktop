import { createHmac, randomUUID } from 'node:crypto'
import { baseDomain, domainsFrom, hostMatches, loginsFromAppleCsv, siteFrom, type VaultLogin, type VaultLoginDraft, type VaultPasskey, type VaultState } from '@shared/workerVault'

/**
 * The workers' password vault (shared/workerVault.ts): logins, the secrets
 * behind their 2FA codes, and the passkeys workers made on the user's
 * accounts. All of it is one entry in the encrypted secrets vault; this
 * module is the only thing that reads the passwords and keys, and it hands
 * them only to the worker's browser, for the website they belong to.
 */

/** A login as stored: what the renderer sees plus the secrets. */
interface StoredLogin extends VaultLogin {
  password: string
  /** The base32 secret behind its 2FA codes, and how they are made. */
  totp: { secret: string; digits: number; period: number; algorithm: 'SHA1' | 'SHA256' | 'SHA512' } | null
}

/**
 * A passkey as stored: a WebAuthn credential exactly as Chromium's virtual
 * authenticator exports it (CDP WebAuthn.Credential), so it can be given
 * back to the worker's browser on its next start.
 */
export interface PasskeyCredential {
  credentialId: string
  isResidentCredential: boolean
  rpId: string
  /** PKCS#8, base64. */
  privateKey: string
  userHandle?: string
  signCount: number
  userName?: string
  userDisplayName?: string
}
interface StoredPasskey extends VaultPasskey {
  credential: PasskeyCredential
}

interface Stored {
  logins: StoredLogin[]
  passkeys: StoredPasskey[]
}

export interface VaultDeps {
  load: () => string | undefined
  save: (value: string) => void
  onChange?: (state: VaultState) => void
  now?: () => number
}

const MAX_LOGINS = 500
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/* ------------------------------------------------------------ 2FA codes (RFC 6238) */

function base32(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('That isn’t a 2FA secret. Paste the setup key the site shows (letters A–Z and digits 2–7), or its otpauth:// link.')
  let bits = ''
  for (const c of clean) bits += alphabet.indexOf(c).toString(2).padStart(5, '0')
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/** A 2FA setup: an otpauth://totp/… link (as a QR code holds) or a bare base32 key. */
export function parseTotp(text: string): StoredLogin['totp'] {
  const value = text.trim()
  if (!value) return null
  if (/^otpauth:\/\//i.test(value)) {
    const url = new URL(value)
    if (url.host.toLowerCase() !== 'totp') throw new Error('Only time-based (TOTP) codes are supported.')
    const secret = url.searchParams.get('secret') ?? ''
    base32(secret)
    const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase()
    return {
      secret: secret.toUpperCase().replace(/\s/g, ''),
      digits: Number(url.searchParams.get('digits')) || 6,
      period: Number(url.searchParams.get('period')) || 30,
      algorithm: algorithm === 'SHA256' || algorithm === 'SHA512' ? algorithm : 'SHA1'
    }
  }
  base32(value)
  return { secret: value.toUpperCase().replace(/[\s-]/g, ''), digits: 6, period: 30, algorithm: 'SHA1' }
}

/** The code a 2FA app would show at `at`. */
export function totpCode(totp: NonNullable<StoredLogin['totp']>, at: number): string {
  const counter = Math.floor(at / 1000 / totp.period)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac(totp.algorithm.toLowerCase(), base32(totp.secret)).update(message).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const value = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]
  return String(value % 10 ** totp.digits).padStart(totp.digits, '0')
}

/* ------------------------------------------------------------ the vault */

export function createVault(deps: VaultDeps) {
  const now = deps.now ?? Date.now
  const read = (): Stored => {
    // Outside the try: a locked vault (vaultSeal.ts) must stop here, not read as an empty one a save then writes over.
    const raw = deps.load()
    try {
      const value = JSON.parse(raw ?? 'null') as Partial<Stored> | null
      return { logins: Array.isArray(value?.logins) ? value.logins : [], passkeys: Array.isArray(value?.passkeys) ? value.passkeys : [] }
    } catch {
      return { logins: [], passkeys: [] }
    }
  }
  const publicLogin = ({ password, totp, ...login }: StoredLogin): VaultLogin => ({ ...login, hasPassword: Boolean(password), hasCode: Boolean(totp) })
  const publicPasskey = ({ credential: _key, ...passkey }: StoredPasskey): VaultPasskey => passkey
  const state = (stored = read()): VaultState => ({ logins: stored.logins.map(publicLogin), passkeys: stored.passkeys.map(publicPasskey) })
  const write = (stored: Stored): void => {
    deps.save(JSON.stringify(stored))
    deps.onChange?.(state(stored))
  }
  const allowed = (login: Pick<VaultLogin, 'workers'>, workerId: string): boolean => login.workers === 'all' || login.workers.includes(workerId)

  /** The websites a draft names: what it gave, else its site read as a domain or a name Eaon knows. */
  const domainsOf = (draft: VaultLoginDraft): string[] => {
    const given = (draft.domains ?? []).flatMap((d) => domainsFrom(d))
    if (given.length) return [...new Set(given)]
    const fromSite = domainsFrom(draft.site)
    if (fromSite.length) return fromSite
    return siteFrom(draft.site)?.domains ?? []
  }

  return {
    state: (): VaultState => state(),

    /** Adds or replaces a login. A login for the same website and username is updated rather than duplicated. */
    saveLogin(draft: VaultLoginDraft): VaultLogin {
      const stored = read()
      const domains = domainsOf(draft)
      if (domains.length === 0) throw new Error(`Which website is “${str(draft.site) || 'this'}” for? Give its address, like netflix.com.`)
      const username = str(draft.username).slice(0, 200)
      const existing =
        (draft.id ? stored.logins.find((l) => l.id === draft.id) : undefined) ??
        stored.logins.find((l) => l.username.toLowerCase() === username.toLowerCase() && l.domains.some((d) => domains.includes(d)))
      const password = draft.password ?? existing?.password ?? ''
      if (!password) throw new Error('Type the password.')
      if (password.length > 512) throw new Error('That password is too long.')
      const totp = draft.code === undefined ? (existing?.totp ?? null) : parseTotp(draft.code)
      const workers = draft.workers === 'all' ? 'all' : [...new Set((Array.isArray(draft.workers) ? draft.workers : []).filter((w) => typeof w === 'string' && w))]
      if (workers !== 'all' && workers.length === 0) throw new Error('Choose at least one worker who may use it.')
      const at = now()
      const login: StoredLogin = {
        id: existing?.id ?? randomUUID(),
        site: str(draft.site).slice(0, 80) || existing?.site || domains[0],
        domains,
        username,
        password,
        totp,
        hasPassword: true,
        hasCode: Boolean(totp),
        workers,
        ask: draft.ask ?? existing?.ask ?? false,
        source: existing?.source ?? draft.source ?? 'manual',
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        lastUsedAt: existing?.lastUsedAt ?? null
      }
      if (!existing && stored.logins.length >= MAX_LOGINS) throw new Error(`The vault holds up to ${MAX_LOGINS} logins.`)
      stored.logins = existing ? stored.logins.map((l) => (l.id === existing.id ? login : l)) : [...stored.logins, login]
      write(stored)
      return publicLogin(login)
    },

    removeLogin(id: string): void {
      const stored = read()
      stored.logins = stored.logins.filter((l) => l.id !== id)
      write(stored)
    },

    /** Changes who may use a login, and whether each use waits for the user. */
    setAccess(id: string, access: { workers?: 'all' | string[]; ask?: boolean }): void {
      const stored = read()
      const login = stored.logins.find((l) => l.id === id)
      if (!login) throw new Error('That login isn’t in the vault any more.')
      if (access.workers !== undefined) login.workers = access.workers === 'all' ? 'all' : [...new Set(access.workers)]
      if (access.ask !== undefined) login.ask = access.ask
      login.updatedAt = now()
      write(stored)
    },

    /** Logins this worker may use, as the model may see them. */
    loginsFor(workerId: string): VaultLogin[] {
      return read().logins.filter((l) => allowed(l, workerId)).map(publicLogin)
    },

    /**
     * The login for a page, for this worker: one whose websites the page is
     * on (the most specific match first). With `site`, only one whose name
     * or websites match it. Null when there is none it may use.
     */
    match(workerId: string, pageUrl: string, site = ''): (VaultLogin & { password: string; code: () => string | null }) | null {
      let host: string
      try {
        const url = new URL(pageUrl)
        if (url.protocol !== 'https:') return null
        host = url.hostname
      } catch {
        return null
      }
      const wanted = site.toLowerCase()
      const candidates = read()
        .logins.filter((l) => allowed(l, workerId) && hostMatches(host, l.domains))
        .filter((l) => !wanted || l.site.toLowerCase().includes(wanted) || l.domains.some((d) => d.includes(wanted) || wanted.includes(d)) || l.username.toLowerCase() === wanted)
        .sort((a, b) => Math.max(...b.domains.map((d) => (hostMatches(host, [d]) ? d.length : 0))) - Math.max(...a.domains.map((d) => (hostMatches(host, [d]) ? d.length : 0))))
      const login = candidates[0]
      if (!login) return null
      return { ...publicLogin(login), password: login.password, code: () => (login.totp ? totpCode(login.totp, now()) : null) }
    },

    /** Records that a login was used just now. */
    used(id: string): void {
      const stored = read()
      const login = stored.logins.find((l) => l.id === id)
      if (!login) return
      login.lastUsedAt = now()
      write(stored)
    },

    /**
     * The logins in an export from Apple's Passwords app, added for the given
     * workers. Ones already saved (same website and username) are updated.
     */
    importApple(csv: string, workers: 'all' | string[]): { added: number; updated: number; skipped: number } {
      const rows = loginsFromAppleCsv(csv)
      let added = 0
      let updated = 0
      let skipped = 0
      for (const row of rows) {
        const before = read().logins.length
        try {
          this.saveLogin({ site: row.site, domains: row.domains, username: row.username, password: row.password, code: row.code || undefined, workers, source: 'apple' })
          if (read().logins.length > before) added++
          else updated++
        } catch {
          skipped++
        }
      }
      return { added, updated, skipped }
    },

    /* ---------------------------------------------------------- passkeys */

    /** A passkey a worker's browser just made on a website. */
    addPasskey(workerId: string, credential: PasskeyCredential): VaultPasskey {
      const stored = read()
      const at = now()
      const existing = stored.passkeys.find((p) => p.credential.credentialId === credential.credentialId)
      const passkey: StoredPasskey = {
        id: existing?.id ?? randomUUID(),
        rpId: credential.rpId,
        userName: credential.userName || credential.userDisplayName || existing?.userName || '',
        workerId,
        createdAt: existing?.createdAt ?? at,
        lastUsedAt: existing?.lastUsedAt ?? null,
        credential
      }
      stored.passkeys = existing ? stored.passkeys.map((p) => (p.id === existing.id ? passkey : p)) : [...stored.passkeys, passkey]
      write(stored)
      return publicPasskey(passkey)
    },

    /** A passkey was used to sign in: its counter moves on, so the next sign-in isn't refused as a replay. */
    passkeyUsed(credentialId: string, signCount: number): void {
      const stored = read()
      const passkey = stored.passkeys.find((p) => p.credential.credentialId === credentialId)
      if (!passkey) return
      passkey.credential = { ...passkey.credential, signCount: Math.max(passkey.credential.signCount, signCount) }
      passkey.lastUsedAt = now()
      write(stored)
    },

    removePasskey(id: string): void {
      const stored = read()
      stored.passkeys = stored.passkeys.filter((p) => p.id !== id)
      write(stored)
    },

    /** The passkeys a worker's browser holds, to give back to it when it starts. */
    passkeyCredentials(workerId: string): PasskeyCredential[] {
      return read()
        .passkeys.filter((p) => p.workerId === workerId)
        .map((p) => p.credential)
    },

    passkeysFor(workerId: string): VaultPasskey[] {
      return read()
        .passkeys.filter((p) => p.workerId === workerId)
        .map(publicPasskey)
    },

    /**
     * A worker was removed: its own passkeys go (its browser, which held
     * them, is gone too) and it comes off the logins it was given. The logins
     * themselves stay — they are the user's — even with nobody left to use them.
     */
    forgetWorker(workerId: string): void {
      const stored = read()
      stored.passkeys = stored.passkeys.filter((p) => p.workerId !== workerId)
      stored.logins = stored.logins.map((l) => (l.workers === 'all' ? l : { ...l, workers: l.workers.filter((w) => w !== workerId) }))
      write(stored)
    }
  }
}

export type Vault = ReturnType<typeof createVault>

/** The site name for a website, for messages: "chase.com". */
export const siteLabel = (host: string): string => baseDomain(host)
