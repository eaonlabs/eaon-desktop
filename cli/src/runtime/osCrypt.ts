import { spawn, spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Chromium's OSCrypt format, which is what Electron's `safeStorage` writes.
 *
 * The desktop app keeps its API keys in `keys.dat`, encrypted with
 * `safeStorage`. To read them the CLI does what Chromium does:
 *
 * - **macOS**: the password is a keychain item, `<App> Safe Storage` /
 *   `<App> Key`. The key is PBKDF2-SHA1 of it (salt `saltysalt`, 1003
 *   rounds, 16 bytes); the data is `v10` + AES-128-CBC with an IV of 16
 *   spaces. Reading another app's item makes macOS ask the user once.
 * - **Linux**: `v10` is the same scheme with the password `peanuts` and one
 *   round (no keyring); `v11` takes the password from the Secret Service.
 * - **Windows**: `v10` + a 12-byte nonce + AES-256-GCM, with a key kept in
 *   the profile's `Local State`, itself protected by DPAPI.
 *
 * The CLI's own vault uses the same format on macOS, under its own keychain
 * item (created by `security`, so reading it back never prompts). Elsewhere
 * the CLI vault is plain JSON in a folder only the user can open — what most
 * CLIs do — because a keyring isn't reliably there in a terminal.
 */

const SALT = 'saltysalt'
const CBC_IV = Buffer.alloc(16, 0x20)

export const MAC_ROUNDS = 1003
export const LINUX_ROUNDS = 1

export function cbcKey(password: string, rounds: number): Buffer {
  return pbkdf2Sync(password, SALT, rounds, 16, 'sha1')
}

export function encryptCbc(text: string, key: Buffer, prefix = 'v10'): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, CBC_IV)
  return Buffer.concat([Buffer.from(prefix, 'utf8'), cipher.update(text, 'utf8'), cipher.final()])
}

export function decryptCbc(data: Buffer, key: Buffer): string {
  const prefix = data.subarray(0, 3).toString('utf8')
  if (prefix !== 'v10' && prefix !== 'v11') throw new Error('Not an OSCrypt value')
  const decipher = createDecipheriv('aes-128-cbc', key, CBC_IV)
  return Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]).toString('utf8')
}

export function decryptGcm(data: Buffer, key: Buffer): string {
  if (data.subarray(0, 3).toString('utf8') !== 'v10') throw new Error('Not an OSCrypt value')
  const nonce = data.subarray(3, 15)
  const tag = data.subarray(data.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data.subarray(15, data.length - 16)), decipher.final()]).toString('utf8')
}

/* ------------------------------------------------------------- macOS */

/** Reads a keychain password without waiting on a prompt. Null when missing or not ours to read silently. */
function keychainReadSync(service: string, account: string): string | null {
  const result = spawnSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { encoding: 'utf8', timeout: 5000 })
  if (result.status !== 0) return null
  const password = result.stdout.replace(/\r?\n$/, '')
  return password || null
}

/**
 * Reads a keychain password that may belong to another app. macOS shows its
 * "wants to use your confidential information" dialog, so this must not
 * block the process while the user decides.
 */
export function keychainRead(service: string, account: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 ? out.replace(/\r?\n$/, '') || null : null))
  })
}

/**
 * The CLI's own keychain password, created on first use. It goes in through
 * `security -i`'s stdin, so it never appears in a process listing.
 */
function cliKeychainPassword(service: string, account: string): string | null {
  const existing = keychainReadSync(service, account)
  if (existing) return existing
  const password = randomBytes(18).toString('base64')
  const added = spawnSync('security', ['-i'], {
    input: `add-generic-password -U -s "${service}" -a "${account}" -l "${service}" -w "${password}"\n`,
    encoding: 'utf8',
    timeout: 5000
  })
  if (added.status !== 0) return null
  return keychainReadSync(service, account)
}

/* ------------------------------------------------------------- Linux */

