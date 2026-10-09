import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The CLI's API keys: the provider directory merged with the app's
 * built-ins, saving a key (creating a directory provider, filling a
 * templated endpoint, checking it by listing models), custom endpoints,
 * and the /keys screen. A local server stands in for the providers.
 */

process.env.EAON_CLI_HOME = mkdtempSync(join(tmpdir(), 'eaon-cli-keys-'))

const { secrets } = await import('../src/main/secrets')
const { getProvider, listProviders } = await import('../src/main/providers')
const { BUILT_IN } = await import('../src/main/providers/catalog')
const dir = await import('../cli/src/core/providerDirectory')

let server: Server
let base = ''
const seen: string[] = []

before(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`)
    if (req.url?.endsWith('/models')) {
      if (req.headers.authorization !== 'Bearer good-key') return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"Incorrect API key provided"}}')
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'fast-1', object: 'model' }, { id: 'smart-2', object: 'model' }] }))
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(() => server.close())

test('directory: built-in providers that take a key or sign-in, then the directory’s, grouped and without duplicates', () => {
  const rows = dir.keyRows()
  const ids = rows.map((r) => r.id)
  assert.equal(new Set(ids).size, ids.length, 'no provider twice')
  const builtIns = BUILT_IN.filter((p) => !p.local)
  assert.ok(builtIns.every((p) => ids.includes(p.id)), 'every built-in that takes a key is there')
  assert.ok(!ids.includes('ollama') && !ids.includes('lm-studio'), 'local runtimes need no key')
  assert.equal(rows.length, builtIns.length + dir.DIRECTORY.length)
  assert.ok(rows.length >= 90, `a large list (${rows.length})`)
  for (const entry of dir.DIRECTORY) {
    assert.ok(!BUILT_IN.some((p) => p.id === entry.id), `${entry.id} doesn’t shadow a built-in`)
    assert.match(entry.baseUrl, /^https:\/\/[^\s{}]+$/, `${entry.id}: a plain https URL`)
    assert.ok(entry.description.endsWith('.'), `${entry.id}: a description`)
  }
  // Grouped in the screen's order.
  const order = dir.GROUPS.map((g) => g.id)
  const groups = rows.map((r) => order.indexOf(r.group))
  assert.deepEqual(groups, [...groups].sort((a, b) => a - b))
  assert.equal(rows.find((r) => r.id === 'chatgpt')?.auth, 'oauth')
  assert.deepEqual(rows.filter((r) => r.group === 'frontier').slice(0, 3).map((r) => r.id), ['anthropic', 'openai', 'gemini'], 'the popular ones first')
  assert.equal(rows.find((r) => r.id === 'siliconflow')?.extra, true)
})

test('errors: provider bodies become one readable line', () => {
  assert.equal(dir.readableError('401 {"code":30014,"data":null,"message":"Token is invalid."}'), '401 — Token is invalid.')
  assert.equal(dir.readableError('401 {"error":{"message":"Invalid API Key","type":"invalid_request_error"}}'), '401 — Invalid API Key')
  assert.equal(dir.readableError('401 {"detail":"Invalid API Key"}'), '401 — Invalid API Key')
  assert.equal(dir.readableError('401 {"tpe":"fail.auth","errors":[{"description":"No api key passed in."}]}'), '401 — No api key passed in.')
  assert.equal(dir.readableError('fetch failed'), 'fetch failed')
})

test('find: by id, by name in any case, or by the start of a name', () => {
  assert.equal(dir.findKeyRow('groq')?.id, 'groq')
  assert.equal(dir.findKeyRow('Together AI')?.id, 'together')
  assert.equal(dir.findKeyRow('silicon')?.id, 'siliconflow')
  assert.equal(dir.findKeyRow('no such thing'), undefined)
})

test('templates: Cloudflare’s account and gateway ids fill its URL and are read back from it', () => {
  const row = dir.keyRows().find((r) => r.id === 'cloudflare-ai-gateway')!
  assert.deepEqual(row.fields.map((f) => f.key), ['account_id', 'gateway_id'])
  const url = dir.fillTemplate(row.template!, { account_id: 'abc123', gateway_id: 'main' })
  assert.equal(url, 'https://gateway.ai.cloudflare.com/v1/abc123/main/compat')
  assert.equal(dir.fillTemplate(row.template!, { account_id: 'abc123' }), '', 'a missing value leaves no half-filled URL')
  assert.deepEqual(dir.templateValues({ ...row, baseUrl: url }), { account_id: 'abc123', gateway_id: 'main' })
  assert.deepEqual(dir.templateValues(row), {}, 'the unfilled template isn’t read as values')
  const bedrock = dir.keyRows().find((r) => r.id === 'amazon-bedrock')!
  assert.equal(dir.templateValues(bedrock).region, 'us-east-1', 'defaults fill in')
})

test('saving: a directory provider is created with its endpoint, the key is checked by listing models, and removing it removes the provider', async () => {
  const row: import('../cli/src/core/providerDirectory').KeyRow = {
    ...dir.keyRows().find((r) => r.id === 'siliconflow')!,
    baseUrl: `${base}/sf/v1`
  }
  assert.equal(getProvider('siliconflow'), undefined)
  const wrong = await dir.saveProviderKey(row, 'bad-key')
  assert.equal(wrong.ok, false)
  // What to do, not the status code; the provider's own words stay in the issue's details.
  assert.equal(wrong.message, 'SiliconFlow rejected the API key. Check it, or paste a new one.', 'what to do, not its JSON')
  assert.equal(secrets.get('siliconflow'), 'bad-key', 'kept even when the check fails')
  const right = await dir.saveProviderKey({ ...row, extra: false }, 'good-key')
  assert.deepEqual([right.ok, right.models], [true, 2])
  const provider = getProvider('siliconflow')!
  assert.equal(provider.name, 'SiliconFlow')
  assert.equal(provider.baseUrl, `${base}/sf/v1`)
  assert.equal(provider.enabled, true)
  assert.deepEqual(provider.models.map((m) => m.id).sort(), ['fast-1', 'smart-2'])
  const listed = dir.keyRows().find((r) => r.id === 'siliconflow')!
  assert.deepEqual([listed.ready, listed.extra, listed.group, listed.models], [true, false, 'inference', 2], 'shown in its directory group, set up')

  dir.removeProviderKey(listed)
  assert.equal(getProvider('siliconflow'), undefined)
  assert.equal(secrets.has('siliconflow'), false)
  assert.equal(dir.keyRows().find((r) => r.id === 'siliconflow')?.extra, true, 'back to a directory entry')
})

test('saving: a templated endpoint is filled in before the check', async () => {
  const row = { ...dir.keyRows().find((r) => r.id === 'cloudflare-workers-ai')!, template: `${base}/accounts/{account_id}/v1` }
  await assert.rejects(dir.saveProviderKey(row, 'good-key', {}), /Fill in Account ID/)
  const result = await dir.saveProviderKey(row, 'good-key', { account_id: 'acct9' })
  assert.equal(getProvider('cloudflare-workers-ai')!.baseUrl, `${base}/accounts/acct9/v1`)
  assert.equal(secrets.get('cloudflare-workers-ai'), 'good-key')
  // Cloudflare has no listing; the check says the key is used on the first request.
  assert.equal(result.ok, true)
})

test('your own: an endpoint gets a free id from its name, and its models are listed', async () => {
  const one = await dir.addCustomProvider({ name: 'Company Gateway', baseUrl: `${base}/co/v1`, kind: 'openai-compatible', key: 'good-key' })
  assert.deepEqual([one.id, one.ok, one.models], ['company-gateway', true, 2])
  const two = await dir.addCustomProvider({ name: 'Company Gateway', baseUrl: `${base}/co2/v1`, kind: 'openai-compatible', key: 'good-key' })
  assert.equal(two.id, 'company-gateway-2')
  await assert.rejects(dir.addCustomProvider({ name: 'Groq clone', baseUrl: 'ftp://nope', kind: 'openai-compatible' }), /starts with http/)
  const named = await dir.addCustomProvider({ name: 'SiliconFlow', baseUrl: `${base}/x/v1`, kind: 'openai-compatible', key: 'good-key' })
  assert.equal(named.id, 'siliconflow-2', 'never takes a directory provider’s id')
  assert.equal(dir.keyRows().find((r) => r.id === 'company-gateway')?.group, 'custom')
  assert.ok(listProviders().some((p) => p.id === 'company-gateway' && p.models.length === 2))
})

test('/keys screen: grouped list with counts, search narrows it, ⏎ asks for the key', async () => {
  const { KeysScreen } = await import('../cli/src/tui/keys')
  const { Screen } = await import('../cli/src/tui/screen')
  const pushed: { constructor: { name: string } }[] = []
  const app = { push: (m: never) => void pushed.push(m), invalidate() {}, toast() {} } as never
  const screen = new KeysScreen(app)
  const draw = (): string => Screen.snapshot(140, 44, (c) => screen.draw(c)).text
  const first = draw()
  assert.match(first, /API keys/)
  assert.match(first, /MODEL MAKERS/)
  assert.match(first, /set up · \d{2,3} providers/)
  const key = (name: string, ch?: string, ctrl = false): void => screen.onEvent({ type: 'key', name, ch, ctrl, meta: false, shift: false } as never)
  for (const ch of 'groq') key(ch, ch)
  const searched = draw()
  assert.match(searched, /Groq/)
  assert.doesNotMatch(searched, /Anthropic/)
  assert.match(searched, /https:\/\/console\.groq\.com/, 'where to get a key')
  key('enter')
  assert.equal(pushed.at(-1)?.constructor.name, 'PromptModal')
  // Esc clears the search first, keeping Groq selected among all of them.
  key('escape')
  const cleared = draw()
  assert.match(cleared, /type to search/)
  assert.match(cleared, /OpenCode Go/)
  assert.match(cleared, /│ {2}Groq {2,}/, 'still showing Groq')
})
