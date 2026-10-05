import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelInfo, Provider } from '@shared/types'
import type { EngineModels, EngineStatus } from '@shared/engines'
import {
  ago,
  datedAliasOf,
  defaultModel,
  describeModelsRefresh,
  engineOptions,
  engineReadiness,
  findModel,
  foldDatedAliases,
  groupOptions,
  modelCapabilities,
  modelKey,
  modelStage,
  moveActive,
  nativeOptions,
  parseModelKey,
  providerReadiness,
  resolveEngineSelection,
  resolveSelection,
  searchOptions,
  toggleFavorite,
  withRecent
} from '@shared/modelSelection'

/*
 * The one selection layer every model picker uses (shared/modelSelection):
 * readiness, what a saved choice resolves to, grouping, search, keys,
 * recents and the refresh wording. Pure, so driven directly.
 */

const model = (providerId: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: extra.label ?? id, providerId, ...extra })

const provider = (id: string, extra: Partial<Provider> = {}): Provider => ({
  id,
  name: extra.name ?? id[0].toUpperCase() + id.slice(1),
  kind: 'openai-compatible',
  baseUrl: 'https://example.test/v1',
  hasKey: true,
  enabled: true,
  builtIn: true,
  local: false,
  fallbackCount: 0,
  auth: 'key',
  models: [model(id, `${id}-a`), model(id, `${id}-b`)],
  ...extra
})

const expired = { ok: false, issue: { kind: 'auth-expired' as const, message: 'Your ChatGPT session expired. Sign in again.', action: 'reconnect' as const }, checkedAt: 1 }

test('keys: provider ids never hold a colon, model ids may', () => {
  assert.equal(modelKey('ollama', 'gpt-oss:20b'), 'ollama:gpt-oss:20b')
  assert.deepEqual(parseModelKey('ollama:gpt-oss:20b'), { providerId: 'ollama', modelId: 'gpt-oss:20b' })
  assert.equal(parseModelKey('nocolon'), null)
  assert.equal(parseModelKey(':x'), null)
})

test('readiness: off, not set up, needs attention, not running, ready', () => {
  assert.equal(providerReadiness(provider('openai', { enabled: false })).state, 'off')
  assert.equal(providerReadiness(provider('openai', { hasKey: false })).action, 'add-key')
  assert.equal(providerReadiness(provider('chatgpt', { auth: 'oauth', hasKey: false, signedIn: false })).action, 'sign-in')
  // Stored credentials alone don't make it ready once a check found them rejected.
  const rejected = providerReadiness(provider('openai', { health: { ok: false, issue: { kind: 'key-invalid', message: 'OpenAI rejected the API key.', action: 'fix-key' }, checkedAt: 1 } }))
  assert.equal(rejected.state, 'attention')
  assert.equal(rejected.action, 'fix-key')
  // A sign-in that ran out clears its tokens; it still reads as expired, not "never signed in".
  const ran = providerReadiness(provider('chatgpt', { auth: 'oauth', hasKey: false, signedIn: false, health: expired }))
  assert.equal(ran.state, 'attention')
  assert.equal(ran.action, 'reconnect')
  // A passing failure (offline) never marks a provider.
  assert.equal(providerReadiness(provider('openai', { health: { ok: false, issue: { kind: 'network', message: 'x', action: 'retry' }, checkedAt: 1 } })).state, 'ready')
  assert.equal(providerReadiness(provider('ollama', { local: true, hasKey: false, models: [] })).state, 'unavailable')
  assert.equal(providerReadiness(provider('eaon-local', { local: true, hasKey: false, models: [] })).action, 'get-local-model')
  assert.equal(providerReadiness(provider('github-copilot', { auth: 'oauth', signedIn: true, models: [] })).state, 'attention')
  assert.equal(providerReadiness(provider('openai')).state, 'ready')
})

