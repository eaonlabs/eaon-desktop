import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { checkHfFile, providerKeyId, sameOrigin } from '../src/main/ipcGuards'
import { downloadModel, localPathFor, modelsDir } from '../src/main/modelHub'

/**
 * What main accepts from the renderer for vault ids, model downloads and
 * plugin servers.
 */

test('the Keys handlers reach model-provider keys only', () => {
  const providers = ['openai', 'anthropic', 'custom-my-proxy']
  assert.equal(providerKeyId('openai', providers), 'openai')
  assert.equal(providerKeyId('custom-my-proxy', providers), 'custom-my-proxy')
  for (const id of ['plugin:github', 'channel:abc', 'payments:card', 'mcp-oauth:x', 'not-a-provider', '', 42, null]) {
    assert.throws(() => providerKeyId(id, [...providers, 'plugin:github']), /model provider/, String(id))
  }
})

test('a model download stays inside its folder under the models directory', () => {
  const root = '/models'
  assert.equal(checkHfFile('unsloth/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf', root).dest, join(root, 'unsloth__Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf'))
  assert.equal(checkHfFile('owner/repo', 'Q8_0/model-00001-of-00002.gguf', root).dest, join(root, 'owner__repo', 'Q8_0', 'model-00001-of-00002.gguf'))
  for (const [repo, file] of [
    ['owner/repo', '../../../.zshrc'],
    ['owner/repo', 'sub/../../escape.gguf'],
    ['owner/repo', '/etc/passwd'],
    ['owner/repo', 'a\\..\\..\\b'],
    ['owner/repo', 'model.gguf?download=1'],
    ['owner/repo', 'model.gguf#x'],
    ['owner/repo', '%2e%2e/x'],
    ['owner/repo', ''],
    ['atk/m/resolve/main/x.bin?', 'model.gguf'],
    ['../owner', 'model.gguf'],
    ['owner', 'model.gguf'],
    ['owner/..', 'model.gguf'],
    [42, 'model.gguf']
  ] as [unknown, unknown][]) {
    assert.throws(() => checkHfFile(repo, file, root), /isn’t a/, `${String(repo)} ${String(file)}`)
  }
})

test('the download IPC refuses a path outside the models folder before fetching anything', async () => {
  assert.throws(() => localPathFor('owner/repo', '../../outside.gguf'), /isn’t a file/)
  assert.ok(localPathFor('owner/repo', 'model.gguf').startsWith(modelsDir()))
  await assert.rejects(async () => downloadModel('owner/repo', '../../../Library/LaunchAgents/x.plist', () => {}), /isn’t a file/)
})

test('a plugin token goes only to the server it was made for', () => {
  assert.ok(sameOrigin('https://mcp.example.com/mcp', 'https://mcp.example.com/mcp/'))
  assert.ok(!sameOrigin('https://evil.example/mcp', 'https://mcp.example.com/mcp'))
  assert.ok(!sameOrigin('http://mcp.example.com/mcp', 'https://mcp.example.com/mcp'), 'not over plain http')
  assert.ok(!sameOrigin('https://mcp.example.com.evil.io/mcp', 'https://mcp.example.com/mcp'))
  assert.ok(!sameOrigin('not a url', 'https://mcp.example.com/mcp'))
})
