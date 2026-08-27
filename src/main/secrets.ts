import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * API keys are encrypted with the OS keychain via safeStorage before they touch
 * disk, and are never sent to the renderer — the renderer only ever learns
 * whether a key exists (`hasKey`).
 */

type Vault = Record<string, string>

const fallbackKey = (providerId: string): string => `${providerId}::fallback`

const vaultPath = () => join(app.getPath('userData'), 'keys.dat')

function load(): Vault {
  try {
    if (!existsSync(vaultPath())) return {}
    const raw = readFileSync(vaultPath())
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    return JSON.parse(json) as Vault
  } catch {
    return {}
  }
}

function persist(vault: Vault): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const json = JSON.stringify(vault)
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8')
  writeFileSync(vaultPath(), payload)
}

export const secrets = {
  set(providerId: string, key: string): void {
    const vault = load()
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
    const vault = load()
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
    const vault = load()
    const cleaned = keys.map((k) => k.trim()).filter(Boolean)
    if (cleaned.length) vault[fallbackKey(providerId)] = JSON.stringify(cleaned)
    else delete vault[fallbackKey(providerId)]
    persist(vault)
  }
}