test('selection: a choice that disappears stays unavailable with why — never swapped for another model', () => {
  const openai = provider('openai')
  const anthropic = provider('anthropic')
  // The chosen model is gone from its provider: unavailable, even though other models are ready.
  const gone = resolveSelection({ providerId: 'openai', modelId: 'gpt-old' }, [openai, anthropic])
  assert.equal(gone.status, 'unavailable')
  assert.equal(gone.model, null)
  assert.equal(gone.wanted?.modelId, 'gpt-old')
  assert.match(gone.reason!, /doesn’t offer it any more/)
  assert.equal(gone.action, 'choose-model')
  // Same id offered elsewhere still doesn't stand in: a different account and bill.
  const both = [provider('openai', { enabled: false }), provider('openrouter', { models: [model('openrouter', 'openai-a')] })]
  const off = resolveSelection({ providerId: 'openai', modelId: 'openai-a' }, both)
  assert.equal(off.status, 'unavailable')
  assert.equal(off.action, 'turn-on')
  assert.equal(off.wanted?.label, 'openai-a')
  // Signed out of the provider.
  const out = resolveSelection({ providerId: 'chatgpt', modelId: 'chatgpt-a' }, [provider('chatgpt', { auth: 'oauth', hasKey: false, signedIn: false, health: expired })])
  assert.equal(out.status, 'unavailable')
  assert.equal(out.action, 'reconnect')
  // Removed by the user: restorable, so it says so.
  const hidden = resolveSelection({ providerId: 'openai', modelId: 'h' }, [provider('openai', { hiddenModels: [model('openai', 'h', { label: 'Hidden one' })] })])
  assert.equal(hidden.wanted?.label, 'Hidden one')
  assert.match(hidden.reason!, /removed it/)
  // The provider itself was deleted.
  assert.match(resolveSelection({ providerId: 'mine', modelId: 'x' }, [openai]).reason!, /removed from Model providers/)
})

test('selection: a usable choice resolves to itself; a provider needing attention keeps it but says so', () => {
  const ok = resolveSelection({ providerId: 'anthropic', modelId: 'anthropic-b' }, [provider('openai'), provider('anthropic')])
  assert.equal(ok.status, 'selected')
  assert.equal(ok.model?.id, 'anthropic-b')
  const attention = resolveSelection(
    { providerId: 'openai', modelId: 'openai-a' },
    [provider('openai', { health: { ok: false, issue: { kind: 'key-invalid', message: 'OpenAI rejected the API key.', action: 'fix-key' }, checkedAt: 1 } })]
  )
  assert.equal(attention.status, 'selected')
  assert.equal(attention.attention, 'OpenAI rejected the API key.')
  // A dated snapshot saved before it was folded into its alias still resolves.
  const folded = provider('anthropic', { models: [model('anthropic', 'claude-x', { aliases: ['claude-x-20251001'] })] })
  assert.equal(resolveSelection({ providerId: 'anthropic', modelId: 'claude-x-20251001' }, [folded]).model?.id, 'claude-x')
  // A choice saved before provider ids were: the first usable provider that has it.
  assert.equal(resolveSelection({ providerId: null, modelId: 'anthropic-a' }, [provider('openai'), provider('anthropic')]).model?.providerId, 'anthropic')
})

test('selection: nothing chosen gets a default — a ready favorite, then a recent, then the first ready model', () => {
  const providers = [provider('broken', { health: { ok: false, issue: { kind: 'key-invalid', message: 'x', action: 'fix-key' }, checkedAt: 1 } }), provider('openai'), provider('anthropic')]
  assert.equal(resolveSelection({ providerId: null, modelId: null }, providers).model?.id, 'openai-a')
  assert.equal(defaultModel(providers, { recents: ['anthropic:anthropic-b'] })?.model.id, 'anthropic-b')
  assert.equal(defaultModel(providers, { favorites: ['anthropic:anthropic-a'], recents: ['openai:openai-b'] })?.model.id, 'anthropic-a')
  // A favorite on a provider needing attention isn't picked silently.
  assert.equal(defaultModel(providers, { favorites: ['broken:broken-a'] })?.model.id, 'openai-a')
})

