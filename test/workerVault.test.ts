import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import '../src/main/agent/sources'
import type { ToolContext, ToolQuery } from '../src/main/agent/tools'
import { store } from '../src/main/store'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import type { FeatureContext } from '../src/main/features/types'
import { appsToolSource } from '../src/main/features/workers/apps'
import { createVault, parseTotp, totpCode } from '../src/main/features/workers/vault'
import { newVaultKey, openVault, sealVault, sealVaultAtRest, setVaultKey } from '../src/main/features/workers/vaultSeal'
import { passkeyShim, type WorkerBrowsers } from '../src/main/features/workers/browser'
import { createHue } from '../src/main/features/workers/hue'
import { createLists } from '../src/main/features/workers/lists'
import { createHousehold } from '../src/main/features/workers/household'
import { findLogin, loginsFromAppleCsv, parseCsv, siteFrom } from '@shared/workerVault'
import type { StreamRequest } from '@shared/types'

/**
 * The workers' password vault: finding a login in a message and which
 * website it is for, the Apple Passwords import, 2FA codes, passkeys, and
 * the tools that sign a worker in without it ever seeing a password.
 */

const g = globalThis as { __EAON_LABS__?: boolean }
let service: WorkersService | null = null

beforeEach(() => {
  store.setJson('workers.json', [])
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: mkdtempSync(join(tmpdir(), 'eaon-vault-')) } })
  g.__EAON_LABS__ = true
})
afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  delete g.__EAON_LABS__
  await store.flushWrites()
})

function memoryVault(start = 0) {
  let saved: string | undefined
  let clock = start
  const vault = createVault({ load: () => saved, save: (v) => (saved = v), now: () => clock })
  return { vault, raw: () => saved ?? '', tick: (ms: number) => (clock += ms) }
}

/* ---------------------------------------------------------------- messages */

test('a login typed into a message: the site, the username and the password, and the message without it', () => {
  const a = findLogin('my netflix login is sam@example.com and the password is hunter22.')!
  assert.deepEqual(a.site, { name: 'Netflix', domains: ['netflix.com'] })
  assert.equal(a.username, 'sam@example.com')
  assert.equal(a.password, 'hunter22')
  assert.equal(a.redacted, 'my netflix login is sam@example.com and the password is •••• (saved to the vault).')
  assert.ok(!a.redacted.includes('hunter22'))

  const b = findLogin('For chase.com — username: samlee, pw: Tr0ub4dor&3')!
  assert.deepEqual([b.site?.name, b.username, b.password], ['Chase', 'samlee', 'Tr0ub4dor&3'])

  const c = findLogin('Uber login: sam@gmail.com / s3cret!!')!
  assert.deepEqual([c.site?.name, c.username, c.password], ['Uber', 'sam@gmail.com', 's3cret!!'], 'an email’s own domain isn’t taken for the site')

  const d = findLogin('sign in to https://portal.mybank-example.com with password "correct horse 42"')!
  assert.equal(d.site?.domains[0], 'mybank-example.com')
  assert.equal(d.password, 'correct horse 42', 'a quoted password is taken whole')
  assert.ok(!d.redacted.includes('horse'))

  for (const ordinary of ['can you reset my password?', 'the password manager is broken', 'my email is sam@example.com', 'Order dinner at 6', 'password: is']) {
    assert.equal(findLogin(ordinary), null, ordinary)
  }
})

test('which site: addresses first, then names, the longest name winning', () => {
  assert.equal(siteFrom('my uber eats account')?.name, 'Uber Eats')
  assert.equal(siteFrom('my uber account')?.name, 'Uber')
  assert.deepEqual(siteFrom('login for secure.chase.com'), { name: 'Chase', domains: ['chase.com'] })
  assert.deepEqual(siteFrom('the one at account.example.co.uk'), { name: 'example.co.uk', domains: ['example.co.uk'] })
  assert.equal(siteFrom('my gmail')?.name, 'Google')
  assert.equal(siteFrom('nothing here'), null)
})

/* ---------------------------------------------------------------- Apple Passwords */

