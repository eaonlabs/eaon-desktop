import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { secrets } from '../src/main/secrets'

/**
 * The key vault (secrets.ts) across the states safeStorage can be in. The
 * stub's safeStorage is swapped per test: "encrypted" bytes are the JSON
 * reversed behind a marker, so they are unreadable as plaintext, and
 * decrypting anything without the marker throws, as the real one does.
 */

const vault = (): string => join(app.getPath('userData'), 'keys.dat')
const MARK = 'ENC:'

function keychain(available: boolean): void {
  safeStorage.isEncryptionAvailable = () => available
  safeStorage.encryptString = (s: string) => Buffer.from(MARK + [...s].reverse().join(''), 'utf8')
  safeStorage.decryptString = (b: Buffer) => {
    const text = b.toString('utf8')
    if (!available || !text.startsWith(MARK)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
    return [...text.slice(MARK.length)].reverse().join('')
  }
}

const leftovers = (): string[] => readdirSync(app.getPath('userData')).filter((f) => f.startsWith('keys.dat.'))

beforeEach(() => {
  rmSync(vault(), { force: true })
  for (const f of leftovers()) rmSync(join(app.getPath('userData'), f), { force: true })
})

test('keys saved while the keychain was unavailable are still there once it is available', () => {
  keychain(false)
  secrets.set('openai', 'sk-plain-1234')
  keychain(true)
  assert.equal(secrets.get('openai'), 'sk-plain-1234')

  secrets.set('anthropic', 'sk-ant-5678')
  assert.equal(secrets.get('openai'), 'sk-plain-1234', 'saving a second key keeps the first')
  assert.equal(secrets.get('anthropic'), 'sk-ant-5678')
  assert.ok(readFileSync(vault(), 'utf8').startsWith(MARK), 'rewritten encrypted')
})

test('while the keychain is locked, saving a key refuses rather than overwriting every saved key', () => {
  keychain(true)
  secrets.set('openai', 'sk-one')
  secrets.set('anthropic', 'sk-two')
  const before = readFileSync(vault())

  keychain(false)
  assert.equal(secrets.get('openai'), undefined)
  assert.throws(() => secrets.set('groq', 'gsk-three'), /keychain/i)
  assert.deepEqual(readFileSync(vault()), before, 'vault untouched')

  keychain(true)
  assert.equal(secrets.get('openai'), 'sk-one')
  assert.equal(secrets.get('anthropic'), 'sk-two')
})

test('a vault that can never be read is set aside, not overwritten, and new keys still save', () => {
  keychain(true)
  writeFileSync(vault(), Buffer.from([0, 1, 2, 3, 250, 251]))

  secrets.set('openai', 'sk-new')
  assert.equal(secrets.get('openai'), 'sk-new')
  const aside = leftovers()
  assert.equal(aside.length, 1, 'the unreadable file is kept next to the new vault')
  assert.deepEqual(readFileSync(join(app.getPath('userData'), aside[0])), Buffer.from([0, 1, 2, 3, 250, 251]))
})

test('the vault is replaced whole, never left half-written', () => {
  keychain(true)
  secrets.set('openai', 'sk-one')
  secrets.setFallbacks('openai', ['sk-two', ' '])
  assert.deepEqual(secrets.getFallbacks('openai'), ['sk-two'])
  assert.equal(existsSync(`${vault()}.tmp`), false)
  secrets.clear('openai')
  assert.equal(secrets.has('openai'), false)
  assert.deepEqual(secrets.getFallbacks('openai'), [])
})
