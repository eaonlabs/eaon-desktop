import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ControlAction } from '@shared/control'
import { setControlTools } from '../src/main/control/server'
import { createControlTools } from '../src/main/control/tools'
import { gatewayToken } from '../src/main/gateway/models'
import { startLocalServer, stopLocalServer } from '../src/main/localServer'
import { store } from '../src/main/store'

/**
 * Eaon's control API (main/control): what Eaon CLI uses to drive the app.
 * Run against the real server with a real MCP client, the way the CLI
 * connects; the window is a recording stand-in.
 */

const acted: ControlAction[] = []
const sent: { channel: string; payload: unknown }[] = []
const scratch = mkdtempSync(join(tmpdir(), 'eaon-control-'))
let base = ''
let key = ''

before(async () => {
  setControlTools(
    createControlTools({
      act: (action) => void acted.push(action),
      send: (channel, payload) => void sent.push({ channel, payload }),
      readLayout: () => ({ [scratch]: [{ id: 'p1', name: 'Cynthia', agent: 'eaon-cli' }] })
    })
  )
  store.patchSettings({ localServer: { ...store.getSettings().localServer, port: 47388 } })
  const status = await startLocalServer()
  assert.equal(status.running, true, status.error)
  base = status.url!
  key = gatewayToken()
})

after(async () => {
  await stopLocalServer()
  setControlTools([])
  rmSync(scratch, { recursive: true, force: true })
})

const rest = (path: string, init: RequestInit & { key?: string | null } = {}): Promise<Response> => {
  const { key: sentKey = key, ...rest } = init
  return fetch(`${base}${path}`, { ...rest, headers: { 'Content-Type': 'application/json', ...(sentKey ? { Authorization: `Bearer ${sentKey}` } : {}) } })
}

