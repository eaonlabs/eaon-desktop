import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * The workers' password vault sealed at rest, on a worker computer. A
 * Raspberry Pi has no keychain, so its keys file is plain text (owner-only).
 * The vault — passwords, 2FA codes, passkeys — is written there encrypted
 * (AES-256-GCM) with a key the desktop keeps in its own keychain and hands
 * over the encrypted link each time it connects. The key is only ever in
 * memory here: the Pi's disk alone never opens the vault, and from the host
 * starting until the desktop next connects, the vault is locked.
 *
 * On the desktop nothing is sealed: its whole vault is the OS keychain's already.
 */

const PREFIX = 'sealed:v1:'
const LOCKED = 'The password vault on this worker computer is locked until Eaon on your desktop connects to it: the key that opens it lives there.'

/** Thrown for a vault that can't be opened here: no key yet, or another one. Nothing is written over it. */
export class VaultLocked extends Error {
  constructor(message = LOCKED) {
    super(message)
    this.name = 'VaultLocked'
  }
}

let sealing = false
let key: Buffer | null = null

/** A worker computer seals its vault (src/host/boot.ts); off turns it back off (tests). */
export function sealVaultAtRest(on: boolean): void {
  sealing = on
  if (!on) key = null
}

/** The desktop's key, as sent over the link: 32 bytes, base64url. */
export function setVaultKey(raw: string): void {
  const bytes = Buffer.from(raw, 'base64url')
  if (bytes.length !== 32) throw new Error('That vault key isn’t one Eaon made.')
  key = bytes
}

export const newVaultKey = (): string => randomBytes(32).toString('base64url')

export const isSealed = (stored: string | undefined): boolean => Boolean(stored?.startsWith(PREFIX))

/** The vault as it should be stored here: sealed on a worker computer, as is elsewhere. */
export function sealVault(plain: string): string {
  if (!sealing || !plain) return plain
  if (!key) throw new VaultLocked()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

/** The vault as stored, opened: a sealed one needs the key; one written before sealing is read as it is. */
export function openVault(stored: string | undefined): string | undefined {
  if (!stored || !isSealed(stored)) return stored
  if (!key) throw new VaultLocked()
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    throw new VaultLocked('The password vault on this worker computer was sealed with a key this desktop doesn’t have, so it can’t be opened.')
  }
}
