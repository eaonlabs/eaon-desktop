import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * API keys are encrypted with the OS keychain via safeStorage before they touch
 * disk, and are never sent to the renderer — the renderer only ever learns
 * whether a key exists (`hasKey`).
 */

type Vault = Record<string, string>

const fallbackKey = (providerId: string): string => `${providerId}::fallback`

const vaultPath = () => join(app.getPath('userData'), 'keys.dat')

/**
 * Encrypted is the normal case; plaintext is a vault written while encryption
 * was unavailable (Linux without a keyring), which must stay readable once it
 * is. Null when neither decodes.
 */
function decode(raw: Buffer): Vault | null {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return JSON.parse(safeStorage.decryptString(raw)) as Vault
    } catch {
      /* not encrypted with this key — try plaintext */
    }
  }
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Vault
  } catch {
    /* not plaintext either */
  }
  return null
}

/** The vault; null when the file exists but cannot be decoded. */
function read(): Vault | null {
  let raw: Buffer
  try {
    raw = readFileSync(vaultPath())
  } catch (error) {
    // Missing is an empty vault; any other failure (permissions) is unreadable.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null
  }
  return decode(raw)
}

function load(): Vault {
  return read() ?? {}
}

/**
 * The vault to change. A failed read must never be followed by a write, which
 * would replace every saved key with the one being set. While the keychain is
 * unavailable (locked, or access denied) the file is left alone and the save
 * refused. When it is available and the file still won't decode, the file is
 * damaged: it is moved aside, never deleted, and a new vault started.
 */
function loadForWrite(): Vault {
  const vault = read()
  if (vault) return vault
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Eaon can’t unlock its saved keys because the system keychain isn’t available. Unlock it or allow Eaon to use it, then try again.'
    )
  }
  const aside = `${vaultPath()}.unreadable-${Date.now()}`
  renameSync(vaultPath(), aside)
  console.error(`[secrets] keys.dat could not be decrypted; moved it to ${aside} and started a new vault`)
  return {}
}

function persist(vault: Vault): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const json = JSON.stringify(vault)
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8')
  // Replaced whole: a crash mid-write would otherwise leave a vault that can
  // never be decrypted again.
  const tmp = `${vaultPath()}.tmp`
  writeFileSync(tmp, payload)
  renameSync(tmp, vaultPath())
}

export const secrets = {
  set(providerId: string, key: string): void {
    const vault = loadForWrite()
    if (key) vault[providerId] = key
    else delete vault[providerId]
    persist(vault)
  },
  get(providerId: string): string | undefined {
    return load()[providerId]
  },
  has(providerId: string): boolean {
    return Boolean(load()[providerId])
  },
  clear(providerId: string): void {
    const vault = loadForWrite()
    delete vault[providerId]
    delete vault[fallbackKey(providerId)]
    persist(vault)
  },
  /** Last 4 characters, for the "sk-…abcd" hint shown next to a saved key. */
  hint(providerId: string): string | null {
    const key = load()[providerId]
    return key ? key.slice(-4) : null
  },

  /**
   * Fallback keys tried in order, after the primary, when a request fails
   * with an authentication-shaped error. Stored as a JSON array under a
   * derived vault key so it shares the same encrypted file.
   */
  getFallbacks(providerId: string): string[] {
    try {
      const raw = load()[fallbackKey(providerId)]
      return raw ? (JSON.parse(raw) as string[]) : []
    } catch {
      return []
    }
  },
  setFallbacks(providerId: string, keys: string[]): void {
    const vault = loadForWrite()
    const cleaned = keys.map((k) => k.trim()).filter(Boolean)
    if (cleaned.length) vault[fallbackKey(providerId)] = JSON.stringify(cleaned)
    else delete vault[fallbackKey(providerId)]
    persist(vault)
  }
}