test('selection: with nothing usable the composer gets the first-run sentence, or the fix for what is broken', () => {
  const none = resolveSelection({ providerId: null, modelId: null }, [provider('openai', { hasKey: false }), provider('ollama', { local: true, hasKey: false, models: [] })])
  assert.equal(none.status, 'none')
  assert.equal(none.action, 'connect')
  assert.equal(none.reason, 'No usable model is connected. Sign in to a supported account, add an API key, or choose a local model.')
  const broken = resolveSelection({ providerId: null, modelId: null }, [provider('chatgpt', { auth: 'oauth', hasKey: false, signedIn: false, health: expired })])
  assert.equal(broken.status, 'none')
  assert.equal(broken.action, 'reconnect')
  assert.equal(broken.provider?.id, 'chatgpt')
})

test('options: only connected providers, attention marked, capabilities honest', () => {
  const options = nativeOptions([
    provider('openai', { models: [model('openai', 'gpt', { vision: true, tools: true, reasoning: true, efforts: ['light', 'high'] })] }),
    provider('off', { enabled: false }),
    provider('nokey', { hasKey: false }),
    provider('bad', { health: { ok: false, issue: { kind: 'quota', message: 'Out of credit.', action: 'fix-key' }, checkedAt: 1 } })
  ])
  assert.deepEqual([...new Set(options.map((o) => o.providerId))], ['openai', 'bad'])
  assert.equal(options[0].vision, true)
  assert.equal(options.find((o) => o.providerId === 'bad')?.availability, 'attention')
  assert.equal(options.find((o) => o.providerId === 'bad')?.reason, 'Out of credit.')
  // Unknown stays unknown; a guess from the id is not evidence.
  const unknown = modelCapabilities(model('x', 'mystery'))
  assert.deepEqual(unknown, { tools: null, vision: null, reasoning: null })
  assert.equal(modelCapabilities(model('x', 'deepseek-r9', { reasoning: true, inferred: ['reasoning'] })).reasoning, null)
  assert.equal(modelCapabilities(model('x', 'gpt-9', { reasoning: true, efforts: ['light'], inferred: ['reasoning', 'efforts'] })).reasoning, null)
  assert.equal(modelCapabilities(model('x', 'known', { reasoning: false, vision: false, tools: true })).vision, false)
  assert.equal(modelCapabilities(model('x', 'known', { efforts: ['high'] })).reasoning, true)
})

test('groups: starred, recent without the starred ones, then providers in order; nothing cut off', () => {
  const many = Array.from({ length: 120 }, (_, i) => model('openrouter', `m${i}`))
  const options = nativeOptions([provider('openai'), provider('openrouter', { models: many })])
  const groups = groupOptions(options, { favorites: ['openrouter:m99'], recents: ['openrouter:m99', 'openai:openai-b', 'gone:x'] })
  assert.deepEqual(
    groups.map((g) => [g.id, g.options.length]),
    [
      ['starred', 1],
      ['recent', 1],
      ['openai', 2],
      ['openrouter', 120]
    ]
  )
})

test('search: exact and prefix beat substrings, every word must match, all matches returned', () => {
  const options = nativeOptions([
    provider('openai', { name: 'OpenAI', models: [model('openai', 'gpt-5.5', { label: 'GPT-5.5' }), model('openai', 'gpt-5.5-mini', { label: 'GPT-5.5 mini' }), model('openai', 'o-gpt-legacy', { label: 'Legacy GPT' })] }),
    provider('anthropic', { name: 'Anthropic', models: [model('anthropic', 'claude-sonnet-5-5', { label: 'Claude Sonnet 5.5' })] })
  ])
  assert.deepEqual(
    searchOptions(options, 'gpt-5.5').map((o) => o.modelId),
    ['gpt-5.5', 'gpt-5.5-mini']
  )
  assert.equal(searchOptions(options, 'gpt')[2].modelId, 'o-gpt-legacy')
  assert.deepEqual(
    searchOptions(options, 'sonnet 5.5').map((o) => o.modelId),
    ['claude-sonnet-5-5']
  )
  // The provider's name finds its models.
  assert.equal(searchOptions(options, 'anthropic').length, 1)
  // Letters in order: "gpt55" finds GPT-5.5.
  assert.equal(searchOptions(options, 'gpt55')[0].modelId, 'gpt-5.5')
  assert.equal(searchOptions(options, 'nothing like it').length, 0)
  // A starred model wins a tie.
  assert.equal(searchOptions(options, 'gpt-5.5', { favorites: ['openai:gpt-5.5-mini'] })[0].modelId, 'gpt-5.5')
  assert.equal(searchOptions(options, 'mini gpt', { favorites: ['openai:gpt-5.5-mini'] })[0].modelId, 'gpt-5.5-mini')
})

