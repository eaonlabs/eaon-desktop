import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GatewayInfo } from '@shared/gateway'
import { ConnectApps, type ConnectDeps } from '../src/main/features/connectApps/service'
import { StateFile } from '../src/main/features/connectApps/state'
import { launchScript, type LaunchSpec } from '../src/main/features/connectApps/launch'
import { getTableValue, getTopLevel, removeTable, removeTopLevel, setTable, setTopLevel, tomlValue } from '../src/main/features/connectApps/toml'
import { hasChild, removeChild, setChild } from '../src/main/features/connectApps/yamlBlock'

/**
 * Connect apps: Eaon writing other apps' settings so they use its gateway.
 * Every test runs against a temporary home folder; nothing here reads or
 * writes the real ~/.claude, ~/.codex and the rest.
 */

const info: GatewayInfo = {
  running: true,
  port: 4567,
  openaiBaseUrl: 'http://127.0.0.1:4567/v1',
  anthropicBaseUrl: 'http://127.0.0.1:4567',
  token: 'eaon_test_token',
  models: [
    { id: 'fake/big', label: 'Big', provider: 'fake', providerName: 'Fake', contextWindow: 400_000, vision: true, efforts: ['light', 'medium', 'high', 'ultra'] },
    { id: 'fake/small', label: 'Small', provider: 'fake', providerName: 'Fake' },
    { id: 'other/coder', label: 'Coder', provider: 'other', providerName: 'Other' }
  ],
  defaultModel: 'fake/big',
  smallModel: 'fake/small'
}

