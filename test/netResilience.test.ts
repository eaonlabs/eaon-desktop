import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { app } from 'electron'
import type { Provider, StreamRequest } from '@shared/types'
import { FREE_PROVIDER_ID } from '@shared/freeCredits'
import { classifyProviderError, isCertificateError } from '../src/main/providers/errors'
import { isNearbyServer, STREAM_LIMITS, streamGuard } from '../src/main/providers/streamGuard'
import { proxyEnv, trustSystemCertificates, useEnvironmentProxy } from '../src/main/netTrust'
import { getLocalServerStatus, startLocalServer, stopLocalServer } from '../src/main/localServer'
import { refreshModels } from '../src/main/providers'
import { activeCode } from '../src/main/freeCredits'
import { copilotFlow } from '../src/main/providers/oauth/copilot'
import { toolsFor, type ToolContext } from '../src/main/agent/tools'
import { secrets } from '../src/main/secrets'
import { store } from '../src/main/store'

/*
 * Networks Eaon meets at an event or on a managed laptop: TLS-filtering
 * proxies, HTTPS_PROXY, Wi-Fi that drops, a keychain that is locked for a
 * moment. Each fix is pinned here without the real network.
 */

const like = (extra: Partial<Provider> = {}): Pick<Provider, 'id' | 'name' | 'auth' | 'local' | 'baseUrl'> => ({
  id: 'openai',
  name: 'OpenAI',
  auth: 'key',
  local: false,
  baseUrl: 'https://api.openai.com/v1',
  ...extra
})

const fetchFailed = (code: string, message = code): Error => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) })

