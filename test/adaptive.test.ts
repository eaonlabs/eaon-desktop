import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EffortLevel, ModelInfo, Provider } from '@shared/types'
import type { EngineModels, EngineStatus } from '@shared/engines'
import { engineOptions, nativeOptions, type ModelOption } from '@shared/modelSelection'
import { candidates, classifyTask, pickModel, routeRecord, tierOf, versionOf, type Task } from '@shared/adaptive'

/*
 * Adaptive (shared/adaptive.ts): what a message asks for, which models are in
 * the running, and which one gets it. The accounts below are a real mix: a
 * Claude plan through Claude Code (aliases next to dated, older models), Codex
 * on a ChatGPT plan, OpenRouter on a key, Eaon's free models and a local one.
 */

const ALL: EffortLevel[] = ['light', 'medium', 'high', 'extra-high', 'ultra']
const m = (providerId: string, id: string, label: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label, providerId, tools: true, vision: true, efforts: ALL, ...extra })
const provider = (id: string, models: ModelInfo[], extra: Partial<Provider> = {}): Provider => ({
  id,
  name: id,
  kind: 'openai-compatible',
  baseUrl: 'https://example.test/v1',
  hasKey: true,
  enabled: true,
  builtIn: true,
  local: false,
  fallbackCount: 0,
  auth: 'key',
  models,
  ...extra
})

const claude = provider(
  'claude-agent',
  [
    m('claude-agent', 'default', 'Default', { description: 'Opus 5.5 · Best for everyday, complex tasks' }),
    m('claude-agent', 'opus', 'Opus 5.5', { description: 'For complex work and everyday tasks' }),
    m('claude-agent', 'claude-fable-5-2', 'Fable 5.2', { description: 'For your toughest challenges' }),
    m('claude-agent', 'sonnet', 'Sonnet 5.5', { description: 'Most efficient for simpler tasks' }),
    m('claude-agent', 'haiku', 'Haiku 5.5', { description: 'Fastest for quick answers' }),
    m('claude-agent', 'claude-haiku-4-5-20251001', 'Haiku 4.5', { description: 'Fastest for quick answers', efforts: [] }),
    m('claude-agent', 'claude-opus-4-8', 'Opus 4.8', { description: 'Best for everyday, complex tasks' }),
    m('claude-agent', 'claude-sonnet-5', 'Sonnet 5', { description: 'Efficient for routine tasks' })
  ],
  { auth: 'oauth', hasKey: false, signedIn: true, category: 'subscription' }
)
const openrouter = provider('openrouter', [m('openrouter', 'google/gemini-4-hydrogen', 'Gemini 4 Hydrogen'), m('openrouter', 'baidu/ernie-5.5-flash-preview:free', 'ERNIE-5.5-Flash-Preview (free)')], {
  category: 'gateway'
})
const gateway = provider('eaon-gateway', [m('eaon-gateway', 'gpt-6-luna-free', 'GPT-6-Luna', { description: 'Efficient model from OpenAI for high volume and quick tasks.' })], {
  category: 'eaon'
})
const ollama = provider('ollama', [m('ollama', 'qwen3:8b', 'Qwen3 8B')], { local: true, hasKey: false, auth: 'none', category: 'local' })

const live = { kind: 'engine-live' as const, retrievedAt: 1 }
const codexModels: EngineModels = {
  engine: 'codex',
  models: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', efforts: ALL, defaultEffort: 'light', vision: true, isDefault: true, source: live },
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', efforts: ALL, defaultEffort: 'light', vision: true, isDefault: false, source: live },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', efforts: ALL, defaultEffort: 'light', vision: true, isDefault: false, source: live },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: ALL, defaultEffort: 'light', vision: true, isDefault: false, source: live },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: ALL, defaultEffort: 'light', vision: true, isDefault: false, source: live }
  ],
  retrievedAt: 1,
  staleBecause: null
}
const codexStatus: EngineStatus = {
  id: 'codex',
  name: 'Codex',
  installed: true,
  path: '/usr/local/bin/codex',
  foundIn: 'PATH',
  version: '0.200.0',
  latestVersion: null,
  updateAvailable: false,
  outdated: false,
  minVersion: '0.150.0',
  updateHint: null,
  auth: { state: 'signed-in', method: 'ChatGPT', plan: 'Plus' },
  error: null,
  checkedAt: 1
}

