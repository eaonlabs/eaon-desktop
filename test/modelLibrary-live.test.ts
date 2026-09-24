import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { deleteDownloadedModel, downloadModel } from '../src/main/modelHub'
import { findOllamaBinary, listInstalled, ollamaVersion, startOllama } from '../src/main/modelLibrary/ollama'

/**
 * Against the real Ollama on this machine. Opt-in (EAON_LIVE=1): the second
 * test downloads a 229 MB GGUF. Neither touches the user's own models — the
 * first starts a throwaway server on another port and stops it, the second
 * registers a model under a new name and deletes it again.
 */
const live = process.env.EAON_LIVE === '1'

test('startOllama spawns a detached `ollama serve` and waits for it to answer', { skip: !live || !findOllamaBinary() }, async () => {
  const host = '127.0.0.1:11999'
  assert.equal(await ollamaVersion(1000, `http://${host}`), null, 'port 11999 must be free')
  try {
    const status = await startOllama({ host, timeoutMs: 30_000 })
    assert.equal(status.state, 'running')
    // Already running: a second call returns straight away without spawning.
    assert.equal((await startOllama({ host })).state, 'running')
  } finally {
    const pids = execFileSync('lsof', ['-ti', 'tcp:11999', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    for (const pid of pids) process.kill(Number(pid))
  }
})

test('a Hugging Face GGUF download registers with current Ollama via the blob API', { skip: !live, timeout: 600_000 }, async () => {
  if (!(await ollamaVersion())) return
  const repo = 'LiquidAI/LFM2.5-Embedding-350M-GGUF'
  const file = 'LFM2.5-Embedding-350M-Q4_K_M.gguf'
  const model = await downloadModel(repo, file, () => {})
  try {
    assert.equal(model.ollamaError, null, model.ollamaError ?? '')
    assert.ok(model.ollamaName)
    const installed = await listInstalled()
    assert.ok(installed.some((m) => m.name.startsWith(`${model.ollamaName}:`)), `${model.ollamaName} not in /api/tags`)
    const response = await fetch('http://127.0.0.1:11434/api/embed', {
      method: 'POST',
      body: JSON.stringify({ model: model.ollamaName, input: 'hello' })
    })
    const body = (await response.json()) as { embeddings?: number[][] }
    assert.ok(body.embeddings?.[0]?.length, 'registered model produces embeddings')
  } finally {
    await deleteDownloadedModel(repo, file)
  }
  assert.ok(!existsSync(model.path), 'file removed')
  assert.ok(!(await listInstalled()).some((m) => m.name.startsWith(`${model.ollamaName}:`)), 'unregistered from Ollama')
})