test('an Apple Passwords export: columns by name, quotes, 2FA links; rows without a website or password skipped', () => {
  assert.deepEqual(parseCsv('a,"b, ""c""",d\r\n1,2,3\n'), [['a', 'b, "c"', 'd'], ['1', '2', '3']])
  const csv = [
    '﻿Title,URL,Username,Password,Notes,OTPAuth',
    'Netflix,https://www.netflix.com/login,sam@example.com,"pa,ss""word",,',
    'GitHub (github.com),https://github.com/,samlee,gh-secret,"two\nlines",otpauth://totp/GitHub:samlee?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    'Wi-Fi,,,router-pass,,',
    'Empty,https://example.com,sam,,,'
  ].join('\n')
  const rows = loginsFromAppleCsv(csv)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { site: 'Netflix', domains: ['netflix.com'], username: 'sam@example.com', password: 'pa,ss"word', code: '' })
  assert.match(rows[1].code, /^otpauth:\/\/totp/)
  assert.throws(() => loginsFromAppleCsv('Name,Site\nx,y'), /export from the Passwords app/)

  const { vault } = memoryVault()
  assert.deepEqual(vault.importApple(csv, 'all'), { added: 2, updated: 0, skipped: 0 })
  assert.deepEqual(vault.importApple(csv, 'all'), { added: 0, updated: 2, skipped: 0 }, 'importing again updates rather than duplicates')
  assert.equal(vault.state().logins.find((l) => l.site.startsWith('GitHub'))?.hasCode, true)
})

/* ---------------------------------------------------------------- 2FA codes */

test('2FA codes match RFC 6238 and what an authenticator app shows', () => {
  // RFC 6238 test secret ("12345678901234567890"), 8 digits, SHA-1.
  const rfc = parseTotp('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&algorithm=SHA1')!
  assert.equal(totpCode(rfc, 59_000), '94287082')
  assert.equal(totpCode(rfc, 1_111_111_109_000), '07081804')
  assert.equal(totpCode(rfc, 2_000_000_000_000), '69279037')
  const plain = parseTotp('jbsw y3dp ehpk 3pxp')!
  assert.equal(plain.digits, 6)
  assert.match(totpCode(plain, Date.now()), /^\d{6}$/)
  assert.throws(() => parseTotp('not-a-secret!'), /isn’t a 2FA secret/)
  assert.throws(() => parseTotp('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP'), /time-based/)
  assert.equal(parseTotp(''), null)
})

/* ---------------------------------------------------------------- the vault */

test('the vault: websites from a name, one login per site and username, matching only https pages on its websites, for its workers', () => {
  const { vault, raw } = memoryVault(1000)
  const login = vault.saveLogin({ site: 'Chase', username: 'samlee', password: 'Tr0ub4dor&3', workers: ['w1'] })
  assert.deepEqual(login.domains, ['chase.com'])
  assert.equal('password' in login, false, 'what comes back has no password')
  assert.ok(!JSON.stringify(vault.state()).includes('Tr0ub4dor'))
  assert.ok(raw().includes('Tr0ub4dor'), 'it is in the (encrypted) vault entry itself')
  assert.throws(() => vault.saveLogin({ site: 'My thing', username: 'x', password: 'y', workers: 'all' }), /Which website/)
  assert.throws(() => vault.saveLogin({ site: 'chase.com', username: 'x', workers: 'all' }), /Type the password/)
  assert.throws(() => vault.saveLogin({ site: 'chase.com', username: 'x', password: 'p', workers: [] }), /at least one worker/)

  // The same site and username: updated, not added.
  vault.saveLogin({ site: 'chase.com', username: 'SamLee', password: 'new-one', workers: ['w1', 'w2'] })
  assert.equal(vault.state().logins.length, 1)

  assert.equal(vault.match('w1', 'https://secure.chase.com/web/auth')?.password, 'new-one')
  assert.equal(vault.match('w2', 'https://www.chase.com/')?.username, 'SamLee')
  assert.equal(vault.match('w3', 'https://www.chase.com/'), null, 'a worker it wasn’t given')
  assert.equal(vault.match('w1', 'http://www.chase.com/'), null, 'not over plain http')
  assert.equal(vault.match('w1', 'https://chase.com.evil.example/'), null)
  assert.equal(vault.match('w1', 'https://notchase.com/'), null)

  vault.setAccess(login.id, { ask: true, workers: 'all' })
  assert.equal(vault.match('w3', 'https://chase.com/')?.ask, true)

  // A removed worker comes off the logins, which stay.
  vault.setAccess(login.id, { workers: ['w1'] })
  vault.forgetWorker('w1')
  assert.deepEqual(vault.state().logins[0].workers, [])
})