const providers = [claude, openrouter, gateway, ollama]
const options: ModelOption[] = [...nativeOptions(providers), ...engineOptions('codex', codexModels, codexStatus)]
const quiet = { images: false, inProject: true, toolWork: false, previous: null }
const task = (kind: Task['kind'], vision = false): Task => ({ kind, vision })

test('classify: quick questions, writing, coding and hard problems', () => {
  assert.equal(classifyTask('hi', quiet).kind, 'quick')
  assert.equal(classifyTask('what time zone is Tokyo in?', { ...quiet, inProject: false }).kind, 'quick')
  assert.equal(classifyTask('Write an email to my landlord about the broken heater', { ...quiet, inProject: false }).kind, 'write')
  assert.equal(classifyTask('fix the typo in src/App.tsx', quiet).kind, 'code')
  assert.equal(classifyTask('The login button does nothing when I click it', quiet).kind, 'code')
  assert.equal(classifyTask('Build me a racing game with real physics and three tracks', quiet).kind, 'hard')
  assert.equal(classifyTask('Can you redesign the architecture of the sync engine', quiet).kind, 'hard')
  assert.equal(classifyTask('it crashes:\nTypeError: x is undefined\n    at run (src/a.ts:10:5)', quiet).kind, 'hard')
  assert.equal(classifyTask('x '.repeat(900), quiet).kind, 'hard')
  // A go-ahead is more of what the chat was doing.
  assert.equal(classifyTask('continue', { ...quiet, previous: 'hard' }).kind, 'hard')
  assert.equal(classifyTask('yes do it', { ...quiet, toolWork: true }).kind, 'code')
  assert.equal(classifyTask('ok', { ...quiet, previous: null }).kind, 'quick')
  assert.equal(classifyTask('what is in this screenshot', { ...quiet, images: true }).vision, true)
})