function setup(over: Partial<ConnectDeps> = {}): { home: string; data: string; apps: ConnectApps; started: () => number; gateway: { info: GatewayInfo } } {
  const home = mkdtempSync(join(tmpdir(), 'eaon-connect-home-'))
  const data = mkdtempSync(join(tmpdir(), 'eaon-connect-data-'))
  let started = 0
  const gateway = { info: { ...info } }
  const apps = new ConnectApps({
    home,
    platform: 'darwin',
    state: StateFile.in(data),
    info: () => gateway.info,
    ensureRunning: async () => {
      started++
      return gateway.info
    },
    which: () => null,
    ...over
  })
  return { home, data, apps, started: () => started, gateway }
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const read = (path: string): string => readFileSync(path, 'utf8')
const readJson = (path: string): Record<string, unknown> => JSON.parse(read(path)) as Record<string, unknown>

/* ------------------------------------------------------------------ TOML */

const CODEX_TOML = `# my codex settings
approval_policy = "on-request"
notify = [
  "say",
  "[not a header]",
]
instructions = """
model = "inside a string"
[also not a header]
"""

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]

[profiles.fast]
model = "gpt-5-mini"
`

test('TOML: setting and removing top-level keys leaves the rest byte for byte', () => {
  let text = setTopLevel(CODEX_TOML, 'model', '"fake/big"')
  text = setTopLevel(text, 'model_provider', '"eaon"')
  assert.equal(tomlValue(getTopLevel(text, 'model')), 'fake/big')
  assert.equal(tomlValue(getTopLevel(text, 'model_provider')), 'eaon')
  // A `model = …` inside a table, or inside a multi-line string, isn't top level.
  assert.equal(getTopLevel(CODEX_TOML, 'model'), null)
  assert.match(getTopLevel(CODEX_TOML, 'notify') ?? '', /\[not a header\]/)
  text = removeTopLevel(removeTopLevel(text, 'model_provider'), 'model')
  assert.equal(text, CODEX_TOML)
})

test('TOML: replacing a value that spans lines replaces all of it', () => {
  const text = setTopLevel(CODEX_TOML, 'notify', '["eaon"]')
  assert.ok(!text.includes('"say"'))
  assert.ok(text.includes('notify = ["eaon"]\ninstructions = """'))
})

test('TOML: keys go in at the top of a file that starts with a table, and come out cleanly', () => {
  const original = '[mcp_servers.docs]\ncommand = "npx"\n'
  let text = setTopLevel(original, 'model', '"fake/big"')
  text = setTopLevel(text, 'model_provider', '"eaon"')
  assert.equal(text, 'model = "fake/big"\nmodel_provider = "eaon"\n\n[mcp_servers.docs]\ncommand = "npx"\n')
  assert.equal(removeTopLevel(removeTopLevel(text, 'model'), 'model_provider'), original)
})

test('TOML: a table is appended, replaced in place and removed', () => {
  let text = setTable(CODEX_TOML, 'model_providers.eaon', [
    ['name', '"Eaon"'],
    ['base_url', '"http://127.0.0.1:1/v1"']
  ])
  assert.equal(tomlValue(getTableValue(text, 'model_providers.eaon', 'base_url')), 'http://127.0.0.1:1/v1')
  text = setTable(text, 'model_providers.eaon', [['base_url', '"http://127.0.0.1:2/v1"']])
  assert.equal(tomlValue(getTableValue(text, 'model_providers.eaon', 'base_url')), 'http://127.0.0.1:2/v1')
  assert.equal(getTableValue(text, 'model_providers.eaon', 'name'), null)
  assert.equal(removeTable(text, 'model_providers.eaon'), CODEX_TOML)
  // Replacing a table in the middle keeps the one after it.
  const middle = setTable(CODEX_TOML, 'mcp_servers.docs', [['command', '"docs"']])
  assert.ok(middle.includes('[mcp_servers.docs]\ncommand = "docs"\n\n[profiles.fast]'))
})

/* ------------------------------------------------------------------ YAML */

const OMP_YAML = `# models
providers:
  local:
    baseUrl: "http://localhost:8080/v1"
    api: openai-completions
    models:
      - id: llama
defaults:
  model: local/llama
`

test('YAML: a child block is added under a parent and removed again', () => {
  const text = setChild(OMP_YAML, 'providers', 'eaon', { baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fake/big', name: 'Big' }] })
  assert.ok(hasChild(text, 'providers', 'eaon'))
  assert.ok(hasChild(text, 'providers', 'local'))
  assert.ok(text.includes('  eaon:\n    baseUrl: "http://127.0.0.1:1/v1"\n    models:\n      - id: "fake/big"\n        name: "Big"\ndefaults:'))
  assert.equal(removeChild(text, 'providers', 'eaon'), OMP_YAML)
})

test('YAML: a missing or `{}` parent is created, and tabs or flow style are refused', () => {
  const fresh = setChild('', 'providers', 'eaon', { api: 'x' })
  assert.equal(fresh, 'providers:\n  eaon:\n    api: "x"\n')
  assert.equal(removeChild(fresh, 'providers', 'eaon'), '')
  assert.ok(hasChild(setChild('providers: {}\n', 'providers', 'eaon', { api: 'x' }), 'providers', 'eaon'))
  assert.throws(() => setChild('providers:\n\tlocal: {}\n', 'providers', 'eaon', {}), /tabs/)
  assert.throws(() => setChild('providers: { local: {} }\n', 'providers', 'eaon', {}), /one line/)
})

/* ------------------------------------------------------------- Claude Code */

const CLAUDE_SETTINGS = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  theme: 'dark',
  env: { FOO: '1', ANTHROPIC_MODEL: 'opus' },
  permissions: { allow: ['Bash(npm test)'] }
}

test('Claude Code: connect merges Eaon\'s env keys, backs up once, and disconnect puts the file back exactly', async () => {
  const { home, apps, started } = setup()
  const file = join(home, '.claude', 'settings.json')
  const original = `${JSON.stringify(CLAUDE_SETTINGS, null, 2)}\n`
  put(file, original)

  const result = await apps.connect('claude-code')
  assert.ok(result.ok, !result.ok ? result.error : '')
  assert.equal(started(), 1, 'connecting starts the gateway')
  const env = readJson(file).env as Record<string, string>
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4567')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'eaon_test_token')
  assert.equal(env.ANTHROPIC_API_KEY, '')
  assert.equal(env.ANTHROPIC_MODEL, 'fake/big')
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'fake/big')
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'fake/big')
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'fake/small')
  assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1')
  assert.equal(env.FOO, '1')
  assert.equal(readJson(file).theme, 'dark')
  assert.deepEqual(readJson(file).permissions, CLAUDE_SETTINGS.permissions)
  assert.equal(read(`${file}.eaon-backup`), original)
  assert.deepEqual(result.written, [{ path: '~/.claude/settings.json', keys: [
    'env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_AUTH_TOKEN', 'env.ANTHROPIC_API_KEY', 'env.ANTHROPIC_MODEL',
    'env.ANTHROPIC_DEFAULT_OPUS_MODEL', 'env.ANTHROPIC_DEFAULT_SONNET_MODEL', 'env.ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'
  ] }])
  const status = apps.list().find((a) => a.id === 'claude-code')!
  assert.equal(status.connected, true)
  assert.equal(status.stale, undefined)
  assert.equal(status.model, 'fake/big')
  assert.equal(status.smallModel, 'fake/small')

  // Again, with other models: the backup stays the original, and so does what disconnect restores.
  const again = await apps.connect('claude-code', { model: 'other/coder', smallModel: null })
  assert.ok(again.ok)
  assert.equal((readJson(file).env as Record<string, string>).ANTHROPIC_DEFAULT_HAIKU_MODEL, 'other/coder')
  assert.equal(read(`${file}.eaon-backup`), original)

  const off = await apps.disconnect('claude-code')
  assert.ok(off.ok, !off.ok ? off.error : '')
  assert.deepEqual(readJson(file), CLAUDE_SETTINGS)
  assert.equal(apps.list().find((a) => a.id === 'claude-code')!.connected, false)
})

