import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effortsFromLevelMap, effortsFromReasoningOptions, fromModelsDev, fromPiData } from '../src/main/providers/catalogSources'
import { catalogFor } from '../src/main/providers/modelCatalog'
import { editModels, getProvider } from '../src/main/providers'
import { store } from '../src/main/store'
import { clampEffort } from '@shared/effort'

test('efforts: Pi level maps become the levels that reach the wire as themselves', () => {
  // GPT-5.5 on the API: off is "none", no minimal, xhigh but no max.
  assert.deepEqual(
    effortsFromLevelMap(true, { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: null }),
    ['none', 'light', 'medium', 'high', 'extra-high']
  )
  // Codex folds minimal into low: Low is offered once, and off is not offered at all.
  assert.deepEqual(effortsFromLevelMap(true, { xhigh: 'xhigh', minimal: 'low' }), ['light', 'medium', 'high', 'extra-high'])
  // Opus 4.6: max, but no xhigh.
  assert.deepEqual(effortsFromLevelMap(true, { max: 'max' }), ['light', 'medium', 'high', 'ultra'])
  // No map (budget-era Claude, toggle-only GLM) and non-reasoning models take no effort.
  assert.deepEqual(effortsFromLevelMap(true, undefined), [])
  assert.deepEqual(effortsFromLevelMap(false, { max: 'max' }), [])
  // A list that is only Off would switch thinking off for good.
  assert.deepEqual(effortsFromLevelMap(true, { off: 'none', low: null, medium: null, high: null }), [])
})

test('efforts: models.dev reasoning options, with "default" dropped', () => {
  assert.deepEqual(effortsFromReasoningOptions([{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }]), [
    'none',
    'light',
    'medium',
    'high',
    'extra-high',
    'ultra'
  ])
  assert.deepEqual(effortsFromReasoningOptions([{ type: 'effort', values: ['none', 'default'] }]), [])
  assert.deepEqual(effortsFromReasoningOptions([{ type: 'toggle' }, { type: 'budget_tokens' }]), [])
})

test('efforts: a chosen level clamps down to what the model takes, never to nothing', () => {
  assert.equal(clampEffort('ultra', ['light', 'medium', 'high']), 'high')
  assert.equal(clampEffort('none', ['light', 'medium', 'high']), 'light')
  assert.equal(clampEffort('extra-high', ['high', 'ultra']), 'high')
  assert.equal(clampEffort('light', ['high', 'ultra']), 'high')
  assert.equal(clampEffort('medium', []), undefined)
  assert.equal(clampEffort('medium', undefined), undefined)
})

test('models.dev: chat models that call tools, newest first, without dated duplicates or deprecated ones', () => {
  const models = fromModelsDev(
    {
      models: {
        'claude-haiku-4-5': { name: 'Claude Haiku 4.5 (latest)', tool_call: true, release_date: '2025-10-15', limit: { context: 200000, output: 64000 }, modalities: { input: ['text', 'image'], output: ['text'] } },
        'claude-haiku-4-5-20251001': { name: 'Claude Haiku 4.5', tool_call: true, release_date: '2025-10-15' },
        'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5', tool_call: true, reasoning: true, release_date: '2026-09-28', reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
        'old-model': { name: 'Old', tool_call: true, status: 'deprecated' },
        'no-tools': { name: 'No tools', tool_call: false },
        'image-maker': { name: 'Image maker', tool_call: true, modalities: { input: ['text'], output: ['image'] } }
      }
    },
    'anthropic'
  )
  assert.deepEqual(
    models.map((m) => m.id),
    ['claude-sonnet-5-5', 'claude-haiku-4-5']
  )
  assert.equal(models[1].label, 'Claude Haiku 4.5')
  assert.equal(models[1].vision, true)
  assert.equal(models[1].contextWindow, 200000)
  assert.deepEqual(models[0].efforts, ['light', 'high', 'ultra'])
  // Perplexity's Sonar answers without tools, so its models are kept, marked tool-less.
  const sonar = fromModelsDev({ models: { sonar: { name: 'Sonar', tool_call: false } } }, 'perplexity')
  assert.equal(sonar[0]?.tools, false)
})