test('tiers and versions come from names and what providers say of them', () => {
  assert.equal(tierOf({ modelId: 'haiku', label: 'Haiku 5.5' }), 1)
  assert.equal(tierOf({ modelId: 'sonnet', label: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' }), 2)
  assert.equal(tierOf({ modelId: 'opus', label: 'Opus 5.5' }), 3)
  assert.equal(tierOf({ modelId: 'gpt-6-astra', label: 'GPT-6-Astra' }), 3)
  assert.equal(tierOf({ modelId: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }), 2)
  assert.equal(tierOf({ modelId: 'gpt-6-luna-free', label: 'GPT-6-Luna' }), 1)
  assert.equal(tierOf({ modelId: 'x-1', label: 'X', description: 'Frontier intelligence for the most demanding work.' }), 3)
  assert.equal(versionOf('gpt-6.1-sol'), 6.1)
  assert.equal(versionOf('claude-opus-4-8'), 4.8)
  assert.equal(versionOf('claude-haiku-4-5-20251001'), 4.5)
  assert.equal(versionOf('claude-sonnet-5'), 5)
  assert.equal(versionOf('opus'), 0)
})

test('candidates: ready tool models, the newest of each kind, no stand-in defaults', () => {
  const keys = candidates(options, providers).map((c) => c.option.key)
  assert.ok(keys.includes('claude-agent:opus'))
  assert.ok(keys.includes('claude-agent:haiku'))
  assert.ok(!keys.includes('claude-agent:default'))
  assert.ok(!keys.includes('claude-agent:claude-opus-4-8'), 'Opus 5.5 is there')
  assert.ok(!keys.includes('claude-agent:claude-haiku-4-5-20251001'))
  assert.ok(!keys.includes('claude-agent:claude-sonnet-5'))
  assert.ok(!keys.includes('engine:codex:gpt-5.6-sol'), 'GPT-6.1 Sol is there')
  assert.ok(keys.includes('engine:codex:gpt-6.1-sol'))
  // A signed-out Codex offers nothing.
  const out = engineOptions('codex', codexModels, { ...codexStatus, auth: { state: 'signed-out', method: null, plan: null } })
  assert.equal(candidates(out, []).length, 0)
  // Nor does a model that can't use tools: Chat's agent needs them.
  assert.equal(candidates(nativeOptions([provider('x', [m('x', 'text-only', 'Text only', { tools: false })])]), []).length, 0)
})

test('pick: the task decides the size of model, the user’s account breaks ties', () => {
  const prefer = ['claude-agent:opus']
  const pick = (kind: Task['kind'], vision = false) => pickModel({ task: task(kind, vision), options, providers, prefer })!
  assert.equal(pick('quick').option.key, 'claude-agent:haiku')
  assert.equal(pick('quick').effort, 'light')
  assert.equal(pick('code').option.key, 'claude-agent:sonnet')
  assert.equal(pick('code').effort, 'medium')
  assert.equal(pick('write').option.key, 'claude-agent:sonnet')
  // The heaviest model stays for whoever picks it; Opus gets the hard problems.
  assert.equal(pick('hard').option.key, 'claude-agent:opus')
  assert.equal(pick('hard').effort, 'high')
  assert.match(pick('hard').reason, /hard problem, high effort/)
  // On Codex, the same sizes from its own list.
  const codex = (kind: Task['kind']) => pickModel({ task: task(kind), options, providers, prefer: ['engine:codex:gpt-6.1-terra'] })!.option.key
  assert.equal(codex('quick'), 'engine:codex:gpt-6-luna')
  assert.equal(codex('code'), 'engine:codex:gpt-6.1-terra')
  assert.equal(codex('hard'), 'engine:codex:gpt-6-astra')
  // Without a choice of account, a plan beats a key.
  assert.equal(pickModel({ task: task('quick'), options, providers })!.option.key.split(':')[0] !== 'openrouter', true)
  // On Claude, a quick question stays on Claude even with Codex signed in; on a key-only account
  // with nothing big enough, a hard problem goes where there is something.
  assert.equal(pickModel({ task: task('quick'), options, providers, prefer: ['claude-agent:sonnet'] })!.option.key, 'claude-agent:haiku')
  assert.equal(pickModel({ task: task('hard'), options, providers, prefer: ['eaon-gateway:gpt-6-luna-free'] })!.option.key, 'engine:codex:gpt-6-astra')
  // A starred heavy model is the user's call.
  assert.equal(pickModel({ task: task('hard'), options, providers, prefer: ['claude-agent:claude-fable-5-2'] })!.option.key, 'claude-agent:claude-fable-5-2')
})

test('pick: a plan before a key, a key before free or local, and nothing unusable', () => {
  // With no plan account, a paid key's model rather than a free or local one for real work.
  const keyed = [openrouter, gateway, ollama]
  const opts = nativeOptions(keyed)
  assert.equal(pickModel({ task: task('code'), options: opts, providers: keyed })!.option.key, 'openrouter:google/gemini-4-hydrogen')
  // Only a local model: it still answers.
  assert.equal(pickModel({ task: task('hard'), options: nativeOptions([ollama]), providers: [ollama] })!.option.key, 'ollama:qwen3:8b')
  // Images need a model that sees.
  const blind = provider('claude-agent', [m('claude-agent', 'haiku', 'Haiku 5.5', { vision: false }), m('claude-agent', 'sonnet', 'Sonnet 5.5')], { category: 'subscription' })
  assert.equal(pickModel({ task: task('quick', true), options: nativeOptions([blind]), providers: [blind] })!.option.key, 'claude-agent:sonnet')
  assert.equal(pickModel({ task: task('quick'), options: [], providers: [] }), null)
})

test('pick: a chat the agent has worked in moves up, never down', () => {
  const hard = pickModel({ task: task('hard'), options, providers, prefer: ['claude-agent:opus'] })!
  const stay = routeRecord(hard)
  assert.equal(stay.tier, 3)
  // A quick follow-up stays on Opus, at the follow-up's own effort.
  const next = pickModel({ task: task('quick'), options, providers, stay })!
  assert.equal(next.option.key, 'claude-agent:opus')
  assert.equal(next.effort, 'light')
  // Started on Haiku, a coding task moves it up.
  const quick = routeRecord(pickModel({ task: task('quick'), options, providers, prefer: ['claude-agent:opus'] })!)
  assert.equal(pickModel({ task: task('code'), options, providers, stay: quick, prefer: ['claude-agent:opus'] })!.option.key, 'claude-agent:sonnet')
  // The model it was on is gone (signed out): picked afresh.
  assert.equal(pickModel({ task: task('quick'), options, providers, stay: { ...stay, key: 'claude-agent:gone' }, prefer: ['claude-agent:opus'] })!.option.key, 'claude-agent:haiku')
})
