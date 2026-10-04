import type { ProviderUrlField } from '@shared/providers'
import { customProviderId } from '@shared/providers'
import type { Provider } from '@shared/types'
import { getProvider, listProviders, removeProvider, testProvider, updateProvider } from '@main/providers'
import { providerMeta } from '@main/providers/catalog'
import { secrets } from '@main/secrets'
import { events } from '../runtime/ipc'

/**
 * Every provider the CLI can take an API key for: the app's built-in ones
 * (`src/main/providers/catalog.ts`) plus a directory of more OpenAI-compatible
 * hosts, kept here so the desktop app's catalog stays as it is.
 *
 * A directory provider only becomes a real provider when its key is added:
 * it is created as a custom provider with its name, base URL and wire format
 * (`updateProvider`), so the agent loop, the model picker and `/models`
 * listing treat it like any other. Removing its key removes it again.
 *
 * Each directory host was checked without a key (Oct 4, 2026): its
 * `/chat/completions` answers with an authentication error and `/models`
 * with a list or an authentication error. Hosts that were gone, had shut
 * their service or had no model listing were left out (Lambda, kluster.ai,
 * Targon, Arcee, Crusoe, 01.AI, Featherless, SenseNova, GitHub Models).
 */

export type ProviderGroup = 'frontier' | 'subscription' | 'gateway' | 'inference' | 'regional' | 'custom'

export const GROUPS: { id: ProviderGroup; label: string }[] = [
  { id: 'frontier', label: 'Model makers' },
  { id: 'subscription', label: 'Coding plans and sign-ins' },
  { id: 'gateway', label: 'Gateways and routers' },
  { id: 'inference', label: 'Inference hosts' },
  { id: 'regional', label: 'China and regional' },
  { id: 'custom', label: 'Your own' }
]

export interface DirectoryEntry {
  id: string
  name: string
  group: ProviderGroup
  baseUrl: string
  description: string
  keyUrl?: string
  kind?: Provider['kind']
}

const e = (id: string, name: string, group: ProviderGroup, baseUrl: string, description: string, keyUrl?: string): DirectoryEntry => ({
  id,
  name,
  group,
  baseUrl,
  description,
  ...(keyUrl ? { keyUrl } : {})
})

