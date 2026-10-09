import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { explainFailure, llamaRuntime } from '../src/main/llama/runtime'
import { localModelId, localModelInfo } from '../src/main/llama/models'

/**
 * Eaon's own llama.cpp runtime (main/llama). The process handling runs
 * against a stand-in llama-server that records its arguments and answers
 * /health like the real one: 503 while "loading", then 200.
 */

const dir = mkdtempSync(join(tmpdir(), 'eaon-fake-llama-'))
const record = join(dir, 'args.json')
const spawnLog = join(dir, 'spawns.log')
const FAKE = `
const http = require('node:http')
const fs = require('node:fs')
const args = process.argv.slice(2)
const arg = (flag) => args[args.indexOf(flag) + 1]
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(args))
fs.appendFileSync(${JSON.stringify(spawnLog)}, arg('-m') + '\\n')
if (arg('-m').includes('broken')) {
  process.stderr.write("llama_model_load: error loading model: unknown model architecture: 'k2-horizon'\\n")
  process.exit(1)
}
let health = 0
http.createServer((req, res) => {
  if (req.url === '/health') {
    health++
    res.writeHead(health < 3 ? 503 : 200)
    return res.end(health < 3 ? '{"status":"loading model"}' : '{"status":"ok"}')
  }
  res.writeHead(404); res.end()
}).listen(Number(arg('--port')), '127.0.0.1')
`
writeFileSync(join(dir, 'fake-llama.cjs'), FAKE)
const bin = join(dir, 'llama-server')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-llama.cjs')}" "$@"\n`)
chmodSync(bin, 0o755)
process.env.EAON_LLAMA_SERVER = bin