test('classifier: a certificate failure is a filtered network or a wrong clock, never "the connection dropped"', () => {
  const p = like()
  const cases: unknown[] = [
    fetchFailed('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain'),
    fetchFailed('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate'),
    fetchFailed('UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
    fetchFailed('DEPTH_ZERO_SELF_SIGNED_CERT'),
    fetchFailed('CERT_HAS_EXPIRED', 'certificate has expired'),
    fetchFailed('CERT_NOT_YET_VALID'),
    fetchFailed('ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames"),
    // The Anthropic SDK's wrapper: "Connection error." over the fetch failure.
    Object.assign(new Error('Connection error.'), { name: 'APIConnectionError', cause: fetchFailed('SELF_SIGNED_CERT_IN_CHAIN') }),
    // Only the words survived.
    new Error('request to https://api.openai.com failed, reason: unable to get local issuer certificate')
  ]
  for (const error of cases) {
    const issue = classifyProviderError(error, p)
    assert.equal(issue.kind, 'network', String((error as Error).message))
    assert.match(issue.message, /network filter, a Wi-Fi sign-in page or the computer’s clock blocked the secure connection to OpenAI/)
    assert.match(issue.message, /api\.openai\.com/)
    assert.doesNotMatch(issue.message, /dropped/)
    assert.ok(isCertificateError(error))
  }
  // A custom provider with no address yet still gets a sentence that reads.
  assert.match(classifyProviderError(fetchFailed('SELF_SIGNED_CERT_IN_CHAIN'), like({ baseUrl: '' })).message, /ask IT to allow OpenAI\./)
  // Real drops are still drops, and an HTTP error mentioning certificates is the provider's.
  assert.match(classifyProviderError(fetchFailed('ECONNRESET'), p).message, /connection to OpenAI dropped/)
  assert.equal(isCertificateError(fetchFailed('ECONNRESET')), false)
  assert.equal(isCertificateError(Object.assign(new Error('400: certificate chain invalid in request'), { status: 400 })), false)
})

test('system certificates are added to Node’s own, never replacing them', () => {
  let set: string[] | null = null
  const api = {
    getCACertificates: (type?: string) => (type === 'system' ? ['corp-root', 'shared'] : ['mozilla-1', 'shared']),
    setDefaultCACertificates: (certs: string[]) => void (set = certs)
  }
  assert.equal(trustSystemCertificates(api), true)
  assert.deepEqual(set, ['mozilla-1', 'shared', 'corp-root'])
  // An older Node, an empty store, or a store that can't be read: left alone.
  assert.equal(trustSystemCertificates({}), false)
  set = null
  assert.equal(trustSystemCertificates({ ...api, getCACertificates: (type?: string) => (type === 'system' ? [] : ['x']) }), false)
  assert.equal(set, null)
  assert.equal(
    trustSystemCertificates({
      ...api,
      getCACertificates: () => {
        throw new Error('keychain locked')
      }
    }),
    false
  )
  // The real one, in this Node: works or declines, never throws.
  assert.equal(typeof trustSystemCertificates(), 'boolean')
})

test('HTTPS_PROXY is honoured, with this computer always reached directly', () => {
  assert.equal(proxyEnv({}), null)
  const env = proxyEnv({ HTTPS_PROXY: 'http://proxy.school:8080', no_proxy: 'intranet.school' })!
  assert.equal(env.HTTPS_PROXY, 'http://proxy.school:8080')
  assert.equal(env.NO_PROXY, 'intranet.school,localhost,127.0.0.1,::1,[::1]')
  assert.equal(env.no_proxy, undefined)
  assert.equal(proxyEnv({ http_proxy: 'http://p:1', NO_PROXY: 'localhost,127.0.0.1' })!.NO_PROXY, 'localhost,127.0.0.1,::1,[::1]')

  let given: NodeJS.ProcessEnv | null = null
  const api = { setGlobalProxyFromEnv: (e?: NodeJS.ProcessEnv) => ((given = e ?? null), () => {}) }
  assert.equal(useEnvironmentProxy({}, api), false)
  assert.equal(given, null, 'no proxy set: nothing changed')
  assert.equal(useEnvironmentProxy({ HTTPS_PROXY: 'http://proxy:3128' }, api), true)
  assert.match(String(given!.NO_PROXY), /127\.0\.0\.1/)
  // A malformed address goes direct instead of breaking every request.
  const throws = {
    setGlobalProxyFromEnv: (): (() => void) => {
      throw new Error('ERR_PROXY_INVALID_CONFIG')
    }
  }
  assert.equal(useEnvironmentProxy({ HTTPS_PROXY: '::bad::' }, throws), false)
  assert.equal(useEnvironmentProxy({ HTTPS_PROXY: 'http://proxy:3128' }, {}), false)
})

test('first response: a provider on the internet that never starts answering times out; nearby servers wait', async () => {
  const saved = { ...STREAM_LIMITS }
  try {
    Object.assign(STREAM_LIMITS, { firstResponseMs: 150 })
    const remote = streamGuard(new AbortController().signal, { name: 'OpenAI', local: false, baseUrl: 'https://api.openai.com/v1' })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(remote.signal.aborted, true)
    const error = remote.translate(new Error('This operation was aborted')) as Error
    assert.equal(error.name, 'TimeoutError')
    assert.match(error.message, /OpenAI didn’t start answering within/)
    assert.equal(classifyProviderError(error, like()).kind, 'timeout')
    remote.stop()

    // Started in time: the first-response clock is off, the idle clock takes over.
    const started = streamGuard(new AbortController().signal, { name: 'OpenAI', local: false, baseUrl: 'https://api.openai.com/v1' })
    started.touch()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(started.signal.aborted, false)
    started.stop()

    // Loading a model on this computer or the LAN can take minutes.
    for (const baseUrl of ['http://127.0.0.1:8080/v1', 'http://localhost:11434', 'http://192.168.1.20:8000/v1', 'http://gpu-box:8000/v1', 'http://studio.local:1234/v1', 'http://[::1]:8080']) {
      const near = streamGuard(new AbortController().signal, { name: 'Box', local: false, baseUrl })
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(near.signal.aborted, false, baseUrl)
      near.stop()
    }
    const local = streamGuard(new AbortController().signal, { name: 'Ollama', local: true, baseUrl: 'https://ollama.example.com' })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(local.signal.aborted, false)
    local.stop()
  } finally {
    Object.assign(STREAM_LIMITS, saved)
  }
  assert.equal(isNearbyServer('https://openrouter.ai/api/v1'), false)
  assert.equal(isNearbyServer('https://10.0.0.5/v1'), true)
  assert.equal(isNearbyServer('http://100.101.102.103:11434'), true, 'a Tailscale address')
  assert.equal(isNearbyServer('not a url'), true)
})

test('local API server: two starts at once share one server instead of failing on their own port', async () => {
  store.patchSettings({ localServer: { ...store.getSettings().localServer, port: 47331 } })
  const [a, b, c] = await Promise.all([startLocalServer(), startLocalServer(), startLocalServer()])
  for (const status of [a, b, c]) assert.equal(status.running, true, JSON.stringify(status))
  assert.equal(getLocalServerStatus().running, true)
  const hello = await fetch('http://127.0.0.1:47331/api/hello')
  assert.equal(hello.status, 200)
  // Stop while a start is still listening: it ends stopped, not running behind the UI's back.
  await stopLocalServer()
  const pending = startLocalServer()
  const stopped = await stopLocalServer()
  await pending
  assert.equal(stopped.running, false)
  assert.equal(getLocalServerStatus().running, false)
  // A port another program holds: a failed start, and nothing left claimed.
  const other = createServer()
  await new Promise<void>((r) => other.listen(47332, '127.0.0.1', () => r()))
  store.patchSettings({ localServer: { ...store.getSettings().localServer, port: 47332 } })
  const failed = await startLocalServer()
  assert.equal(failed.running, false)
  assert.ok(failed.error)
  other.close()
})

test('a local runtime that is not running does not rewrite providers.json on every probe', async () => {
  const dead = createServer()
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()))
  const port = (dead.address() as AddressInfo).port
  await new Promise<void>((r) => dead.close(() => r()))
  const base = `http://127.0.0.1:${port}`

  // Never listed anything: nothing to mark.
  store.saveProviderConfig({ ollama: { enabled: true, baseUrl: base } })
  await assert.rejects(refreshModels('ollama'))
  assert.equal(store.getProviderConfig().ollama.listFailedAt, undefined)

  // Listed once: the first failure marks the list as the kept copy; later ones change nothing.
  store.saveProviderConfig({ ollama: { enabled: true, baseUrl: base, listed: [{ id: 'llama3', label: 'Llama 3', providerId: 'ollama' }], listedAt: 1000 } })
  await assert.rejects(refreshModels('ollama'))
  const first = store.getProviderConfig().ollama.listFailedAt
  assert.ok(typeof first === 'number' && first > 1000)
  await new Promise((r) => setTimeout(r, 5))
  await assert.rejects(refreshModels('ollama'))
  assert.equal(store.getProviderConfig().ollama.listFailedAt, first)
  store.saveProviderConfig({})
})