export const DIRECTORY: DirectoryEntry[] = [
  // Model makers.
  e('ai21', 'AI21 Labs', 'frontier', 'https://api.ai21.com/studio/v1', 'Jamba models, with very long context.', 'https://studio.ai21.com/account/api-key'),
  e('inception', 'Inception', 'frontier', 'https://api.inceptionlabs.ai/v1', 'Mercury, diffusion language models that write code and chat very fast.', 'https://platform.inceptionlabs.ai/dashboard/api-keys'),
  e('meta-llama', 'Meta Llama API', 'frontier', 'https://api.llama.com/compat/v1', 'Meta’s own API for Llama models.', 'https://llama.developer.meta.com/'),
  e('upstage', 'Upstage', 'frontier', 'https://api.upstage.ai/v1', 'Solar models.', 'https://console.upstage.ai/api-keys'),
  e('reka', 'Reka', 'frontier', 'https://api.reka.ai/v1', 'Reka Flash and Core, multimodal models.', 'https://platform.reka.ai/apikeys'),
  e('stepfun', 'StepFun', 'frontier', 'https://api.stepfun.ai/v1', 'Step models, international platform.', 'https://platform.stepfun.ai/interface-key'),
  e('byteplus', 'BytePlus ModelArk', 'frontier', 'https://ark.ap-southeast.bytepluses.com/api/v3', 'ByteDance’s Seed and Doubao models, international platform.', 'https://console.byteplus.com/ark'),
  e('nous', 'Nous Research', 'frontier', 'https://inference-api.nousresearch.com/v1', 'Hermes models, and open models from other labs.', 'https://portal.nousresearch.com/'),
  // Gateways and routers: one key, many providers' models.
  e('requesty', 'Requesty', 'gateway', 'https://router.requesty.ai/v1', 'A router across hundreds of models from many providers, with one key.', 'https://app.requesty.ai/api-keys'),
  e('aimlapi', 'AI/ML API', 'gateway', 'https://api.aimlapi.com/v1', 'Hundreds of models behind one key, paid as you go.', 'https://aimlapi.com/app/keys'),
  e('helicone', 'Helicone AI Gateway', 'gateway', 'https://ai-gateway.helicone.ai/v1', 'A gateway with request logs and analytics; one key for many providers.', 'https://us.helicone.ai/settings/api-keys'),
  e('martian', 'Martian', 'gateway', 'https://api.withmartian.com/v1', 'A model router across many providers.', 'https://app.withmartian.com/'),
  e('llmgateway', 'LLM Gateway', 'gateway', 'https://api.llmgateway.io/v1', 'An open-source router; one key for many providers.', 'https://llmgateway.io/dashboard'),
  e('zenmux', 'ZenMux', 'gateway', 'https://zenmux.ai/api/v1', 'A router for frontier models from many labs.', 'https://zenmux.ai/settings/keys'),
  e('302ai', '302.AI', 'gateway', 'https://api.302.ai/v1', 'Pay-as-you-go access to models from many labs.', 'https://dash.302.ai/apis/list'),
  // Inference hosts: open models served for you.
  e('ollama-cloud', 'Ollama Cloud', 'inference', 'https://ollama.com/v1', 'Large open models run by Ollama in the cloud.', 'https://ollama.com/settings/keys'),
  e('siliconflow', 'SiliconFlow', 'inference', 'https://api.siliconflow.com/v1', 'Open models: DeepSeek, Qwen, GLM, Kimi and more.', 'https://cloud.siliconflow.com/account/ak'),
  e('venice', 'Venice AI', 'inference', 'https://api.venice.ai/api/v1', 'Private inference for open models; prompts aren’t stored.', 'https://venice.ai/settings/api'),
  e('chutes', 'Chutes', 'inference', 'https://llm.chutes.ai/v1', 'Decentralised serverless inference for open models.', 'https://chutes.ai/app/api'),
  e('friendli', 'FriendliAI', 'inference', 'https://api.friendli.ai/serverless/v1', 'Fast serverless endpoints for open models.', 'https://friendli.ai/suite/setting/tokens'),
  e('inference-net', 'Inference.net', 'inference', 'https://api.inference.net/v1', 'Low-cost inference for open models.', 'https://inference.net/dashboard/api-keys'),
  e('parasail', 'Parasail', 'inference', 'https://api.parasail.io/v1', 'Open models on demand.', 'https://www.saas.parasail.io/keys'),
  e('gmi', 'GMI Cloud', 'inference', 'https://api.gmi-serving.com/v1', 'Serverless inference on a GPU cloud.', 'https://console.gmicloud.ai/'),
  e('avian', 'Avian', 'inference', 'https://api.avian.io/v1', 'Fast inference for open models.', 'https://avian.io/'),
  e('wandb', 'W&B Inference', 'inference', 'https://api.inference.wandb.ai/v1', 'Weights & Biases’ hosted open models.', 'https://wandb.ai/authorize'),
  e('synthetic', 'Synthetic', 'inference', 'https://api.synthetic.new/v1', 'Private open-model inference, by subscription or per use.', 'https://synthetic.new/'),
  e('io-net', 'io.net', 'inference', 'https://api.intelligence.io.solutions/api/v1', 'Inference on a decentralised GPU network.', 'https://ai.io.net/ai/api-keys'),
  e('infermatic', 'Infermatic', 'inference', 'https://api.totalgpt.ai/v1', 'Flat-rate inference for open models.', 'https://infermatic.ai/'),
  e('cloudrift', 'CloudRift', 'inference', 'https://inference.cloudrift.ai/v1', 'Low-cost inference for open models.', 'https://www.cloudrift.ai/'),
  e('vultr', 'Vultr Inference', 'inference', 'https://api.vultrinference.com/v1', 'Serverless inference on Vultr.', 'https://my.vultr.com/'),
  e('digitalocean', 'DigitalOcean Gradient', 'inference', 'https://inference.do-ai.run/v1', 'Serverless inference on DigitalOcean.', 'https://cloud.digitalocean.com/gen-ai'),
  e('scaleway', 'Scaleway', 'inference', 'https://api.scaleway.ai/v1', 'Generative APIs hosted in Europe (France).', 'https://console.scaleway.com/iam/api-keys'),
  e('ovhcloud', 'OVHcloud AI Endpoints', 'inference', 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', 'Open models hosted in Europe (France).', 'https://endpoints.ai.cloud.ovh.net/'),
  e('ionos', 'IONOS AI Model Hub', 'inference', 'https://openai.inference.de-txl.ionos.com/v1', 'Open models hosted in Germany.', 'https://dcd.ionos.com/'),
  e('cortecs', 'cortecs', 'inference', 'https://api.cortecs.ai/v1', 'EU-hosted inference that keeps data in Europe.', 'https://cortecs.ai/'),
  e('nscale', 'Nscale', 'inference', 'https://inference.api.nscale.com/v1', 'Serverless inference on European GPUs.', 'https://console.nscale.com/'),
  e('berget', 'Berget AI', 'inference', 'https://api.berget.ai/v1', 'Inference hosted in Sweden.', 'https://console.berget.ai/'),
  // China and regional platforms.
  e('stepfun-cn', 'StepFun (China)', 'regional', 'https://api.stepfun.com/v1', 'Step models, mainland China platform.', 'https://platform.stepfun.com/interface-key'),
  e('baichuan', 'Baichuan', 'regional', 'https://api.baichuan-ai.com/v1', 'Baichuan models.', 'https://platform.baichuan-ai.com/console/apikey'),
  e('hunyuan', 'Tencent Hunyuan', 'regional', 'https://api.hunyuan.cloud.tencent.com/v1', 'Tencent’s Hunyuan models.', 'https://console.cloud.tencent.com/hunyuan/start'),
  e('volcengine', 'Volcano Engine Ark', 'regional', 'https://ark.cn-beijing.volces.com/api/v3', 'ByteDance’s Doubao and Seed models, mainland China platform.', 'https://console.volcengine.com/ark'),
  e('qianfan', 'Baidu Qianfan', 'regional', 'https://qianfan.baidubce.com/v2', 'Baidu’s ERNIE models and others.', 'https://console.bce.baidu.com/iam/#/iam/apikey/list'),
  e('siliconflow-cn', 'SiliconFlow (China)', 'regional', 'https://api.siliconflow.cn/v1', 'Open models, mainland China platform.', 'https://cloud.siliconflow.cn/account/ak'),
  e('modelscope', 'ModelScope', 'regional', 'https://api-inference.modelscope.cn/v1', 'Alibaba’s model community, with free daily inference.', 'https://modelscope.cn/my/myaccesstoken'),
  e('ppio', 'PPIO', 'regional', 'https://api.ppinfra.com/v3/openai', 'Open models on a distributed cloud.', 'https://ppio.com/settings/key-management'),
  e('moark', 'MoArk', 'regional', 'https://moark.com/v1', 'Gitee’s model platform.', 'https://moark.com/'),
  e('infini', 'Infinigence AI', 'regional', 'https://cloud.infini-ai.com/maas/v1', 'Open models on Infinigence’s cloud.', 'https://cloud.infini-ai.com/iam/secret/key'),
  e('sarvam', 'Sarvam AI', 'regional', 'https://api.sarvam.ai/v1', 'Models for Indian languages.', 'https://dashboard.sarvam.ai/')
]

/** One line of the API keys screen: a provider, set up or not. */
export interface KeyRow {
  id: string
  name: string
  group: ProviderGroup
  description: string
  baseUrl: string
  keyUrl?: string
  kind: Provider['kind']
  auth: 'key' | 'oauth'
  /** A key is saved, or it is signed in. */
  ready: boolean
  enabled: boolean
  models: number
  /** From the directory, and not created yet (no key so far). */
  extra: boolean
  /** Values a templated base URL needs (Cloudflare's account id, a Bedrock region). */
  fields: ProviderUrlField[]
  template?: string
  /** For a provider whose base URL is the user's own (an Azure resource). */
  baseUrlLabel?: string
  baseUrlPlaceholder?: string
}

const directoryById = new Map(DIRECTORY.map((entry) => [entry.id, entry]))

const groupOf = (provider: Provider): ProviderGroup => {
  const entry = directoryById.get(provider.id)
  if (entry) return entry.group
  const category = provider.category ?? 'custom'
  return category === 'local' ? 'custom' : category
}

/** Every provider that takes a key or a sign-in, then the directory's not yet added; local runtimes need neither. */
export function keyRows(): KeyRow[] {
  const providers = listProviders().filter((p) => !p.local)
  const rows: KeyRow[] = providers.map((p) => {
    const meta = providerMeta(p.id)
    const entry = directoryById.get(p.id)
    return {
      id: p.id,
      name: p.name,
      group: groupOf(p),
      description: p.description ?? entry?.description ?? (p.builtIn ? '' : 'Your own endpoint.'),
      baseUrl: p.baseUrl,
      ...((p.keyUrl ?? entry?.keyUrl) ? { keyUrl: p.keyUrl ?? entry?.keyUrl } : {}),
      kind: p.kind,
      auth: p.auth === 'oauth' ? 'oauth' : 'key',
      ready: p.auth === 'oauth' ? Boolean(p.signedIn) : p.hasKey,
      enabled: p.enabled,
      models: p.models.length,
      extra: false,
      fields: meta.fields ?? [],
      ...(meta.baseUrlTemplate ? { template: meta.baseUrlTemplate } : {}),
      ...(meta.baseUrlLabel ? { baseUrlLabel: meta.baseUrlLabel } : {}),
      ...(meta.baseUrlPlaceholder ? { baseUrlPlaceholder: meta.baseUrlPlaceholder } : {})
    }
  })
  const have = new Set(rows.map((r) => r.id))
  for (const entry of DIRECTORY) {
    if (have.has(entry.id)) continue
    rows.push({
      id: entry.id,
      name: entry.name,
      group: entry.group,
      description: entry.description,
      baseUrl: entry.baseUrl,
      ...(entry.keyUrl ? { keyUrl: entry.keyUrl } : {}),
      kind: entry.kind ?? 'openai-compatible',
      auth: 'key',
      ready: false,
      enabled: true,
      models: 0,
      extra: true,
      fields: []
    })
  }
  const order = new Map(GROUPS.map((g, i) => [g.id, i]))
  const rank = (r: KeyRow): number => (POPULAR.includes(r.id) ? POPULAR.indexOf(r.id) : POPULAR.length)
  return rows.sort((a, b) => order.get(a.group)! - order.get(b.group)! || rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** The providers most people want, first in their groups; the rest follow alphabetically. */
const POPULAR = ['anthropic', 'openai', 'gemini', 'xai', 'deepseek', 'mistral', 'chatgpt', 'github-copilot', 'openrouter', 'vercel', 'groq', 'cerebras', 'together', 'fireworks']

/** A provider by id or name (any case), for `/key openai` and `eaon keys add groq`. */
export function findKeyRow(query: string, rows = keyRows()): KeyRow | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return undefined
  return rows.find((r) => r.id === q) ?? rows.find((r) => r.name.toLowerCase() === q) ?? rows.find((r) => r.name.toLowerCase().startsWith(q))
}

/** Fills `{placeholders}` in a base-URL template; empty when one is missing. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  let missing = false
  const url = template.replace(/\{([a-z_]+)\}/g, (_, key: string) => {
    const value = values[key]?.trim()
    if (!value) missing = true
    return value ?? ''
  })
  return missing ? '' : url
}

/** The values a provider's templated base URL was filled with, read back from its current URL. */
export function templateValues(row: KeyRow): Record<string, string> {
  const values: Record<string, string> = Object.fromEntries(row.fields.filter((f) => f.defaultValue).map((f) => [f.key, f.defaultValue!]))
  if (!row.template) return values
  const keys: string[] = []
  const pattern = new RegExp(
    `^${row.template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{([a-z_]+)\\?\}/g, (_, key: string) => {
      keys.push(key)
      return '([^/]+)'
    })}$`
  )
  // A URL still showing its placeholders hasn't been filled in yet.
  const match = /\{[a-z_]+\}/.test(row.baseUrl) ? null : pattern.exec(row.baseUrl)
  if (match) keys.forEach((key, i) => (values[key] = match[i + 1]))
  return values
}

export interface SaveResult {
  ok: boolean
  message: string
  models: number
}

/**
 * Saves a key (and the base-URL values it needs), creating a directory
 * provider first, turning the provider on, then checking it by listing
 * its models. The key stays saved even when the check fails, so a provider
 * that's down for a moment doesn't lose it.
 */
export async function saveProviderKey(row: KeyRow, key: string, values: Record<string, string> = {}): Promise<SaveResult> {
  const trimmed = key.trim()
  let baseUrl: string | undefined
  if (row.template) {
    baseUrl = fillTemplate(row.template, values)
    if (!baseUrl) throw new Error(`Fill in ${row.fields.map((f) => f.label).join(' and ')}.`)
  } else if (row.baseUrlLabel || row.group === 'custom') {
    if (values.baseUrl?.trim()) baseUrl = values.baseUrl.trim()
    else if (!row.baseUrl) throw new Error(`Fill in ${row.baseUrlLabel ?? 'the base URL'}.`)
  }
  if (row.extra) updateProvider(row.id, { name: row.name, kind: row.kind, baseUrl: baseUrl ?? row.baseUrl })
  else if (baseUrl !== undefined) updateProvider(row.id, { baseUrl })
  // A switched-off provider would keep hiding its models even with a key.
  updateProvider(row.id, { enabled: true })
  if (trimmed) secrets.set(row.id, trimmed)
  events.emit('providers:changed')
  if (!secrets.has(row.id)) return { ok: false, message: 'Saved without a key.', models: getProvider(row.id)?.models.length ?? 0 }
  const result = await testProvider(row.id)
  events.emit('providers:changed')
  return { ...result, message: readableError(result.message), models: getProvider(row.id)?.models.length ?? 0 }
}

/** Checks a saved key by listing the provider's models. */
export async function checkProviderKey(id: string): Promise<SaveResult> {
  const result = await testProvider(id)
  events.emit('providers:changed')
  return { ...result, message: readableError(result.message), models: getProvider(id)?.models.length ?? 0 }
}

/**
 * A provider's error as a person would say it: `401 {"error":{"message":"Invalid API Key"}}`
 * becomes `401 — Invalid API Key`. Providers word their bodies differently.
 */
export function readableError(message: string): string {
  const m = /^(\d{3}) (\{[\s\S]*\})\s*$/.exec(message.trim())
  if (!m) return message
  try {
    const body = JSON.parse(m[2]) as Record<string, unknown>
    const pick = (v: unknown): string | undefined => {
      if (typeof v === 'string' && v.trim()) return v.trim()
      if (Array.isArray(v)) return pick(v[0])
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        return pick(o.message) ?? pick(o.msg) ?? pick(o.detail) ?? pick(o.description) ?? pick(o.error) ?? pick(o.errors)
      }
      return undefined
    }
    const text = pick(body)
    return text ? `${m[1]} — ${text}` : message
  } catch {
    return message
  }
}

/** Forgets a key. A directory or custom provider goes with it, since it was only there for the key. */
export function removeProviderKey(row: KeyRow): void {
  const provider = getProvider(row.id)
  if (provider && !provider.builtIn) removeProvider(row.id)
  else secrets.clear(row.id)
  events.emit('providers:changed')
}

export interface CustomProvider {
  name: string
  baseUrl: string
  kind: Provider['kind']
  key?: string
}

/** Adds an endpoint of the user's own (a LiteLLM proxy, a company gateway, any OpenAI- or Anthropic-compatible API). */
export async function addCustomProvider(custom: CustomProvider): Promise<SaveResult & { id: string }> {
  const name = custom.name.trim()
  const baseUrl = custom.baseUrl.trim()
  if (!name) throw new Error('Give it a name.')
  if (!/^https?:\/\/\S+$/.test(baseUrl)) throw new Error('The base URL starts with http:// or https://, e.g. https://example.com/v1.')
  const taken = [...listProviders().map((p) => p.id), ...DIRECTORY.map((d) => d.id)]
  const id = customProviderId(name, taken)
  if (!id) throw new Error('Give it a name with letters or numbers.')
  updateProvider(id, { name, kind: custom.kind, baseUrl, enabled: true })
  if (custom.key?.trim()) secrets.set(id, custom.key.trim())
  events.emit('providers:changed')
  const result = await testProvider(id)
  events.emit('providers:changed')
  return { id, ...result, message: readableError(result.message), models: getProvider(id)?.models.length ?? 0 }
}
