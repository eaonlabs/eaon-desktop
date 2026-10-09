import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLocalServer, stopLocalServer } from '../src/main/localServer'
import { resolveGatewayModel } from '../src/main/gateway/models'
import { llamaRuntime } from '../src/main/llama/runtime'
import { AGENT_KINDS, agentOfArgs, setAgentScript } from '../src/main/features/terminals/agentSessions'
import { launcherEnv } from '../src/main/features/terminals/ptyManager'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { chunk, sseServer } from './helpers'

/**
 * Eaon CLI (the OpenCode fork, features/eaonCli.ts) codes with the models
 * downloaded in Eaon through the gateway's `/local/v1` routes. Those routes
 * must serve the downloaded models — run by a stand-in llama-server here —
 * and never hand a request to a cloud provider, whatever model it names.
 */

const dir = mkdtempSync(join(tmpdir(), 'eaon-cli-test-'))
const FAKE_LLAMA = `
const http = require('node:http')
const args = process.argv.slice(2)
const arg = (flag) => args[args.indexOf(flag) + 1]
const alias = arg('--alias')
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('{"status":"ok"}') }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: alias, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\\n\\n')
    send({ role: 'assistant', content: 'local:' })
    send({ content: alias }, 'stop')
    res.end('data: [DONE]\\n\\n')
  })
}).listen(Number(arg('--port')), '127.0.0.1')
`
writeFileSync(join(dir, 'fake-llama.cjs'), FAKE_LLAMA)
const llama = join(dir, 'llama-server')
writeFileSync(llama, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-llama.cjs')}" "$@"\n`)
chmodSync(llama, 0o755)
process.env.EAON_LLAMA_SERVER = llama

const LOCAL = 'minicpm5-2b:q4_k_m'
let cloud: Awaited<ReturnType<typeof sseServer>>
let base = ''

before(async () => {
  cloud = await sseServer(() => [chunk({ content: 'from the cloud' }, 'stop')])
  store.saveProviderConfig({
    ollama: { enabled: false },
    'lm-studio': { enabled: false },
    'llama-cpp': { enabled: false },
    mlx: { enabled: false },
    vllm: { enabled: false },
    jan: { enabled: false },
    // Switched off for the chat's picker: Eaon CLI still gets the downloaded models.
    'eaon-local': { enabled: false },
    cloud: { name: 'Cloud', kind: 'openai-compatible', baseUrl: cloud.url, models: [{ id: 'gpt-5', label: 'GPT-5', providerId: 'cloud' }] }
  })
  secrets.set('cloud', 'key')
  store.saveDownloadedModels([
    {
      repoId: 'openbmb/MiniCPM5-2B-GGUF',
      filename: 'MiniCPM5-2B-Q4_K_M.gguf',
      quant: 'Q4_K_M',
      sizeBytes: 1,
      path: join(dir, 'mini.gguf'),
      downloadedAt: 1,
      library: { modelId: 'minicpm5-2b', variantId: 'q4_k_m' },
      label: 'MiniCPM5 2B · Q4_K_M',
      capabilities: ['tools', 'reasoning', 'coding'],
      contextLength: 131_072
    },
    {
      repoId: 'google/embeddinggemma-300m-GGUF',
      filename: 'embeddinggemma-300m-Q8_0.gguf',
      quant: 'Q8_0',
      sizeBytes: 1,
      path: join(dir, 'embed.gguf'),
      downloadedAt: 1,
      library: { modelId: 'embeddinggemma-300m', variantId: 'q8_0' },
      capabilities: ['embedding']
    }
  ])
  store.patchSettings({ localServer: { ...store.getSettings().localServer, port: 47377, defaultModelId: 'cloud/gpt-5', smallModelId: null } })
  const status = await startLocalServer()
  assert.equal(status.running, true, status.error)
  base = status.url!
})

after(async () => {
  await stopLocalServer()
  await llamaRuntime.shutdown()
  cloud.server.close()
  rmSync(dir, { recursive: true, force: true })
})

const chat = (path: string, model: string | undefined, stream = false): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(model ? { model } : {}), stream, messages: [{ role: 'user', content: 'hi' }] })
  })

test('/local/v1/models lists the downloaded chat models, described, and nothing from the cloud', async () => {
  const list = (await (await fetch(`${base}/local/v1/models`)).json()) as { data: Record<string, unknown>[] }
  assert.deepEqual(
    list.data.map((m) => m.id),
    [LOCAL],
    'one chat model: no cloud model, no embedding model'
  )
  assert.equal(list.data[0].name, 'MiniCPM5 2B · Q4_K_M')
  assert.equal(list.data[0].context_window, 32_768, 'the context llama-server is given, not the trained one')
  assert.deepEqual(list.data[0].capabilities, { tools: true, vision: false, reasoning: true })
  const all = (await (await fetch(`${base}/v1/models`)).json()) as { data: { id: string }[] }
  assert.ok(all.data.some((m) => m.id === 'cloud/gpt-5'), 'the unscoped list is unchanged')
})