test.after(async () => {
  await llamaRuntime.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

const args = (): string[] => JSON.parse(readFileSync(record, 'utf8'))
const value = (list: string[], flag: string): string | undefined => list[list.indexOf(flag) + 1]
/** Models llama-server was started for, in order, since the last call. */
const spawned = (): string[] => {
  const log = existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').trim() : ''
  rmSync(spawnLog, { force: true })
  return log ? log.split('\n') : []
}

test('a model loads on first use: llama-server gets the file, a key, a context and the GPU, and is ready only once /health says so', async () => {
  const target = await llamaRuntime.ensure({ id: 'minicpm5-2b:q4_k_m', path: '/models/mini.gguf', contextLength: 131_072 })
  const seen = args()
  assert.equal(value(seen, '-m'), '/models/mini.gguf')
  assert.equal(value(seen, '--host'), '127.0.0.1')
  assert.equal(value(seen, '--alias'), 'minicpm5-2b:q4_k_m')
  assert.equal(value(seen, '-c'), '32768', 'context capped: the KV cache is allocated up front')
  assert.equal(value(seen, '-ngl'), '999')
  const threads = String(Math.max(1, Math.floor(availableParallelism() / 2)))
  assert.equal(value(seen, '-t'), threads, 'half the cores, so the computer stays usable while it runs')
  assert.equal(value(seen, '-tb'), threads)
  assert.equal(value(seen, '--poll'), '0', 'threads waiting for work sleep instead of spinning')
  assert.ok(seen.includes('--jinja') && seen.includes('--no-webui'))
  assert.ok(!seen.includes('--mmproj'))
  assert.equal(value(seen, '--api-key'), target.apiKey)
  assert.match(target.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  assert.equal((await llamaRuntime.status()).chat?.state, 'ready')
})

test('the same model is reused; another model replaces it; a vision model brings its projector', async () => {
  const first = await llamaRuntime.ensure({ id: 'minicpm5-2b:q4_k_m', path: '/models/mini.gguf' })
  const again = await llamaRuntime.ensure({ id: 'minicpm5-2b:q4_k_m', path: '/models/mini.gguf' })
  assert.equal(again.baseUrl, first.baseUrl, 'no restart for the model already loaded')

  const vision = await llamaRuntime.ensure({ id: 'qwen3.5-4b:q4_k_m', path: '/models/qwen.gguf', mmprojPath: '/models/mmproj.gguf' })
  assert.notEqual(vision.baseUrl, first.baseUrl)
  assert.equal(value(args(), '--mmproj'), '/models/mmproj.gguf')
  assert.equal((await llamaRuntime.status()).chat?.modelId, 'qwen3.5-4b:q4_k_m')
})

test('an embedding model gets its own server, beside the chat one', async () => {
  const chat = await llamaRuntime.ensure({ id: 'minicpm5-2b:q4_k_m', path: '/models/mini.gguf' })
  const embed = await llamaRuntime.ensure({ id: 'embeddinggemma-300m:q8_0', path: '/models/embed.gguf' }, 'embedding')
  assert.ok(args().includes('--embedding'))
  assert.notEqual(embed.baseUrl, chat.baseUrl)
  const status = await llamaRuntime.status()
  assert.equal(status.chat?.modelId, 'minicpm5-2b:q4_k_m')
  assert.equal(status.embedding?.modelId, 'embeddinggemma-300m:q8_0')
})

test('a model the build cannot load fails with a sentence, not a hang', async () => {
  await assert.rejects(
    llamaRuntime.ensure({ id: 'k2:q4', path: '/models/broken-k2.gguf' }),
    /architecture \(k2-horizon\) isn’t supported by Eaon’s llama.cpp yet/
  )
})

const mini = { id: 'minicpm5-2b:q4_k_m', path: '/models/mini.gguf' }
const qwen = { id: 'qwen3.5-4b:q4_k_m', path: '/models/qwen.gguf' }

test('callers that arrive together (workers waking at once) share one load', async () => {
  llamaRuntime.unload()
  spawned()
  const targets = await Promise.all([1, 2, 3, 4].map(() => llamaRuntime.ensure(mini)))
  assert.equal(new Set(targets.map((target) => target.baseUrl)).size, 1, 'all four got the same server')
  assert.deepEqual(spawned(), ['/models/mini.gguf'], 'the model was loaded once, not four times')
  const reply = await llamaRuntime.use(mini, 'chat', async (target) => target.baseUrl)
  assert.equal(reply, targets[0].baseUrl, 'a request runs against the loaded server')
  assert.deepEqual(spawned(), [])
})

test('two models asked for at once: the later one gets the slot, and the other is never started', async () => {
  llamaRuntime.unload()
  spawned()
  const [first, second] = await Promise.allSettled([llamaRuntime.ensure(mini), llamaRuntime.ensure(qwen)])
  assert.equal(first.status, 'rejected')
  assert.match(String((first as PromiseRejectedResult).reason), /in its place/)
  assert.equal(second.status, 'fulfilled')
  assert.deepEqual(spawned(), ['/models/qwen.gguf'], 'no second server left running beside it')
  assert.equal((await llamaRuntime.status()).chat?.modelId, 'qwen3.5-4b:q4_k_m')
})

test('unloading while a load is starting means it never starts', async () => {
  llamaRuntime.unload()
  spawned()
  const loading = llamaRuntime.ensure(mini)
  llamaRuntime.unload()
  await assert.rejects(loading, /unloaded before it finished loading/)
  assert.deepEqual(spawned(), [])
  assert.equal((await llamaRuntime.status()).chat, null)
})

test('failures are explained in words a person can act on', () => {
  assert.match(explainFailure(["error: unknown model architecture: 'k2-horizon'"], 1), /k2-horizon/)
  assert.match(explainFailure(['ggml_metal: failed to allocate buffer'], 1), /did not fit in memory/)
  assert.match(explainFailure(['gguf_init_from_file: invalid magic characters'], 1), /could not be read/)
  assert.match(explainFailure(['something else went wrong'], 134), /exit 134.*something else went wrong/)
  // Windows' STATUS_DLL_NOT_FOUND, as Node reports it and as some tools print it.
  for (const code of [3221225781, -1073741515]) {
    assert.match(
      explainFailure([], code),
      /Microsoft Visual C\+\+ Redistributable for Visual Studio 2015–2022 \((x64|arm64)\) from https:\/\/aka\.ms\/vs\/17\/release\/vc_redist\.(x64|arm64)\.exe/
    )
  }
  assert.match(explainFailure([], null, 'SIGILL'), /processor lacks instructions/)
  assert.doesNotMatch(explainFailure([], null, 'SIGILL'), /stopped while loading/)
  assert.match(explainFailure([], null, 'SIGKILL'), /ran out of memory/)
  assert.match(explainFailure(['segfault here'], null, 'SIGSEGV'), /\(SIGSEGV\): segfault here/)
})

test('downloaded models get stable picker ids and labels', () => {
  const library = { repoId: 'openbmb/MiniCPM5-2B-GGUF', filename: 'MiniCPM5-2B-Q4_K_M.gguf', quant: 'Q4_K_M', library: { modelId: 'minicpm5-2b', variantId: 'q4_k_m' } }
  assert.equal(localModelId(library), 'minicpm5-2b:q4_k_m')
  assert.equal(localModelId({ repoId: 'janhq/Jan-v3.5-4B-gguf', filename: 'Jan-v3.5-4B-Q4_K_M.gguf', quant: 'Q4_K_M' }), 'jan-v3.5-4b:q4_k_m')
  const info = localModelInfo({
    ...library,
    sizeBytes: 1,
    path: '/m.gguf',
    downloadedAt: 0,
    mmprojPath: '/mm.gguf',
    label: 'MiniCPM5 2B · Q4_K_M',
    capabilities: ['tools', 'reasoning']
  })
  assert.equal(info.providerId, 'eaon-local')
  assert.equal(info.tools, true)
  assert.equal(info.vision, true)
  assert.equal(info.reasoning, true)
})
