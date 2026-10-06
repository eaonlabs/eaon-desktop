import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { LINK_TARGETS } from '@shared/linkAccounts'
import { detectApps } from '../src/main/features/linkAccounts'
import { BUILT_IN, providerMeta } from '../src/main/providers/catalog'

/**
 * Link accounts: which apps are installed (presence only), and the rule that
 * every account links through its provider's own sanctioned route.
 */

test('detection looks only for app bundles and programs, never inside them', () => {
  const looked: string[] = []
  const apps = detectApps(
    'darwin',
    (path) => {
      looked.push(path)
      return path === '/Applications/ChatGPT.app' || path === join('/Users/me', 'Applications', 'Grok.app')
    },
    (bin) => (bin === 'ollama' ? '/opt/homebrew/bin/ollama' : null),
    '/Users/me'
  )
  const installed = apps.filter((a) => a.installed).map((a) => a.id)
  assert.deepEqual(installed.sort(), ['chatgpt', 'grok', 'ollama'])
  // Bundle paths only: nothing under Application Support, no cookies, no keychains.
  assert.ok(looked.every((path) => path.endsWith('.app')), looked.join('\n'))
})

test('Windows looks in the usual install folders', () => {
  const looked: string[] = []
  const apps = detectApps('win32', (path) => (looked.push(path), path.endsWith('AnthropicClaude')), () => null, 'C:\\Users\\me')
  assert.deepEqual(apps.filter((a) => a.installed).map((a) => a.id), ['claude'])
  assert.ok(looked.every((path) => /AppData|Local/.test(path) || Boolean(process.env['LOCALAPPDATA'])), looked.join('\n'))
})

test('every account links through its provider\'s own route, and there is no Claude sign-in', () => {
  const ids = new Set(BUILT_IN.map((p) => p.id))
  for (const target of LINK_TARGETS) {
    assert.ok(ids.has(target.providerId), `${target.providerId} is a provider`)
    if (target.method === 'signin') {
      const meta = providerMeta(target.providerId)
      assert.ok(meta.signInLabel || meta.keyFlow, `${target.providerId} has a sign-in of its own`)
    }
  }
  const byId = new Map(LINK_TARGETS.map((t) => [t.providerId, t]))
  assert.equal(byId.get('anthropic')?.method, 'key')
  assert.equal(byId.get('xai')?.method, 'key')
  assert.equal(byId.get('gemini')?.method, 'key')
  // The borrowed-client sign-ins are left out.
  assert.equal(byId.has('openai-codex'), false)
  assert.equal(byId.has('github-copilot'), false)
})