test('a local chat runs on the downloaded model, streamed and not', async () => {
  const plain = (await (await chat('/local/v1/chat/completions', LOCAL)).json()) as { choices: { message: { content: string } }[] }
  assert.equal(plain.choices[0].message.content, `local:${LOCAL}`)
  const streamed = await (await chat('/local/v1/chat/completions', LOCAL, true)).text()
  assert.match(streamed, /"content":"local:"/)
  assert.match(streamed, /data: \[DONE\]/)
  assert.equal(cloud.requests.length, 0)
})

test('a cloud model name on the local routes is refused, never mapped to the default', async () => {
  for (const name of ['gpt-5', 'cloud/gpt-5', 'claude-sonnet-4-5']) {
    const res = await chat('/local/v1/chat/completions', name)
    assert.equal(res.status, 400, name)
    const body = (await res.json()) as { error: { message: string } }
    assert.match(body.error.message, new RegExp(`"${name.replace('/', '\\/')}" isn't downloaded in Eaon\\. Downloaded: ${LOCAL}`))
  }
  const messages = await fetch(`${base}/local/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
  })
  assert.equal(messages.status, 400, 'Anthropic Messages too')
  assert.equal(cloud.requests.length, 0, 'nothing reached the cloud provider')
  // The same name without /local still maps to the default, as Connect apps relies on.
  const mapped = (await (await chat('/v1/chat/completions', 'claude-sonnet-4-5')).json()) as { choices: { message: { content: string } }[] }
  assert.equal(mapped.choices[0].message.content, 'from the cloud')
})

test('model names in the local scope: bare, provider-prefixed, or none for the first', () => {
  assert.equal(resolveGatewayModel(LOCAL, 'local')?.id, `eaon-local/${LOCAL}`)
  assert.equal(resolveGatewayModel(`eaon-local/${LOCAL}`, 'local')?.id, `eaon-local/${LOCAL}`)
  assert.equal(resolveGatewayModel(undefined, 'local')?.id, `eaon-local/${LOCAL}`)
  assert.equal(resolveGatewayModel('gpt-5', 'local'), null)
})

test('an Eaon CLI pane is known by its binary wherever it is, and its sessions reopen like OpenCode’s', () => {
  assert.equal(agentOfArgs('/Applications/Eaon.app/Contents/Resources/eaon-cli/darwin-arm64/eaon-cli'), 'eaon-cli')
  assert.equal(agentOfArgs('opencode'), 'opencode', 'stock OpenCode is still itself')
  const kind = AGENT_KINDS['eaon-cli']
  assert.equal(kind.named("'/path with space/eaon-cli' --session ses_abc123"), 'ses_abc123')
  assert.equal(kind.resume("'/x/eaon-cli'", 'ses_abc123'), "'/x/eaon-cli' --session ses_abc123")
  assert.equal(kind.continueLatest('eaon-cli'), 'eaon-cli --continue')
})

test('an agent run from a folder with spaces in its name is still known (ps does not quote them)', () => {
  const binary = '/Users/me/Eaon Desktop/resources/eaon-cli/darwin-arm64/eaon-cli'
  const script = '/Users/me/My Tools/eaon-code/dist/bundle/cli.js'
  setAgentScript(binary, 'eaon-cli')
  setAgentScript(script, 'eaon-code')
  try {
    assert.equal(agentOfArgs(binary), 'eaon-cli')
    assert.equal(agentOfArgs(`${binary} --session ses_1`), 'eaon-cli')
    assert.equal(agentOfArgs(`node --max-old-space-size=4096 ${script} --continue`), 'eaon-code')
    assert.equal(agentOfArgs(`${binary}-old`), null, 'a longer name is another program')
    assert.equal(agentOfArgs(`vim ${binary}`), null, 'a file opened in an editor is not the agent running')
  } finally {
    setAgentScript(null, 'eaon-cli')
    setAgentScript(null, 'eaon-code')
  }
})

test('a pane does not inherit the multiplexer or terminal Eaon was started from', () => {
  const env = launcherEnv({ PATH: '/bin', HOME: '/h', TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3', STY: '1.pts', ZELLIJ: '0', ZELLIJ_SESSION_NAME: 's', TERM_PROGRAM: 'tmux', CLAUDECODE: '1' })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH'])
})