test('Claude Code: a key the user changed after connecting is theirs and stays', async () => {
  const { home, apps } = setup()
  const file = join(home, '.claude', 'settings.json')
  put(file, JSON.stringify(CLAUDE_SETTINGS))
  await apps.connect('claude-code')
  const edited = readJson(file)
  ;(edited.env as Record<string, string>).ANTHROPIC_MODEL = 'mine/model'
  put(file, JSON.stringify(edited))
  await apps.disconnect('claude-code')
  const env = readJson(file).env as Record<string, string>
  assert.equal(env.ANTHROPIC_MODEL, 'mine/model')
  assert.equal(env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(env.FOO, '1')
})

test('Claude Code: a new port or key shows as needing a reconnect', async () => {
  const { apps, gateway } = setup()
  await apps.connect('claude-code')
  gateway.info = { ...info, port: 9999, anthropicBaseUrl: 'http://127.0.0.1:9999', openaiBaseUrl: 'http://127.0.0.1:9999/v1' }
  const status = apps.list().find((a) => a.id === 'claude-code')!
  assert.equal(status.connected, true)
  assert.equal(status.stale, true)
})

test('Claude Code: the old Claude Code page\'s keys are recognised and cleaned up', async () => {
  const { home, apps } = setup()
  const file = join(home, '.claude', 'settings.json')
  const legacy = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1337', ANTHROPIC_AUTH_TOKEN: 'eaon-local', ANTHROPIC_SMALL_FAST_MODEL: 'x', KEEP: 'y' } }
  put(file, JSON.stringify(legacy))
  const status = apps.list().find((a) => a.id === 'claude-code')!
  assert.equal(status.connected, true)
  assert.equal(status.stale, true)

  // Disconnecting with no record removes them.
  const off = await apps.disconnect('claude-code')
  assert.ok(off.ok, !off.ok ? off.error : '')
  assert.deepEqual(readJson(file), { env: { KEEP: 'y' } })

  // Connecting over them doesn't make them the thing disconnect restores.
  put(file, JSON.stringify(legacy))
  await apps.connect('claude-code')
  await apps.disconnect('claude-code')
  assert.deepEqual(readJson(file), { env: { KEEP: 'y' } })
})

test('Claude Code: a settings file that isn\'t plain JSON is refused, not rewritten', async () => {
  const { home, apps } = setup()
  const file = join(home, '.claude', 'settings.json')
  const text = '{\n  // my comment\n  "theme": "dark"\n}\n'
  put(file, text)
  const status = apps.list().find((a) => a.id === 'claude-code')!
  assert.match(status.error ?? '', /isn't plain JSON/)
  const result = await apps.connect('claude-code')
  assert.equal(result.ok, false)
  assert.equal(read(file), text)
  assert.equal(existsSync(`${file}.eaon-backup`), false)
})

test('Claude Code: a file Eaon created is removed again on disconnect', async () => {
  const { home, apps } = setup()
  const file = join(home, '.claude', 'settings.json')
  await apps.connect('claude-code')
  assert.ok(existsSync(file))
  await apps.disconnect('claude-code')
  assert.equal(existsSync(file), false)
})

/* ------------------------------------------------------------------ Codex */

test('ChatGPT: config.toml gets model, model_provider and [model_providers.eaon], and comes back byte for byte', async () => {
  const { home, apps } = setup()
  const file = join(home, '.codex', 'config.toml')
  const original = `model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n\n[mcp_servers.docs]\ncommand = "npx"\n\n[plugins."computer-use@openai-bundled"]\nenabled = true\n`
  put(file, original)
  const result = await apps.connect('chatgpt', { model: 'other/coder' })
  assert.ok(result.ok, !result.ok ? result.error : '')
  const text = read(file)
  assert.equal(tomlValue(getTopLevel(text, 'model')), 'other/coder')
  assert.equal(tomlValue(getTopLevel(text, 'model_provider')), 'eaon')
  assert.equal(tomlValue(getTableValue(text, 'model_providers.eaon', 'base_url')), 'http://127.0.0.1:4567/v1')
  assert.equal(tomlValue(getTableValue(text, 'model_providers.eaon', 'wire_api')), 'responses')
  assert.equal(tomlValue(getTableValue(text, 'model_providers.eaon', 'experimental_bearer_token')), 'eaon_test_token')
  assert.ok(text.includes('[plugins."computer-use@openai-bundled"]\nenabled = true'))
  assert.equal(apps.list().find((a) => a.id === 'chatgpt')!.connected, true)
  assert.equal(apps.list().find((a) => a.id === 'codex-cli')!.connected, false, 'the CLI profile is separate')

  // A reconnect keeps the original model as the one to restore.
  await apps.connect('chatgpt', { model: 'fake/big' })
  const off = await apps.disconnect('chatgpt')
  assert.ok(off.ok)
  assert.equal(read(file), original)
})

test('ChatGPT: with no config.toml before, disconnect removes the one Eaon made', async () => {
  const { home, apps } = setup()
  const file = join(home, '.codex', 'config.toml')
  const catalog = join(home, '.codex', 'eaon-models.json')
  await apps.connect('chatgpt')
  assert.equal(
    read(file),
    `model = "fake/big"\nmodel_provider = "eaon"\nmodel_catalog_json = ${JSON.stringify(catalog)}\n\n[model_providers.eaon]\nname = "Eaon"\nbase_url = "http://127.0.0.1:4567/v1"\nwire_api = "responses"\nexperimental_bearer_token = "eaon_test_token"\n`
  )
  await apps.disconnect('chatgpt')
  assert.equal(existsSync(file), false)
  assert.equal(existsSync(catalog), false)
})

type CatalogEntry = Record<string, unknown> & { slug: string }
const catalogOf = (path: string): CatalogEntry[] => (readJson(path) as { models: CatalogEntry[] }).models

test('ChatGPT: every model picked goes in a model catalog, the default first, so ChatGPT\'s picker lists them', async () => {
  const { home, apps } = setup()
  const file = join(home, '.codex', 'config.toml')
  const catalog = join(home, '.codex', 'eaon-models.json')
  // What `ollama launch codex` leaves behind: its own catalog, which lists none of Eaon's models.
  const original = `model = "gpt-6-luna"\nmodel_catalog_json = "/Users/me/.codex/ollama-launch-models.json"\n\n[desktop]\nappearanceTheme = "dark"\n`
  put(file, original)
  const result = await apps.connect('chatgpt', { model: 'other/coder', models: ['fake/big', 'other/coder'] })
  assert.ok(result.ok, !result.ok ? result.error : '')
  assert.equal(tomlValue(getTopLevel(read(file), 'model_catalog_json')), catalog)
  const entries = catalogOf(catalog)
  assert.deepEqual(entries.map((e) => e.slug), ['other/coder', 'fake/big'])
  assert.deepEqual(result.written.map((w) => w.path), ['~/.codex/config.toml', '~/.codex/eaon-models.json'])

  // Described from what Eaon knows about each model; Codex's own prompt where it would fall back to it.
  const big = entries[1]
  assert.equal(big.display_name, 'Big')
  assert.equal(big.context_window, 400_000)
  assert.deepEqual(big.input_modalities, ['text', 'image'])
  assert.deepEqual((big.supported_reasoning_levels as { effort: string }[]).map((l) => l.effort), ['low', 'medium', 'high', 'max'])
  assert.equal(big.default_reasoning_level, 'medium')
  assert.match(String(big.base_instructions), /^You are a coding agent running in the Codex CLI/)
  const coder = entries[0]
  assert.deepEqual(coder.supported_reasoning_levels, [])
  assert.equal(coder.default_reasoning_level, null)
  assert.deepEqual(coder.input_modalities, ['text'])

  const status = apps.list().find((a) => a.id === 'chatgpt')!
  assert.equal(status.connected, true)
  assert.equal(status.stale, undefined)
  assert.equal(status.multiModel, true)
  assert.deepEqual(status.models, ['other/coder', 'fake/big'])

  // Fewer models: the catalog follows; ChatGPT may save a picked one as `model`, and disconnect still takes it back.
  await apps.connect('chatgpt', { model: 'fake/big', models: ['fake/big', 'fake/small'] })
  assert.deepEqual(catalogOf(catalog).map((e) => e.slug), ['fake/big', 'fake/small'])
  put(file, setTopLevel(read(file), 'model', '"fake/small"'))
  assert.equal(apps.list().find((a) => a.id === 'chatgpt')!.model, 'fake/small')
  const off = await apps.disconnect('chatgpt')
  assert.ok(off.ok)
  assert.equal(read(file), original, 'Ollama\'s catalog and the original model are back')
  assert.equal(existsSync(catalog), false)
  assert.equal(existsSync(`${catalog}.eaon-backup`), false, 'Eaon\'s own catalog is never backed up')
})

test('ChatGPT: a connection from before catalogs needs a reconnect, and is repaired on its own', async () => {
  const { home, apps, data } = setup()
  const file = join(home, '.codex', 'config.toml')
  const before = `model = "gpt-6-luna"\nmodel_catalog_json = "/Users/me/.codex/ollama-launch-models.json"\n`
  // As the previous Eaon left it: the provider selected, no catalog, a record without `models` or `before.catalog`.
  put(
    file,
    `model = "other/coder"\nmodel_catalog_json = "/Users/me/.codex/ollama-launch-models.json"\nmodel_provider = "eaon"\n\n[model_providers.eaon]\nname = "Eaon"\nbase_url = "http://127.0.0.1:4567/v1"\nwire_api = "responses"\nexperimental_bearer_token = "eaon_test_token"\n`
  )
  StateFile.in(data).set('chatgpt', { model: 'other/coder', smallModel: null, connectedAt: 1, keys: {}, extra: { before: { model: '"gpt-6-luna"', provider: null } } })
  const stale = apps.list().find((a) => a.id === 'chatgpt')!
  assert.equal(stale.connected, true)
  assert.equal(stale.stale, true)

  assert.deepEqual(await apps.refreshStale(), ['chatgpt'])
  assert.deepEqual(catalogOf(join(home, '.codex', 'eaon-models.json')).map((e) => e.slug), ['other/coder'])
  assert.equal(apps.list().find((a) => a.id === 'chatgpt')!.stale, undefined)
  assert.deepEqual(await apps.refreshStale(), [], 'nothing left to fix')

  await apps.disconnect('chatgpt')
  assert.equal(read(file), before)
})

test('refreshing: a new gateway port reconnects the apps Eaon set up, and leaves the rest alone', async () => {
  const { home, apps, gateway } = setup()
  await apps.connect('opencode', { model: 'fake/big', models: ['fake/big', 'other/coder'] })
  put(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://example.com' } }))
  gateway.info = { ...info, port: 5000, openaiBaseUrl: 'http://127.0.0.1:5000/v1', anthropicBaseUrl: 'http://127.0.0.1:5000' }
  assert.equal(apps.list().find((a) => a.id === 'opencode')!.stale, true)
  assert.deepEqual(await apps.refreshStale(), ['opencode'])
  const config = readJson(join(home, '.config', 'opencode', 'opencode.json'))
  const provider = (config.provider as Record<string, Record<string, unknown>>).eaon
  assert.equal((provider.options as Record<string, unknown>).baseURL, 'http://127.0.0.1:5000/v1')
  assert.deepEqual(Object.keys(provider.models as object), ['fake/big', 'other/coder', 'fake/small'], 'the same models as before')
  assert.deepEqual(readJson(join(home, '.claude', 'settings.json')), { env: { ANTHROPIC_BASE_URL: 'https://example.com' } })
})

test('ChatGPT: restarting it goes through the Mac app, and only on a Mac', async () => {
  const restarted: string[] = []
  const mac = setup({ restartApp: async (name) => (restarted.push(name), { ok: true, action: 'reopened' }), appRunning: async () => true })
  mkdirSync(join(mac.home, '.codex'))
  assert.equal(mac.apps.list().find((a) => a.id === 'chatgpt')!.restartable, true)
  assert.equal(mac.apps.list().find((a) => a.id === 'opencode')!.restartable, false)
  assert.equal(await mac.apps.running('chatgpt'), true)
  assert.deepEqual(await mac.apps.restart('chatgpt'), { ok: true, action: 'reopened' })
  assert.deepEqual(restarted, ['ChatGPT'])

  const linux = setup({ platform: 'linux', restartApp: async () => ({ ok: true, action: 'opened' }) })
  mkdirSync(join(linux.home, '.codex'))
  assert.equal(linux.apps.list().find((a) => a.id === 'chatgpt')!.restartable, false)
  assert.equal((await linux.apps.restart('chatgpt')).ok, false)
})

/** The Codex installed here, if any: the one inside ChatGPT, else one on PATH. */
const installedCodex = ['/Applications/ChatGPT.app/Contents/Resources/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex'].find((p) => existsSync(p))
test('ChatGPT: the installed Codex accepts Eaon\'s catalog (a catalog it rejects makes it drop all of config.toml)', { skip: !installedCodex }, async () => {
  const { home, apps } = setup()
  const result = await apps.connect('chatgpt', { model: 'fake/big', models: ['fake/big', 'fake/small', 'other/coder'] })
  assert.ok(result.ok, !result.ok ? result.error : '')
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(installedCodex!, ['debug', 'models'], { env: { ...process.env, CODEX_HOME: join(home, '.codex') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += String(c)))
    child.stderr.on('data', (c) => (stderr += String(c)))
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr || `codex exited with ${code}`))))
  })
  const listedByCodex = (JSON.parse(out) as { models: { slug: string; display_name: string }[] }).models
  assert.deepEqual(listedByCodex.map((m) => m.slug), ['fake/big', 'fake/small', 'other/coder'])
  assert.deepEqual(listedByCodex.map((m) => m.display_name), ['Big', 'Small', 'Coder'])
})