test('an event code survives a keychain that is locked for a moment', () => {
  const vault = join(app.getPath('userData'), 'keys.dat')
  const code = { name: 'Hack Night', endsAt: Date.now() + 86_400_000, limits: { requestsPerDay: 100, tokensPerDay: 1_000_000, requestsPerMinute: 10 } }
  secrets.set(FREE_PROVIDER_ID, 'EAON-ABCD-EFGH-JKMN')
  store.setJson('free-credits-code.json', code)
  assert.deepEqual(activeCode(), code)

  // Unreadable (the stub has no keychain, so bytes that aren't the vault's JSON can't be read).
  writeFileSync(vault, Buffer.from([0xde, 0xad, 0xbe, 0xef]))
  assert.equal(secrets.readable(), false)
  assert.equal(activeCode(), null, 'not usable while locked')
  assert.deepEqual(store.getJson('free-credits-code.json', null), code, 'but not forgotten')

  // Unlocked again: the code is back.
  rmSync(vault, { force: true })
  secrets.set(FREE_PROVIDER_ID, 'EAON-ABCD-EFGH-JKMN')
  assert.deepEqual(activeCode(), code)

  // Readable and really missing: forgotten, as before.
  secrets.clear(FREE_PROVIDER_ID)
  assert.equal(activeCode(), null)
  assert.equal(store.getJson('free-credits-code.json', null), null)
  assert.equal(existsSync(`${vault}.tmp`), false, 'the durable write leaves no temporary file behind')
})

test('Copilot sign-in keeps polling through a dropped connection and a proxy error page', { timeout: 30_000 }, async () => {
  const real = globalThis.fetch
  const polls: string[] = []
  const answers: (() => Response | Promise<Response>)[] = [
    () => Promise.reject(fetchFailed('ECONNRESET')),
    () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
    () => Response.json({ error: 'authorization_pending' }),
    () => Response.json({ access_token: 'gho_test' })
  ]
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/login/device/code')) return Response.json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900 })
    if (url.endsWith('/login/oauth/access_token')) {
      polls.push(url)
      return answers[polls.length - 1]()
    }
    if (url.endsWith('/copilot_internal/v2/token')) return Response.json({ token: 'tid=1;proxy-ep=proxy.individual.githubcopilot.com;', expires_at: Math.floor(Date.now() / 1000) + 1800 })
    if (url.endsWith('/user')) return Response.json({ login: 'octo' })
    return Response.json({ data: [] })
  }) as typeof fetch
  try {
    await copilotFlow.signIn(() => {}, new AbortController().signal)
    assert.equal(polls.length, 4)
    assert.equal(copilotFlow.isSignedIn(), true)
    assert.equal(copilotFlow.account?.(), '@octo')
  } finally {
    globalThis.fetch = real
    await copilotFlow.signOut()
  }
})

test('run_command uses bash whatever the login shell is', { skip: process.platform === 'win32' || !existsSync('/bin/bash') }, async () => {
  const saved = process.env.SHELL
  process.env.SHELL = '/usr/local/bin/fish-that-is-not-here'
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-shell-'))
  try {
    const settings = store.getSettings()
    const request = { mode: 'work', work: { swarm: false, plan: false }, goal: null } as unknown as StreamRequest
    const list = toolsFor({ mode: 'work', cwd, depth: 0, readOnly: false, settings, request })
    const ctx = { cwd, settings, signal: new AbortController().signal, progress: () => {} } as unknown as ToolContext
    const out = String(await list.find((t) => t.name === 'run_command')!.run({ command: 'export A=b && [[ -n "$BASH_VERSION" ]] && echo "bash:$A"', timeout_seconds: 20 }, ctx))
    assert.match(out, /bash:b/)
  } finally {
    if (saved === undefined) delete process.env.SHELL
    else process.env.SHELL = saved
    rmSync(cwd, { recursive: true, force: true })
  }
})