test('passkeys: kept per worker, the counter moves on, removing one or its worker forgets it', () => {
  const { vault, tick } = memoryVault(5)
  const credential = { credentialId: 'cred-1', isResidentCredential: true, rpId: 'github.com', privateKey: 'PRIVATEKEY', userHandle: 'dQ', signCount: 1, userName: 'samlee' }
  const passkey = vault.addPasskey('w1', credential)
  assert.deepEqual([passkey.rpId, passkey.userName, passkey.workerId], ['github.com', 'samlee', 'w1'])
  assert.ok(!JSON.stringify(vault.state()).includes('PRIVATEKEY'))
  assert.deepEqual(vault.passkeyCredentials('w1'), [credential])
  assert.deepEqual(vault.passkeyCredentials('w2'), [])
  tick(10)
  vault.passkeyUsed('cred-1', 7)
  assert.equal(vault.passkeyCredentials('w1')[0].signCount, 7)
  assert.equal(vault.state().passkeys[0].lastUsedAt, 15)
  vault.passkeyUsed('cred-1', 3)
  assert.equal(vault.passkeyCredentials('w1')[0].signCount, 7, 'never backwards')
  vault.forgetWorker('w1')
  assert.deepEqual(vault.state().passkeys, [])
})

test('a worker computer’s sealed vault, still locked: the turn goes on without vault tools, and the brief says why', () => {
  const ctx = { ipcMain: { handle: () => {} }, getWindow: () => null, send: () => {}, emitStream: () => {} } as unknown as FeatureContext
  service = createWorkersService(ctx, { runAgent: async () => ({ text: 'ok', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), startDelayMs: 60_000 })
  service.start()
  const w = service.engine.save({ name: 'Nova', color: '#3E86C6', personality: '', purpose: 'x', apps: ['uber'] })
  sealVaultAtRest(true)
  try {
    setVaultKey(newVaultKey())
    let saved: string | undefined
    const vault = createVault({ load: () => openVault(saved), save: (v) => (saved = sealVault(v)) })
    vault.saveLogin({ site: 'Uber', username: 'sam@example.com', password: 'Sup3rSecret', workers: [w.id] })
    assert.ok(saved?.startsWith('sealed:v1:') && !saved.includes('Sup3rSecret'))
    const source = appsToolSource({ engine: service.engine, browsers: {} as WorkerBrowsers, hue: createHue({ load: () => null, save: () => {} }), lists: createLists({ load: () => [], save: () => {} }), household: createHousehold(async () => ''), vault })
    const query: ToolQuery = { mode: 'work', cwd: '/', depth: 0, readOnly: false, settings: store.getSettings(), request: { workerId: w.id, messageId: 'm', chatId: 'c', mode: 'work', messages: [] } as unknown as StreamRequest }
    assert.ok(source.tools(query).some((t) => t.name === 'sign_in_saved'))

    // The host restarted: no key until the desktop connects.
    sealVaultAtRest(false)
    sealVaultAtRest(true)
    const before = saved
    const names = source.tools(query).map((t) => t.name)
    assert.ok(names.includes('open_app') && !names.includes('sign_in_saved') && !names.includes('saved_logins'))
    assert.match(String(source.guidance?.(query)), /password vault is locked until Eaon on the user’s desktop connects/)
    assert.throws(() => vault.saveLogin({ site: 'Lyft', username: 'sam@example.com', password: 'x', workers: 'all' }), /locked/)
    assert.equal(saved, before, 'a locked vault is never written over')
  } finally {
    sealVaultAtRest(false)
  }
})

test('the passkey page script names the worker’s passkeys when a site leaves the choice to the browser', async () => {
  const calls: unknown[] = []
  const navigator = { credentials: { get: async (opts: unknown) => (calls.push(opts), 'ok') } }
  const context = { navigator, location: { hostname: 'github.com' }, atob: (s: string) => Buffer.from(s, 'base64').toString('binary'), Uint8Array, Object, Promise, DOMException }
  runInNewContext(passkeyShim({ 'github.com': ['AQID'] }), context)
  await navigator.credentials.get({ mediation: 'conditional', publicKey: { challenge: 1 } })
  const first = calls[0] as { mediation: string; publicKey: { allowCredentials: { id: Uint8Array }[] } }
  assert.equal(first.mediation, 'optional')
  assert.deepEqual([...first.publicKey.allowCredentials[0].id], [1, 2, 3])
  await navigator.credentials.get({ publicKey: { rpId: 'gitlab.com' } })
  assert.equal((calls[1] as { publicKey: { allowCredentials?: unknown } }).publicKey.allowCredentials, undefined, 'another site is left alone')
  await navigator.credentials.get({ publicKey: { allowCredentials: [{ id: 'x' }] } })
  assert.deepEqual((calls[2] as { publicKey: { allowCredentials: unknown[] } }).publicKey.allowCredentials, [{ id: 'x' }], 'a site that names its passkey is left alone')

  // An autofill request on a site it has no passkey for never reaches the browser, and ends when the site aborts it.
  const controller = new AbortController()
  const pending = navigator.credentials.get({ mediation: 'conditional', signal: controller.signal, publicKey: { rpId: 'gitlab.com' } })
  controller.abort()
  await assert.rejects(pending as Promise<unknown>)
  assert.equal(calls.length, 3, 'the browser never saw it')
})

/* ---------------------------------------------------------------- tools */

test('sign_in_saved types the saved login on its own site only, adds the 2FA code, and never shows the password', async () => {
  const ctx = { ipcMain: { handle: () => {} }, getWindow: () => null, send: () => {}, emitStream: () => {} } as unknown as FeatureContext
  service = createWorkersService(ctx, { runAgent: async () => ({ text: 'ok', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), startDelayMs: 60_000 })
  service.start()
  const engine = service.engine
  const w = engine.save({ name: 'Nova', color: '#3E86C6', personality: '', purpose: 'x', apps: ['uber'] })
  const { vault } = memoryVault(59_000)
  vault.saveLogin({ site: 'Uber', username: 'sam@example.com', password: 'Sup3rSecret', code: 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8', workers: [w.id] })

  let page = 'https://auth.uber.com/v2/'
  const filled: unknown[] = []
  const codes: string[] = []
  const browsers = {
    url: () => page,
    has: () => true,
    fillLogin: async (_id: string, login: unknown) => (filled.push(login), { url: page, filled: ['username', 'password'], stillOnSignIn: true }),
    fillCode: async (_id: string, code: string) => (codes.push(code), { filled: true })
  } as unknown as WorkerBrowsers
  const source = appsToolSource({ engine, browsers, hue: createHue({ load: () => null, save: () => {} }), lists: createLists({ load: () => [], save: () => {} }), household: createHousehold(async () => ''), vault })
  const query: ToolQuery = { mode: 'work', cwd: '/', depth: 0, readOnly: false, settings: store.getSettings(), request: { workerId: w.id, messageId: 'm', chatId: 'c', mode: 'work', messages: [] } as unknown as StreamRequest }
  const tools = source.tools(query)
  assert.ok(['saved_logins', 'sign_in_saved', 'fill_2fa_code'].every((n) => tools.some((t) => t.name === n)))
  const ctxFor = { request: { workerId: w.id } as StreamRequest, turn: { notes: [] }, cwd: '/', signal: new AbortController().signal, emit: () => {}, toolId: 't', depth: 0, readOnly: false, settings: store.getSettings(), progress: () => {}, confirm: async () => true } as ToolContext

  const list = String(await tools.find((t) => t.name === 'saved_logins')!.run({}, ctxFor))
  assert.match(list, /Uber \(uber\.com\): sam@example\.com · 2FA codes/)
  const signIn = tools.find((t) => t.name === 'sign_in_saved')!
  const said = String(await signIn.run({}, ctxFor))
  assert.deepEqual(filled[0], { username: 'sam@example.com', password: 'Sup3rSecret', domains: ['uber.com'] })
  assert.deepEqual(codes, ['94287082'], 'the 2FA code for that moment')
  assert.match(said, /Eaon typed the saved one/)
  for (const output of [list, said]) assert.ok(!output.includes('Sup3rSecret') && !output.includes('94287082'))
  assert.equal(await signIn.catastrophic!({}, ctxFor), false)

  page = 'https://uber.com.phish.example/login'
  const refused = await signIn.run({}, ctxFor)
  assert.ok(typeof refused === 'object' && refused.isError && /no saved login for uber\.com\.phish\.example/.test(refused.text))
  assert.equal(filled.length, 1, 'nothing typed on the wrong site')

  // "Ask me before each use" makes it the user's call.
  page = 'https://auth.uber.com/v2/'
  vault.setAccess(vault.state().logins[0].id, { ask: true })
  assert.equal(await signIn.catastrophic!({}, ctxFor), true)

  // request_sign_in points at the saved login instead of asking the user again.
  const request = tools.find((t) => t.name === 'request_sign_in')!
  assert.match(String(await request.run({ app: 'uber' }, ctxFor)), /saved login for Uber .*sign_in_saved/)
})