test('Codex CLI: a profile file of its own, and a foreign one is left alone', async () => {
  const { home, apps } = setup()
  const profile = join(home, '.codex', 'eaon.config.toml')
  const catalog = join(home, '.codex', 'eaon-cli-models.json')
  const result = await apps.connect('codex-cli', { model: 'fake/big', models: ['other/coder'] })
  assert.ok(result.ok)
  const text = read(profile)
  assert.ok(text.startsWith('# Written by Eaon'))
  assert.equal(tomlValue(getTopLevel(text, 'model_provider')), 'eaon')
  assert.equal(tomlValue(getTopLevel(text, 'model_catalog_json')), catalog)
  assert.deepEqual(catalogOf(catalog).map((e) => e.slug), ['fake/big', 'other/coder'])
  assert.equal(existsSync(join(home, '.codex', 'config.toml')), false, 'the default config is untouched')
  await apps.connect('codex-cli', { model: 'fake/big', models: ['fake/big'] })
  assert.equal(existsSync(`${profile}.eaon-backup`), false, 'Eaon\'s own profile is never backed up')
  await apps.disconnect('codex-cli')
  assert.equal(existsSync(profile), false)
  assert.equal(existsSync(catalog), false)

  put(profile, 'model = "mine"\n')
  const refused = await apps.connect('codex-cli')
  assert.equal(refused.ok, false)
  assert.equal(read(profile), 'model = "mine"\n')
})