/** The Secret Service password a Chromium app stores for `v11` values; null without `secret-tool` or the item. */
function linuxSecretPassword(appName: string): Promise<string | null> {
  const attempts = [
    ['lookup', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2', 'application', appName.toLowerCase()],
    ['lookup', 'application', appName.toLowerCase()],
    ['lookup', 'application', appName]
  ]
  return attempts.reduce<Promise<string | null>>(
    (found, args) =>
      found.then(
        (password) =>
          password ??
          new Promise((resolve) => {
            const child = spawn('secret-tool', args, { stdio: ['ignore', 'pipe', 'ignore'] })
            let out = ''
            child.stdout.on('data', (chunk) => (out += chunk))
            child.on('error', () => resolve(null))
            child.on('close', (code) => resolve(code === 0 && out ? out.replace(/\r?\n$/, '') : null))
          })
      ),
    Promise.resolve(null)
  )
}

/* ------------------------------------------------------------- Windows */

/** Unwraps the AES key in a Chromium profile's `Local State` with DPAPI, through PowerShell. */
function windowsProfileKey(userData: string): Promise<Buffer | null> {
  let encoded: string
  try {
    const state = JSON.parse(readFileSync(join(userData, 'Local State'), 'utf8')) as { os_crypt?: { encrypted_key?: string } }
    encoded = state.os_crypt?.encrypted_key ?? ''
  } catch {
    return Promise.resolve(null)
  }
  const wrapped = Buffer.from(encoded, 'base64')
  if (wrapped.subarray(0, 5).toString('utf8') !== 'DPAPI') return Promise.resolve(null)
  const blob = wrapped.subarray(5).toString('base64')
  const script =
    'Add-Type -AssemblyName System.Security; ' +
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${blob}'), $null, 'CurrentUser'))`
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      const key = code === 0 ? Buffer.from(out.trim(), 'base64') : null
      resolve(key && key.length === 32 ? key : null)
    })
  })
}

/* ---------------------------------------------------- reading another app */

/**
 * Decrypts something another Electron app wrote with `safeStorage` — the
 * desktop app's `keys.dat`. On macOS this is when the keychain dialog shows.
 */
export async function decryptForeign(data: Buffer, appName: string, userData: string): Promise<string> {
  const prefix = data.subarray(0, 3).toString('utf8')
  if (prefix !== 'v10' && prefix !== 'v11') return data.toString('utf8')
  if (process.platform === 'darwin') {
    const password = await keychainRead(`${appName} Safe Storage`, `${appName} Key`)
    if (!password) throw new Error(`macOS didn't release the “${appName} Safe Storage” keychain item, so the desktop app's keys can't be read.`)
    return decryptCbc(data, cbcKey(password, MAC_ROUNDS))
  }
  if (process.platform === 'win32') {
    const key = await windowsProfileKey(userData)
    if (!key) throw new Error("Windows didn't unlock the desktop app's key store.")
    return decryptGcm(data, key)
  }
  if (prefix === 'v10') return decryptCbc(data, cbcKey('peanuts', LINUX_ROUNDS))
  const password = await linuxSecretPassword(appName)
  if (!password) throw new Error("The desktop app's keys are in the system keyring, and secret-tool couldn't read them.")
  return decryptCbc(data, cbcKey(password, LINUX_ROUNDS))
}

/* ------------------------------------------------------ the CLI's own vault */

export interface OsCrypt {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

/**
 * `safeStorage` for the CLI's own profile. On macOS: a keychain item of its
 * own, read once and kept in memory. Elsewhere unavailable, so the vault is
 * stored as plain JSON (the profile folder is made private at startup).
 */
export function cliOsCrypt(appName: string): OsCrypt {
  let key: Buffer | null | undefined
  const load = (): Buffer | null => {
    if (key !== undefined) return key
    key = null
    if (process.platform === 'darwin' && process.env.EAON_CLI_NO_KEYCHAIN !== '1') {
      const password = cliKeychainPassword(`${appName} Safe Storage`, `${appName} Key`)
      if (password) key = cbcKey(password, MAC_ROUNDS)
    }
    return key
  }
  return {
    isEncryptionAvailable: () => load() !== null,
    encryptString(text) {
      const k = load()
      if (!k) throw new Error('Encryption is not available')
      return encryptCbc(text, k)
    },
    decryptString(data) {
      const k = load()
      if (!k) throw new Error('Encryption is not available')
      return decryptCbc(data, k)
    }
  }
}