test('Pi data: one entry per id across API groups', () => {
  const models = fromPiData({
    'anthropic-messages': { 'chat:a': { id: 'a', name: 'A', reasoning: true, thinkingLevelMap: { max: 'max' }, input: ['text', 'image'], contextWindow: 1000, maxTokens: 500 } },
    'openai-completions': { 'chat:a': { id: 'a', name: 'A again' }, 'chat:b': { id: 'b', name: 'B' } }
  })
  assert.deepEqual(
    models.map((m) => [m.id, m.label]),
    [
      ['a', 'A'],
      ['b', 'B']
    ]
  )
  assert.deepEqual(models[0].efforts, ['light', 'medium', 'high', 'ultra'])
})

test('the shipped catalog has the current Claude and GPT models', () => {
  const anthropic = catalogFor('anthropic').map((m) => m.id)
  for (const id of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5']) assert.ok(anthropic.includes(id), `missing ${id}`)
  const openai = catalogFor('openai').map((m) => m.id)
  for (const id of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']) assert.ok(openai.includes(id), `missing ${id}`)
  assert.ok(catalogFor('openrouter').length > 100)
})

test('removing a model hides it; it can be restored, and renames and added models survive', () => {
  const id = 'anthropic'
  const total = getProvider(id)!.models.length
  editModels(id, { remove: 'claude-sonnet-5-5' })
  let provider = getProvider(id)!
  assert.ok(!provider.models.some((m) => m.id === 'claude-sonnet-5-5'))
  assert.deepEqual(provider.hiddenModels?.map((m) => m.id), ['claude-sonnet-5-5'])

  editModels(id, { restore: 'claude-sonnet-5-5' })
  provider = getProvider(id)!
  assert.equal(provider.models.length, total)
  assert.equal(provider.hiddenModels?.length, 0)

  editModels(id, { rename: 'claude-opus-5-5', label: 'Opus' })
  editModels(id, { add: 'claude-next-preview' })
  provider = getProvider(id)!
  assert.equal(provider.models.find((m) => m.id === 'claude-opus-5-5')?.label, 'Opus')
  assert.equal(provider.models.find((m) => m.id === 'claude-next-preview')?.custom, true)

  // An added model is deleted outright, not hidden; an empty rename goes back to the catalog's name.
  editModels(id, { remove: 'claude-next-preview' })
  editModels(id, { rename: 'claude-opus-5-5', label: null })
  provider = getProvider(id)!
  assert.ok(!provider.models.some((m) => m.id === 'claude-next-preview'))
  assert.ok(!provider.hiddenModels?.some((m) => m.id === 'claude-next-preview'))
  assert.equal(provider.models.find((m) => m.id === 'claude-opus-5-5')?.label, 'Claude Opus 5.5')
})

test('an old saved list no longer hides catalog models, and its extra models are kept', () => {
  // Before overlays a refresh or a delete replaced the whole list, so a model
  // missing from it was gone until the next refresh.
  const config = store.getProviderConfig()
  config.openai = { models: [{ id: 'gpt-4.1', label: 'GPT-4.1', providerId: 'openai' }, { id: 'ft:gpt-4.1:acme', label: 'Fine-tune', providerId: 'openai' }] }
  store.saveProviderConfig(config)
  const ids = getProvider('openai')!.models.map((m) => m.id)
  assert.ok(ids.includes('gpt-6.1-sol'), 'catalog models come back')
  assert.ok(ids.includes('ft:gpt-4.1:acme'), 'listed-only models stay')
  assert.ok(ids.indexOf('gpt-6.1-sol') < ids.indexOf('ft:gpt-4.1:acme'), 'catalog first, newest first')

  // The first edit rewrites the old list as the provider's listing.
  editModels('openai', { remove: 'gpt-4.1' })
  const saved = store.getProviderConfig().openai
  assert.equal(saved.models, undefined)
  assert.equal(saved.listed?.length, 2)
  assert.deepEqual(saved.hidden, ['gpt-4.1'])
})

test('a model whose endpoint drops the effort field offers no effort picker', () => {
  // Copilot serves Gemini over chat-completions, which rejects reasoning_effort;
  // its GPT models go over Responses and keep theirs.
  const copilot = getProvider('github-copilot')!
  const gemini = copilot.models.find((m) => m.id.startsWith('gemini'))
  const gpt = copilot.models.find((m) => m.id.startsWith('gpt-6'))
  assert.ok(gemini && gpt)
  assert.deepEqual(gemini.efforts, [])
  assert.ok((gpt.efforts?.length ?? 0) > 0)
})