/* ------------------------------------------------------- other JSON apps */

test('OpenCode: provider.eaon and the default models, restored exactly', async () => {
  const { home, apps } = setup()
  const file = join(home, '.config', 'opencode', 'opencode.json')
  const original = { $schema: 'https://opencode.ai/config.json', model: 'anthropic/claude-x', provider: { ollama: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://localhost:11434/v1' } } } }
  put(file, JSON.stringify(original, null, 2))
  const result = await apps.connect('opencode')
  assert.ok(result.ok, !result.ok ? result.error : '')
  const data = readJson(file)
  assert.equal(data.model, 'eaon/fake/big')
  assert.equal(data.small_model, 'eaon/fake/small')
  const provider = (data.provider as Record<string, Record<string, unknown>>).eaon
  assert.equal(provider.npm, '@ai-sdk/openai-compatible')
  assert.deepEqual(provider.options, { baseURL: 'http://127.0.0.1:4567/v1', apiKey: 'eaon_test_token' })
  assert.deepEqual(Object.keys(provider.models as object), ['fake/big', 'fake/small'])
  assert.ok((data.provider as Record<string, unknown>).ollama)
  await apps.disconnect('opencode')
  assert.deepEqual(readJson(file), original)
})

test('OpenClaw: a JSON5 file with comments is refused; plain JSON is merged and restored', async () => {
  const { home, apps } = setup()
  const file = join(home, '.openclaw', 'openclaw.json')
  put(file, '{\n  // json5\n  agents: { defaults: {} },\n}\n')
  assert.match(apps.list().find((a) => a.id === 'openclaw')!.error ?? '', /isn't plain JSON/)
  assert.equal((await apps.connect('openclaw')).ok, false)

  const original = { agents: { defaults: { model: { primary: 'anthropic/claude-x' }, workspace: '~/claw' } } }
  put(file, JSON.stringify(original))
  assert.ok((await apps.connect('openclaw')).ok)
  const data = readJson(file) as { models: { providers: { eaon: Record<string, unknown> } }; agents: { defaults: { model: { primary: string } } } }
  assert.equal(data.models.providers.eaon.api, 'openai-completions')
  assert.equal(data.models.providers.eaon.baseUrl, 'http://127.0.0.1:4567/v1')
  assert.equal(data.agents.defaults.model.primary, 'eaon/fake/big')
  await apps.disconnect('openclaw')
  assert.deepEqual(readJson(file), original)
})

test('Pi: models.json and settings.json, both restored', async () => {
  const { home, apps } = setup()
  const models = join(home, '.pi', 'agent', 'models.json')
  const settings = join(home, '.pi', 'agent', 'settings.json')
  const before = { defaultProvider: 'anthropic', defaultModel: 'claude-x', theme: 'dark' }
  put(settings, JSON.stringify(before))
  assert.ok((await apps.connect('pi')).ok)
  assert.equal((readJson(models).providers as Record<string, Record<string, unknown>>).eaon.apiKey, 'eaon_test_token')
  assert.equal(readJson(settings).defaultProvider, 'eaon')
  assert.equal(readJson(settings).defaultModel, 'fake/big')
  await apps.disconnect('pi')
  assert.deepEqual(readJson(settings), before)
  assert.equal(existsSync(models), false, 'models.json was Eaon\'s, so it goes')
})

test('Droid: Eaon\'s customModels entries are added beside the user\'s and taken out again', async () => {
  const { home, apps } = setup()
  const file = join(home, '.factory', 'settings.json')
  const mine = { model: 'gpt-x', displayName: 'Mine', baseUrl: 'https://api.example.com/v1', apiKey: 'k', provider: 'openai', maxOutputTokens: 4096 }
  const original = { customModels: [mine], autonomyLevel: 'medium' }
  put(file, JSON.stringify(original))
  assert.ok((await apps.connect('droid')).ok)
  const entries = readJson(file).customModels as Record<string, unknown>[]
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], mine)
  assert.equal(entries[1].displayName, 'Big (Eaon)')
  assert.equal(entries[1].provider, 'generic-chat-completion-api')
  // Reconnecting replaces Eaon's entry rather than adding another.
  assert.ok((await apps.connect('droid', { model: 'other/coder' })).ok)
  assert.equal((readJson(file).customModels as unknown[]).length, 2)
  assert.equal(apps.list().find((a) => a.id === 'droid')!.model, 'other/coder')
  await apps.disconnect('droid')
  assert.deepEqual(readJson(file), original)
})

test('Qwen Code: a modelProviders.openai entry, its key in env, and the selection, all restored', async () => {
  const { home, apps } = setup()
  const file = join(home, '.qwen', 'settings.json')
  const original = {
    env: { OTHER: 'x' },
    modelProviders: { openai: [{ id: 'qwen3-coder-plus', name: 'Qwen', baseUrl: 'https://dashscope.example/v1', envKey: 'DASHSCOPE_API_KEY' }] },
    security: { auth: { selectedType: 'qwen-oauth' } },
    model: { name: 'qwen3-coder-plus' }
  }
  put(file, JSON.stringify(original))
  assert.ok((await apps.connect('qwen-code')).ok)
  const data = readJson(file) as typeof original & { env: Record<string, string> }
  assert.equal(data.env.EAON_API_KEY, 'eaon_test_token')
  assert.equal(data.modelProviders.openai.length, 2)
  assert.equal(data.security.auth.selectedType, 'openai')
  assert.equal(data.model.name, 'fake/big')
  assert.equal(apps.list().find((a) => a.id === 'qwen-code')!.connected, true)
  await apps.disconnect('qwen-code')
  assert.deepEqual(readJson(file), original)
})

/* ------------------------------------------------------------ YAML apps */

test('Oh My Pi: providers.eaon in models.yml, removed to the original text', async () => {
  const { home, apps } = setup()
  const file = join(home, '.omp', 'agent', 'models.yml')
  put(file, OMP_YAML)
  assert.ok((await apps.connect('oh-my-pi')).ok)
  const text = read(file)
  assert.ok(hasChild(text, 'providers', 'eaon'))
  assert.ok(text.includes('auth: "none"'))
  assert.equal(apps.list().find((a) => a.id === 'oh-my-pi')!.connected, true)
  await apps.disconnect('oh-my-pi')
  assert.equal(read(file), OMP_YAML)

  const { home: fresh, apps: apps2 } = setup()
  assert.ok((await apps2.connect('oh-my-pi')).ok)
  await apps2.disconnect('oh-my-pi')
  assert.equal(existsSync(join(fresh, '.omp', 'agent', 'models.yml')), false)
})

test('Hermes: runs Hermes\'s own writer, and Agent and Desktop share the connection', async () => {
  const calls: { command: string; job: Record<string, unknown> }[] = []
  const { home, apps } = setup({
    run: async (command, _args, input) => {
      const job = JSON.parse(input ?? '{}') as Record<string, unknown>
      calls.push({ command, job })
      if (job.action === 'connect') {
        put(String(job.config), `model:\n  provider: custom:eaon\n  default: ${String(job.model)}\nproviders:\n  eaon:\n    base_url: ${String(job.base_url)}\n    api_key: ${String(job.api_key)}\n`)
      } else put(String(job.config), 'model:\n  provider: openrouter\n')
      return '{"before": {"provider": "openrouter", "default": null, "providers": false, "model": true}}\n'
    }
  })
  const python = join(home, '.hermes', 'hermes-agent', 'venv', 'bin', 'python')
  assert.equal((await apps.connect('hermes')).ok, false, 'no Hermes install: refused')
  put(python, '')
  put(join(home, '.hermes', 'config.yaml'), 'model:\n  provider: openrouter\n')

  const result = await apps.connect('hermes-desktop', { model: 'other/coder' })
  assert.ok(result.ok, !result.ok ? result.error : '')
  assert.equal(calls[0].command, python)
  assert.equal(calls[0].job.config, join(home, '.hermes', 'config.yaml'))
  assert.equal(calls[0].job.root, join(home, '.hermes', 'hermes-agent'))
  assert.equal(calls[0].job.base_url, 'http://127.0.0.1:4567/v1')
  assert.equal(read(join(home, '.hermes', 'config.yaml.eaon-backup')), 'model:\n  provider: openrouter\n')
  const list = apps.list()
  assert.equal(list.find((a) => a.id === 'hermes')!.connected, true)
  assert.equal(list.find((a) => a.id === 'hermes-desktop')!.connected, true)

  await apps.disconnect('hermes')
  assert.equal(calls[1].job.action, 'disconnect')
  assert.deepEqual(calls[1].job.before, { provider: 'openrouter', default: null, providers: false, model: true })
  assert.deepEqual(calls[1].job.wrote, { provider: 'custom:eaon', default: 'other/coder' })
  assert.equal(apps.list().find((a) => a.id === 'hermes-desktop')!.connected, false)
})

/** The real Hermes writer, when Hermes is installed here, on a copy-free temporary config. */
const hermesAgent = join(homedir(), '.hermes', 'hermes-agent')
test('Hermes: the script works with the installed Hermes (temporary config only)', { skip: !existsSync(join(hermesAgent, 'venv', 'bin', 'python')) }, async () => {
  const runReal = (command: string, args: string[], input?: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => (out += String(c)))
      child.stderr.on('data', (c) => (err += String(c)))
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err))))
      child.stdin.end(input ?? '')
    })
  const { home, apps } = setup({ run: runReal })
  // The temporary home borrows the installed Hermes code; its config.yaml is a fresh file.
  mkdirSync(join(home, '.hermes'))
  symlinkSync(hermesAgent, join(home, '.hermes', 'hermes-agent'))
  const config = join(home, '.hermes', 'config.yaml')
  put(config, 'model:\n  default: some/model\n  provider: openrouter\ndisplay:\n  skin: default\n')
  const dump = async (): Promise<Record<string, unknown>> =>
    JSON.parse(
      await runReal(join(hermesAgent, 'venv', 'bin', 'python'), ['-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', config])
    ) as Record<string, unknown>

  const result = await apps.connect('hermes')
  assert.ok(result.ok, !result.ok ? result.error : '')
  const connected = await dump()
  assert.deepEqual(connected.model, { default: 'fake/big', provider: 'custom:eaon' })
  assert.deepEqual(connected.providers, { eaon: { name: 'Eaon', base_url: 'http://127.0.0.1:4567/v1', api_key: 'eaon_test_token', default_model: 'fake/big' } })
  assert.deepEqual(connected.display, { skin: 'default' })
  assert.equal(apps.list().find((a) => a.id === 'hermes')!.connected, true)

  await apps.disconnect('hermes')
  assert.deepEqual(await dump(), { model: { default: 'some/model', provider: 'openrouter' }, display: { skin: 'default' } })
})