test('keyboard: arrows, pages, ends; nothing wraps; other keys are not navigation', () => {
  assert.equal(moveActive(0, 'ArrowUp', 5), 0)
  assert.equal(moveActive(4, 'ArrowDown', 5), 4)
  assert.equal(moveActive(1, 'ArrowDown', 5), 2)
  assert.equal(moveActive(1, 'PageDown', 30), 8)
  assert.equal(moveActive(3, 'PageUp', 30), 0)
  assert.equal(moveActive(3, 'End', 30), 29)
  assert.equal(moveActive(3, 'Home', 30), 0)
  assert.equal(moveActive(3, 'a', 30), null)
  assert.equal(moveActive(0, 'ArrowDown', 0), null)
})

test('recents and favorites: newest first, no duplicates, capped; stars toggle', () => {
  assert.deepEqual(withRecent(['a:1', 'b:2'], 'b:2'), ['b:2', 'a:1'])
  assert.equal(withRecent(Array.from({ length: 20 }, (_, i) => `p:${i}`), 'p:new').length, 8)
  assert.deepEqual(toggleFavorite(['a:1'], 'a:1'), [])
  assert.deepEqual(toggleFavorite(undefined, 'a:1'), ['a:1'])
})

test('dated aliases fold into the alias; hand-added models and lone snapshots stay', () => {
  assert.equal(datedAliasOf('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5')
  assert.equal(datedAliasOf('gpt-4o-2024-08-06'), 'gpt-4o')
  assert.equal(datedAliasOf('claude-opus-4-1@20250805'), 'claude-opus-4-1')
  assert.equal(datedAliasOf('gpt-5.5'), null)
  const folded = foldDatedAliases([
    model('anthropic', 'claude-sonnet-4-5'),
    model('anthropic', 'claude-sonnet-4-5-20250929'),
    model('anthropic', 'claude-haiku-9-20990101'),
    model('anthropic', 'claude-sonnet-4-5-20990101', { custom: true })
  ])
  assert.deepEqual(
    folded.map((m) => m.id),
    ['claude-sonnet-4-5', 'claude-haiku-9-20990101', 'claude-sonnet-4-5-20990101']
  )
  assert.deepEqual(folded[0].aliases, ['claude-sonnet-4-5-20250929'])
  assert.equal(findModel(folded, 'claude-sonnet-4-5-20250929')?.id, 'claude-sonnet-4-5')
})

test('stage: from the source when it says, else from an id that calls itself a preview', () => {
  assert.equal(modelStage({ id: 'gemini-3-pro-preview' }), 'preview')
  assert.equal(modelStage({ id: 'gemini-2.0-flash-exp' }), 'preview')
  assert.equal(modelStage({ id: 'codestral-expert' }), null)
  assert.equal(modelStage({ id: 'mistral-large', stage: 'deprecated' }), 'deprecated')
  assert.equal(modelStage({ id: 'gpt-5.5' }), null)
})

/* ---------------------------------------------------------- engines (mocked Codex) */

const codexModels: EngineModels = {
  engine: 'codex',
  models: [
    { id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', efforts: ['light', 'medium', 'high'], defaultEffort: 'medium', vision: true, isDefault: true, source: { kind: 'engine-live', retrievedAt: 1000 } },
    { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini', efforts: [], defaultEffort: null, vision: null, isDefault: false, source: { kind: 'engine-live', retrievedAt: 1000 } }
  ],
  retrievedAt: 1000,
  staleBecause: null
}
const codexStatus = (auth: EngineStatus['auth']['state'], installed = true): EngineStatus => ({
  id: 'codex',
  name: 'Codex',
  installed,
  path: installed ? '/usr/local/bin/codex' : null,
  foundIn: installed ? 'PATH' : null,
  version: installed ? '0.155.0' : null,
  latestVersion: null,
  updateAvailable: false,
  outdated: false,
  minVersion: '0.150.0',
  updateHint: 'npm i -g @openai/codex',
  auth: { state: auth, method: auth === 'signed-in' ? 'ChatGPT' : null, plan: auth === 'signed-in' ? 'Plus' : null },
  error: null,
  checkedAt: 1000
})

test('engines: Codex models are their own group, marked by its sign-in; native lists none', () => {
  assert.deepEqual(engineOptions('native', codexModels, null), [])
  const ready = engineOptions('codex', codexModels, codexStatus('signed-in'))
  assert.deepEqual(
    ready.map((o) => [o.key, o.availability, o.isDefault]),
    [
      ['engine:codex:gpt-5.5-codex', 'ready', true],
      ['engine:codex:gpt-5.5-mini', 'ready', false]
    ]
  )
  assert.equal(ready[0].groupLabel, 'Codex')
  assert.equal(ready[1].vision, null)
  assert.equal(engineOptions('codex', codexModels, codexStatus('signed-out'))[0].availability, 'unavailable')
  assert.equal(engineReadiness('codex', codexStatus('signed-in')).label, 'Signed in · Plus')
  assert.equal(engineReadiness('codex', codexStatus('expired')).action, 'reconnect')
  assert.equal(engineReadiness('codex', codexStatus('signed-out', false)).label, 'Not installed')
  assert.equal(engineReadiness('codex', null).state, 'unavailable')
})

test('engines: a Codex choice resolves like a provider one — default, chosen, or unavailable with why', () => {
  assert.equal(resolveEngineSelection('codex', null, codexModels, codexStatus('signed-in')).option?.modelId, 'gpt-5.5-codex')
  assert.equal(resolveEngineSelection('codex', 'gpt-5.5-mini', codexModels, codexStatus('signed-in')).status, 'selected')
  const gone = resolveEngineSelection('codex', 'gpt-4-old', codexModels, codexStatus('signed-in'))
  assert.equal(gone.status, 'unavailable')
  assert.match(gone.reason!, /doesn’t offer gpt-4-old/)
  const signedOut = resolveEngineSelection('codex', 'gpt-5.5-mini', codexModels, codexStatus('signed-out'))
  assert.equal(signedOut.status, 'unavailable')
  assert.equal(signedOut.action, 'sign-in')
  assert.equal(resolveEngineSelection('codex', null, codexModels, codexStatus('signed-out', false)).status, 'none')
})

/* -------------------------------------------------------------- freshness wording */

test('refresh wording: what changed, "No changes", or which list is shown when it failed', () => {
  const now = 10 * 3_600_000
  assert.equal(describeModelsRefresh({ providerName: 'Anthropic', ok: true, added: ['A', 'B', 'C'], removed: [], lastGoodAt: now, now }), 'Updated just now · 3 new models: A, B, C.')
  assert.equal(describeModelsRefresh({ providerName: 'Anthropic', ok: true, added: ['A', 'B', 'C', 'D', 'E'], removed: ['Old'], lastGoodAt: now, now }), 'Updated just now · 5 new models: A, B, C and 2 more · 1 model no longer offered: Old.')
  assert.equal(describeModelsRefresh({ providerName: 'Anthropic', ok: true, added: [], removed: [], lastGoodAt: now, now }), 'No changes · checked just now.')
  assert.equal(
    describeModelsRefresh({ providerName: 'Anthropic', ok: false, added: [], removed: [], failure: 'Anthropic rejected the API key.', lastGoodAt: now - 2 * 3_600_000, now }),
    'Couldn’t refresh Anthropic — showing the list from 2 h ago. Anthropic rejected the API key.'
  )
  assert.equal(describeModelsRefresh({ providerName: 'Groq', ok: false, added: [], removed: [], lastGoodAt: null, now }), 'Couldn’t refresh Groq — showing Eaon’s built-in list.')
  assert.equal(ago(now - 30_000, now), 'just now')
  assert.equal(ago(now - 5 * 60_000, now), '5 min ago')
  assert.equal(ago(now - 3 * 86_400_000, now), '3 days ago')
})
