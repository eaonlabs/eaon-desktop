import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effortsFromLevelMap, effortsFromReasoningOptions, fromModelsDev, fromPiData } from '../src/main/providers/catalogSources'
import { catalogFor } from '../src/main/providers/modelCatalog'
import { editModels, getProvider } from '../src/main/providers'
import { store } from '../src/main/store'
import { clampEffort } from '@shared/effort'
import { modelCapabilities } from '@shared/modelSelection'
import { parseChatGptPlanListing } from '../src/main/providers/listing'
import { enrichModel } from '../src/main/providers/models'

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

test('Edit model: a hand-added model gets real limits and capabilities, and its id can be corrected', () => {
  const id = 'openai'
  editModels(id, { add: 'my-finetune-v1' })
  let model = getProvider(id)!.models.find((m) => m.id === 'my-finetune-v1')!
  assert.equal(model.custom, true)
  assert.equal(model.vision, undefined, 'a model added by id starts with nothing known')

  editModels(id, { update: 'my-finetune-v1', label: 'My fine-tune', fields: { contextWindow: 200_000, maxOutput: 32_000, vision: true, tools: true, reasoning: true } })
  model = getProvider(id)!.models.find((m) => m.id === 'my-finetune-v1')!
  assert.equal(model.label, 'My fine-tune')
  assert.equal(model.contextWindow, 200_000)
  assert.equal(model.maxOutput, 32_000)
  assert.equal(model.vision, true)
  assert.equal(model.reasoning, true)
  assert.ok((model.efforts ?? []).length >= 3, 'marked as thinking: it gets the effort control')
  assert.equal(model.edited, true)

  // The selection and the star follow a corrected id.
  store.patchSettings({ selectedProviderId: id, selectedModelId: 'my-finetune-v1', favoriteModels: [`${id}:my-finetune-v1`] })
  editModels(id, { update: 'my-finetune-v1', id: 'my-finetune-v2' })
  const ids = getProvider(id)!.models.map((m) => m.id)
  assert.ok(ids.includes('my-finetune-v2') && !ids.includes('my-finetune-v1'))
  model = getProvider(id)!.models.find((m) => m.id === 'my-finetune-v2')!
  assert.equal(model.contextWindow, 200_000, 'its details moved with it')
  assert.equal(store.getSettings().selectedModelId, 'my-finetune-v2')
  assert.deepEqual(store.getSettings().favoriteModels, [`${id}:my-finetune-v2`])

  // Thinking off takes the effort control away; null puts one field back.
  editModels(id, { update: 'my-finetune-v2', fields: { reasoning: false, contextWindow: null } })
  model = getProvider(id)!.models.find((m) => m.id === 'my-finetune-v2')!
  assert.equal(model.reasoning, false)
  assert.deepEqual(model.efforts, [])
  assert.equal(model.contextWindow, undefined)
  editModels(id, { remove: 'my-finetune-v2' })
})

test('Edit model: a catalog model can be adjusted and reset, but keeps its id', () => {
  const id = 'anthropic'
  const before = getProvider(id)!.models.find((m) => m.id === 'claude-haiku-4-5')!
  editModels(id, { update: 'claude-haiku-4-5', id: 'renamed-id', fields: { contextWindow: 50_000, vision: false } })
  let model = getProvider(id)!.models.find((m) => m.id === 'claude-haiku-4-5')!
  assert.ok(model, 'a catalog model keeps its id')
  assert.equal(model.contextWindow, 50_000)
  assert.equal(model.vision, false)
  assert.equal(model.edited, true)
  editModels(id, { reset: 'claude-haiku-4-5' })
  model = getProvider(id)!.models.find((m) => m.id === 'claude-haiku-4-5')!
  assert.equal(model.contextWindow, before.contextWindow)
  assert.equal(model.vision, before.vision)
  assert.equal(model.edited, undefined)
  assert.throws(() => {
    editModels('openai', { add: 'a-model' })
    editModels('openai', { add: 'b-model' })
    editModels('openai', { update: 'a-model', id: 'b-model' })
  }, /already a model "b-model"/)
})

/* ------------------------------------------------- capability honesty, sources */

test('capabilities: the catalog’s known ones stay; a listing-only model is unknown, and a guess from its id is marked', () => {
  const config = store.getProviderConfig()
  const before = config.anthropic
  try {
    // A listing that names a model the catalog doesn't know, and a dated snapshot of one it does.
    config.anthropic = {
      listed: [
        { id: 'claude-sonnet-5-5-20260928', label: 'Claude Sonnet 5.5', providerId: 'anthropic' },
        { id: 'claude-mystery-9', label: 'Claude Mystery 9', providerId: 'anthropic' }
      ],
      listedAt: Date.now()
    }
    store.saveProviderConfig(config)
    const models = getProvider('anthropic')!.models
    const sonnet = models.find((m) => m.id === 'claude-sonnet-5-5')!
    // Known from the catalog: kept, and the live listing now vouches for it.
    assert.equal(sonnet.vision, true)
    assert.equal(sonnet.source?.kind, 'provider-live')
    // The dated snapshot is folded into its alias rather than listed twice.
    assert.ok(!models.some((m) => m.id === 'claude-sonnet-5-5-20260928'))
    assert.deepEqual(sonnet.aliases, ['claude-sonnet-5-5-20260928'])
    const mystery = models.find((m) => m.id === 'claude-mystery-9')!
    assert.equal(mystery.vision, undefined, 'no Images badge on the strength of the name')
    assert.deepEqual(modelCapabilities(mystery), { tools: null, vision: null, reasoning: null })
    // Untouched catalog models say where they came from.
    assert.equal(models.find((m) => m.id === 'claude-opus-5-5')?.source?.kind, 'shipped')
  } finally {
    if (before) config.anthropic = before
    else delete config.anthropic
    store.saveProviderConfig(config)
  }
})

test('capabilities: the ChatGPT plan listing reports only what its rows say', () => {
  const [bare, rich] = parseChatGptPlanListing(
    {
      models: [
        { slug: 'gpt-6-next', display_name: 'GPT Next', visibility: 'list' },
        { slug: 'gpt-next-codex', display_name: 'GPT Next Codex', visibility: 'list', input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], shell_type: 'unified_exec' },
        { slug: 'hidden', visibility: 'hide' }
      ]
    },
    'chatgpt'
  )
  assert.deepEqual(bare, { id: 'gpt-6-next', label: 'GPT Next', providerId: 'chatgpt' })
  assert.equal(rich.vision, true)
  assert.equal(rich.tools, true)
  assert.deepEqual(rich.efforts, ['light', 'medium', 'high', 'extra-high'])
  // Filled in from the id for the request's sake, and marked as a guess.
  const enriched = enrichModel(bare)
  assert.equal(enriched.reasoning, true)
  assert.deepEqual(enriched.inferred?.sort(), ['efforts', 'reasoning'])
  assert.equal(modelCapabilities(enriched).reasoning, null)
})