/* ---------------------------------------------------- launch and manual */

test('Copilot CLI: opening it saves the choice and sets its provider variables', async () => {
  const opened: { name: string; spec: LaunchSpec }[] = []
  const { apps } = setup({
    openTerminal: async (name, _title, spec) => {
      opened.push({ name, spec })
      return { ok: true }
    }
  })
  const result = await apps.launch('copilot-cli', { model: 'other/coder' })
  assert.ok(result.ok)
  assert.deepEqual(opened[0], {
    name: 'copilot-cli',
    spec: {
      env: { COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:4567/v1', COPILOT_PROVIDER_API_KEY: 'eaon_test_token', COPILOT_MODEL: 'other/coder' },
      command: 'copilot'
    }
  })
  const status = apps.list().find((a) => a.id === 'copilot-cli')!
  assert.equal(status.connected, true)
  assert.equal(status.model, 'other/coder')
  // Opened again with no choice: the saved one.
  await apps.launch('copilot-cli')
  assert.equal(opened[1].spec.env.COPILOT_MODEL, 'other/coder')
  assert.ok((await apps.disconnect('copilot-cli')).ok)
  assert.equal(apps.list().find((a) => a.id === 'copilot-cli')!.connected, false)
})

test('launch script: variables quoted for sh, a batch file on Windows', () => {
  const spec: LaunchSpec = { env: { POOLSIDE_API_KEY: "it's", POOLSIDE_STANDALONE_MODEL: 'fake/big' }, command: 'pool' }
  const sh = launchScript(spec, 'darwin')
  assert.ok(sh.includes(`export POOLSIDE_API_KEY='it'\\''s'\n`))
  assert.ok(sh.includes("export POOLSIDE_STANDALONE_MODEL='fake/big'\npool\nexec \"${SHELL:-/bin/sh}\" -i\n"))
  assert.ok(launchScript({ env: {}, command: null }, 'linux').endsWith('exec "${SHELL:-/bin/sh}" -i\n'))
  assert.equal(launchScript(spec, 'win32'), '@echo off\r\nset "POOLSIDE_API_KEY=it\'s"\r\nset "POOLSIDE_STANDALONE_MODEL=fake/big"\r\npool\r\n')
})

test('manual apps: Copy settings text, and no Connect', async () => {
  const { apps } = setup()
  const cline = apps.manual('cline', { model: 'other/coder' })
  assert.ok(cline.ok)
  assert.match(cline.text, /OpenAI Compatible/)
  assert.match(cline.text, /Base URL: http:\/\/127\.0\.0\.1:4567\/v1/)
  assert.match(cline.text, /Model ID: other\/coder/)
  const dsh = apps.manual('deepseek-harness')
  assert.ok(dsh.ok)
  assert.match(dsh.text, /Model: fake\/big/)
  assert.equal((await apps.connect('cline')).ok, false)
  // Every app has copy text.
  for (const app of apps.list()) assert.ok(apps.manual(app.id).ok, app.id)
})

test('models: apps that keep a list get every model picked; one-slot apps get the default', async () => {
  const { home, apps } = setup()
  await apps.connect('droid', { model: 'other/coder', models: ['other/coder', 'fake/big'] })
  const droid = (readJson(join(home, '.factory', 'settings.json')).customModels as { model: string }[]).map((m) => m.model)
  assert.deepEqual(droid, ['other/coder', 'fake/big'])
  assert.deepEqual(apps.list().find((a) => a.id === 'droid')!.models, ['other/coder', 'fake/big'])

  await apps.connect('qwen-code', { model: 'fake/big', models: ['fake/big', 'other/coder'] })
  const qwen = readJson(join(home, '.qwen', 'settings.json'))
  assert.deepEqual(((qwen.modelProviders as Record<string, { id: string }[]>).openai).map((e) => e.id), ['fake/big', 'other/coder'])
  assert.equal((qwen.model as Record<string, unknown>).name, 'fake/big')

  // Reconnecting with only a new default: it takes the old default's place, the rest stay.
  await apps.connect('qwen-code', { model: 'fake/small' })
  assert.deepEqual(apps.list().find((a) => a.id === 'qwen-code')!.models, ['fake/small', 'other/coder'])

  // Claude Code has one model setting (its /model lists every Eaon model already).
  await apps.connect('claude-code', { model: 'fake/big', models: ['fake/big', 'other/coder'] })
  const claude = apps.list().find((a) => a.id === 'claude-code')!
  assert.equal(claude.multiModel, false)
  assert.deepEqual(claude.models, ['fake/big'])

  const unknown = await apps.connect('opencode', { model: 'fake/big', models: ['fake/big', 'gone/model'] })
  assert.equal(unknown.ok, false)
  assert.match(!unknown.ok ? unknown.error : '', /gone\/model isn't one of your models/)
})

test('models: an unknown one is refused, and with none there is nothing to connect', async () => {
  const { apps, gateway, home } = setup()
  const unknown = await apps.connect('opencode', { model: 'gone/model' })
  assert.equal(unknown.ok, false)
  assert.match(!unknown.ok ? unknown.error : '', /isn't one of your models/)
  gateway.info = { ...info, models: [], defaultModel: null, smallModel: null }
  const none = await apps.connect('opencode')
  assert.equal(none.ok, false)
  assert.match(!none.ok ? none.error : '', /no models/)
  assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false)
})

test('every app is listed once, in the page\'s order', () => {
  const { apps } = setup()
  const ids = apps.list().map((a) => a.id)
  assert.deepEqual(ids, [
    'claude-code', 'chatgpt', 'codex-cli', 'openclaw', 'opencode', 'hermes', 'hermes-desktop', 'droid', 'pi',
    'cline', 'copilot-cli', 'oh-my-pi', 'deepseek-harness', 'poolside', 'qwen-code', 'terminal'
  ])
  for (const app of apps.list()) assert.ok(app.files.every((f) => f.startsWith('~/')), app.id)
})

/* ------------------------------------------------- the user's files, kept theirs */

test('a settings file kept as a symlink (dotfiles) is changed in place, and stays a link', async () => {
  const { home, apps } = setup()
  const real = join(home, 'dotfiles', 'claude.json')
  put(real, '{\n  "theme": "dark"\n}\n')
  mkdirSync(join(home, '.claude'), { recursive: true })
  const link = join(home, '.claude', 'settings.json')
  symlinkSync(real, link)
  assert.ok((await apps.connect('claude-code')).ok)
  assert.ok(lstatSync(link).isSymbolicLink(), 'still a link')
  assert.equal((readJson(real) as { theme: string }).theme, 'dark')
  assert.ok((readJson(real) as { env: Record<string, string> }).env.ANTHROPIC_BASE_URL, 'the change landed in the real file')
  assert.ok((await apps.disconnect('claude-code')).ok)
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(read(real), '{\n  "theme": "dark"\n}\n', 'put back exactly')
})

test('a private settings file stays private, and a new one holding the key is made private', async () => {
  const { home, apps } = setup()
  const file = join(home, '.claude', 'settings.json')
  put(file, '{}\n')
  chmodSync(file, 0o600)
  assert.ok((await apps.connect('claude-code')).ok)
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the key did not make it world-readable')
  const fresh = setup()
  assert.ok((await fresh.apps.connect('codex-cli')).ok)
  const profile = join(fresh.home, '.codex', 'eaon.config.toml')
  assert.ok(existsSync(profile))
  assert.equal(statSync(profile).mode & 0o077, 0, 'a file Eaon creates with the key in it is readable by the user only')
})

test('Copy settings quotes values so pasting them runs nothing', async () => {
  const { apps } = setup()
  const text = apps.manual('terminal')
  assert.ok(text.ok)
  for (const line of text.text.split('\n').filter((l) => l.startsWith('export '))) assert.match(line, /^export [A-Z_]+='[^']*'$/, line)
  const { exportLines } = await import('../src/main/features/connectApps/connector')
  assert.equal(exportLines({ M: 'x$(rm -rf ~)`id`' }, 'darwin'), "export M='x$(rm -rf ~)`id`'")
  assert.equal(exportLines({ M: "it's" }, 'linux'), "export M='it'\\''s'")
  assert.equal(exportLines({ M: 'a & b "c"\nd' }, 'win32'), 'set "M=a & b cd"')
})