async function connect(withKey = key): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/control/mcp`), { requestInit: { headers: { Authorization: `Bearer ${withKey}` } } }))
  return client
}

const textOf = (result: unknown): string => ((result as { content: { text: string }[] }).content[0]?.text ?? '')

test('the control API never answers without this install’s key — unlike the model routes, which let a keyless request through', async () => {
  assert.equal((await rest('/control/v1/tools', { key: null })).status, 401)
  assert.equal((await rest('/control/v1/tools', { key: 'eaon-not-the-key' })).status, 401)
  assert.equal((await rest('/control/mcp', { method: 'POST', body: '{}', key: null })).status, 401)
  assert.equal((await rest('/control/v1/tools')).status, 200)
  assert.equal((await rest('/v1/models', { key: null })).status, 200, 'the model routes are as they were')
})

test('a web page on another origin cannot reach it, even with the key', async () => {
  const res = await fetch(`${base}/control/v1/tools`, { headers: { Authorization: `Bearer ${key}`, Origin: 'https://evil.example' } })
  assert.equal(res.status, 403)
})

test('an MCP client lists the tools, each marked read-only, changing or destructive', async () => {
  const client = await connect()
  const { tools } = await client.listTools()
  const byName = new Map(tools.map((t) => [t.name, t]))
  for (const name of ['status', 'models_downloaded', 'models_library', 'model_download', 'model_load', 'model_delete', 'navigate', 'ade_open_folder', 'ade_new_terminal', 'workers', 'settings_set']) {
    assert.ok(byName.has(name), `${name} is offered`)
  }
  assert.equal(byName.get('models_library')!.annotations?.readOnlyHint, true)
  assert.equal(byName.get('navigate')!.annotations?.readOnlyHint, false)
  assert.equal(byName.get('model_delete')!.annotations?.destructiveHint, true)
  assert.equal(byName.get('model_download')!.annotations?.destructiveHint, false)
  await client.close()
})

test('a wrong key is refused by the MCP client too', async () => {
  await assert.rejects(connect('eaon-wrong'))
})

test('status and the model library answer with what this computer can run', async () => {
  const client = await connect()
  const status = JSON.parse(textOf(await client.callTool({ name: 'status', arguments: {} })))
  assert.equal(status.app, 'Eaon')
  assert.equal(status.version, '0.0.0-test')

  const library = JSON.parse(textOf(await client.callTool({ name: 'models_library', arguments: { query: 'minicpm', limit: 3 } })))
  assert.ok(library.total >= 1)
  const mini = library.models[0]
  assert.equal(mini.id, 'minicpm5-2b')
  assert.ok(mini.recommended.variant && mini.recommended.size && mini.recommended.fit, 'the variant that fits, with its size')
  assert.ok(mini.capabilities.includes('tools'))

  const vision = JSON.parse(textOf(await client.callTool({ name: 'models_library', arguments: { capability: 'vision', limit: 40 } })))
  assert.ok(vision.models.length > 0 && vision.models.every((m: { capabilities: string[] }) => m.capabilities.includes('vision')))
  await client.close()
})

test('a download of a model that is not in the library, or a variant it lacks, says what is', async () => {
  const client = await connect()
  const unknown = await client.callTool({ name: 'model_download', arguments: { model: 'gpt-5' } })
  assert.equal(unknown.isError, true)
  assert.match(textOf(unknown), /No library model "gpt-5"\. Use models_library/)
  const variant = await client.callTool({ name: 'model_download', arguments: { model: 'minicpm5-2b', variant: 'q1' } })
  assert.equal(variant.isError, true)
  assert.match(textOf(variant), /has no variant "q1"\. It has: q4_k_m, q8_0/)
  await client.close()
})

test('window actions go to the window as they were asked, after being checked', async () => {
  acted.length = 0
  const client = await connect()
  await client.callTool({ name: 'navigate', arguments: { to: 'models' } })
  await client.callTool({ name: 'navigate', arguments: { to: 'settings', settingsPage: 'appearance' } })
  await client.callTool({ name: 'ade_open_folder', arguments: { path: scratch } })
  await client.callTool({ name: 'ade_new_terminal', arguments: { agent: 'eaon-cli', folder: scratch } })
  await client.callTool({ name: 'settings_set', arguments: { setting: 'appearance.mode', value: 'light' } })
  assert.deepEqual(acted, [
    { type: 'navigate', to: 'models' },
    { type: 'navigate', to: 'settings', settingsPage: 'appearance' },
    { type: 'open-folder', path: scratch },
    { type: 'new-terminal', agent: 'eaon-cli', folder: scratch },
    { type: 'settings', patch: { appearance: { mode: 'light' } } }
  ])

  acted.length = 0
  const results = await Promise.all([
    client.callTool({ name: 'navigate', arguments: { to: 'the-moon' } }),
    client.callTool({ name: 'ade_open_folder', arguments: { path: join(scratch, 'nope') } }),
    client.callTool({ name: 'ade_new_terminal', arguments: { agent: 'emacs' } }),
    client.callTool({ name: 'settings_set', arguments: { setting: 'appearance.mode', value: 'sepia' } }),
    client.callTool({ name: 'settings_set', arguments: { setting: 'localServer.token', value: 'x' } }),
    client.callTool({ name: 'settings_set', arguments: { setting: 'appearance.fontSize', value: 99 } })
  ])
  assert.ok(results.every((r) => r.isError), 'each of those is refused')
  assert.match(textOf(results[1]), /isn't a folder that exists/)
  assert.match(textOf(results[4]), /can't be changed here/)
  assert.deepEqual(acted, [], 'and nothing reached the window')
  await client.close()
})

test('settings it reads are the few it can change, and never a key or token', async () => {
  const client = await connect()
  const settings = JSON.parse(textOf(await client.callTool({ name: 'settings_get', arguments: {} })))
  assert.ok('appearance.mode' in settings && 'localServer.port' in settings)
  assert.ok(!JSON.stringify(settings).includes(key), 'the install’s key is not in there')
  await client.close()
})

test('the ADE state names the folder’s terminals and what each runs', async () => {
  const client = await connect()
  const ade = JSON.parse(textOf(await client.callTool({ name: 'ade_state', arguments: {} })))
  assert.deepEqual(ade.terminals[scratch], [{ name: 'Cynthia', agent: 'eaon-cli' }])
  await client.close()
})

test('the same tools answer as plain JSON for scripts, with errors in the body', async () => {
  const listed = (await (await rest('/control/v1/tools')).json()) as { tools: { name: string; risk: string }[] }
  assert.equal(listed.tools.find((t) => t.name === 'model_delete')?.risk, 'danger')
  const ok = (await (await rest('/control/v1/tools/status', { method: 'POST', body: '{}' })).json()) as { result: { app: string } }
  assert.equal(ok.result.app, 'Eaon')
  const bad = await rest('/control/v1/tools/model_delete', { method: 'POST', body: JSON.stringify({ id: 'nothing:q4' }) })
  assert.equal(bad.status, 400)
  assert.match(((await bad.json()) as { error: { message: string } }).error.message, /isn’t downloaded/)
  assert.equal((await rest('/control/v1/tools/nope', { method: 'POST', body: '{}' })).status, 404)
})
