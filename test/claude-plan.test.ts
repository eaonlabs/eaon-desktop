import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkKeyShape, CLAUDE_LOGIN_TOKEN, isClaudeLoginToken } from '@shared/providers'
import { BUILT_IN, providerMeta } from '../src/main/providers/catalog'

/**
 * Claude and Anthropic's rules for apps (Agent SDK docs, Oct 2026): no
 * claude.ai login or plan limits in a third-party product without
 * Anthropic's approval — API keys instead. Max and Team plans' monthly API
 * credits reach Eaon that way. Accounts that use a Claude login elsewhere
 * risk suspension, so Eaon refuses one wherever a key goes.
 */

test('a Claude subscription login token is never taken as a key, for any provider', () => {
  for (const token of ['sk-ant-oat01-abcdefghijklmnopqrstuvwxyz', 'sk-ant-ort01-abcdefghijklmnopqrstuvwxyz', 'Bearer sk-ant-oat01-abcdefghijklmnop', '"sk-ant-oat01-abcdefghijklmnop"']) {
    for (const [id, name] of [['anthropic', 'Anthropic'], ['openrouter', 'OpenRouter'], ['custom-gateway', 'My gateway']]) {
      assert.equal(checkKeyShape(id, name, token).problem, CLAUDE_LOGIN_TOKEN, `${name}: ${token}`)
    }
  }
  assert.equal(isClaudeLoginToken('sk-ant-oat01-x'), true)
  assert.equal(isClaudeLoginToken('sk-ant-api03-abcdefghijkl'), false)
  // A real API key is fine.
  assert.equal(checkKeyShape('anthropic', 'Anthropic', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz').problem, null)
  assert.match(CLAUDE_LOGIN_TOKEN, /API key in the Claude Console/)
})

test('Claude in Eaon offers no sign-in with a Claude account, and shows how a plan’s monthly API credits reach it', () => {
  const anthropic = BUILT_IN.find((p) => p.id === 'anthropic')!
  assert.equal(anthropic.auth, 'key')
  assert.equal((anthropic as { oauthFlow?: string }).oauthFlow, undefined, 'no claude.ai login')
  const meta = providerMeta('anthropic')
  assert.equal(meta.signInLabel, undefined)
  assert.match(meta.noSignInReason ?? '', /doesn’t allow other apps to sign in with a Claude account or to use your plan’s usage limits/)
  assert.equal(meta.planInAde, 'claude', 'the plan itself is used in Claude Code, as itself')
  const credits = meta.planCredits!
  assert.match(credits.detail, /Max and Team plans include monthly API credits/)
  assert.ok(credits.steps.some((s) => /Settings → Billing.*Link organization/.test(s)))
  assert.ok(credits.steps.some((s) => /API key/.test(s)))
  assert.deepEqual(
    credits.links.map((l) => new URL(l.url).hostname),
    ['claude.ai', 'console.anthropic.com', 'support.claude.com']
  )
  // No provider in the catalog signs in with a Claude account.
  for (const provider of BUILT_IN) assert.ok(!/claude|anthropic/i.test(String((provider as { oauthFlow?: string }).oauthFlow ?? '')), provider.id)
})
