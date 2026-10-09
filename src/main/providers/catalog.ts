import type { ModelInfo, Provider } from '@shared/types'
import type { ProviderMeta } from '@shared/providers'
import generated from './catalog.generated.json'
import type { CatalogModel } from './catalogSources'
import { OPENAI_EFFORTS } from './models'

/**
 * Every provider the app ships knowing about. Users can disable any of them
 * and add their own OpenAI-compatible endpoints on top (see `index.ts`).
 *
 * Base URLs and auth follow Eaon Code's provider package; hosts it does not
 * cover were checked by hand. Model lists are not typed in here: they come
 * from `catalog.generated.json` (Pi's provider data and models.dev, see
 * `scripts/generate-models.mjs`), are topped up from models.dev at runtime
 * (`modelCatalog.ts`), and merged with the provider's own `/models` once a key
 * is added. The few hand lists left below are for hosts neither source knows.
 * Catalog entries carry what `/models` endpoints rarely report — context
 * window, output cap, which effort levels the endpoint takes. `efforts: []`
 * means the endpoint does not take a reasoning effort for that model, so the
 * picker is hidden rather than offering a setting the request would ignore.
 */

export type SeedProvider = Omit<Provider, 'hasKey' | 'local' | 'fallbackCount' | 'signedIn'> & { local?: boolean }

const m = (providerId: string, id: string, label: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  label,
  providerId,
  tools: true,
  ...extra
})

/** A local runtime: no key, a port on this machine, models discovered from the server. */
const local = (id: string, name: string, baseUrl: string, description: string): SeedProvider => ({
  id,
  name,
  kind: 'openai-compatible',
  baseUrl,
  enabled: true,
  builtIn: true,
  local: true,
  auth: 'none',
  category: 'local',
  description,
  models: []
})

/** An OpenAI-compatible host authenticated with a pasted key. */
const hosted = (
  id: string,
  name: string,
  category: NonNullable<Provider['category']>,
  baseUrl: string,
  description: string,
  keyUrl: string | undefined,
  models: ModelInfo[] = [],
  extra: Partial<SeedProvider> = {}
): SeedProvider => ({
  id,
  name,
  kind: 'openai-compatible',
  baseUrl,
  enabled: true,
  builtIn: true,
  auth: 'key',
  category,
  description,
  ...(keyUrl ? { keyUrl } : {}),
  models,
  ...extra
})

/** GitHub Copilot answers only requests that identify as a supported editor. */
const COPILOT_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat'
}

const PROVIDERS: SeedProvider[] = [
  // ---- Subscriptions: sign in with an existing plan, or a coding-plan key ----
  {
    // OpenAI's official "Sign in with ChatGPT" for open-source and local apps
    // (oauth/siwc.ts). The plain Responses API on api.openai.com, drawing on
    // the person's ChatGPT plan; the model list comes from /v1/models once
    // signed in, these are only the seed.
    id: 'chatgpt',
    name: 'ChatGPT',
    kind: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    builtIn: true,
    auth: 'oauth',
    oauthFlow: 'openai-siwc',
    category: 'subscription',
    description: 'Use your ChatGPT plan — official Sign in with ChatGPT',
    models: []
  },
  {
    id: 'openai-codex',
    name: 'ChatGPT (Codex)',
    kind: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    enabled: true,
    builtIn: true,
    auth: 'oauth',
    oauthFlow: 'openai-codex',
    category: 'subscription',
    description: 'Your ChatGPT plan through the Codex CLI sign-in',
    models: []
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    kind: 'openai-compatible',
    baseUrl: 'https://api.individual.githubcopilot.com',
    enabled: true,
    builtIn: true,
    auth: 'oauth',
    oauthFlow: 'github-copilot',
    category: 'subscription',
    description: 'Claude, GPT and Gemini through your Copilot plan',
    headers: COPILOT_HEADERS,
    models: []
  },
  {
    id: 'kimi-coding',
    name: 'Kimi For Coding',
    kind: 'anthropic',
    baseUrl: 'https://api.kimi.com/coding',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'subscription',
    description: "Moonshot's Kimi coding plan",
    keyUrl: 'https://www.kimi.com/code',
    models: []
  },
  hosted('zai-coding', 'GLM Coding Plan', 'subscription', 'https://api.z.ai/api/coding/paas/v4', "Z.ai's GLM coding subscription", 'https://z.ai/manage-apikey/apikey-list', []),
  hosted(
    'qwen-token-plan',
    'Qwen Token Plan',
    'subscription',
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    "Alibaba Cloud's coding plan: Qwen, DeepSeek, GLM and Kimi",
    'https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key',
    []
  ),
  hosted('xiaomi-token-plan', 'MiMo Token Plan', 'subscription', 'https://token-plan-sgp.xiaomimimo.com/v1', "Xiaomi's MiMo subscription (Singapore or Amsterdam)", 'https://platform.xiaomimimo.com', []),
  hosted('opencode-go', 'OpenCode Go', 'subscription', 'https://opencode.ai/zen/go/v1', 'Flat-rate open models from OpenCode', 'https://opencode.ai/auth', []),

  // ---- Local runtimes: no key required, endpoint points at a port on this machine ----
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    enabled: true,
    builtIn: true,
    local: true,
    auth: 'none',
    category: 'local',
    description: 'Run open models on this computer',
    models: []
  },
  // Eaon's own runtime (main/llama): the models downloaded on the Models page,
  // run by the llama-server built from Eaon's llama.cpp. The base URL is a
  // placeholder — each request gets the running server's port and key.
  local('eaon-local', 'On this computer', 'http://127.0.0.1/v1', 'Models you download in Eaon, run by its built-in llama.cpp'),
  local('lm-studio', 'LM Studio', 'http://127.0.0.1:1234/v1', 'LM Studio’s local server on port 1234'),
  local('llama-cpp', 'Llama.cpp', 'http://127.0.0.1:8080/v1', 'llama-server on port 8080'),
  local('mlx', 'MLX', 'http://127.0.0.1:8080/v1', 'mlx_lm.server on Apple silicon'),
  local('vllm', 'vLLM', 'http://127.0.0.1:8000/v1', 'vllm serve on port 8000'),
  local('jan', 'Jan', 'http://127.0.0.1:1337/v1', 'Jan’s local API server on port 1337'),

  // ---- Frontier labs ----
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'frontier',
    description: 'Claude',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: []
  },
  {
    id: 'openai',
    name: 'OpenAI',
    // Responses rather than chat-completions: reasoning survives tool calls
    // (encrypted reasoning items), and the Codex-tuned models exist only here.
    kind: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'frontier',
    description: 'GPT and the o-series',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: []
  },
  hosted('gemini', 'Gemini', 'frontier', 'https://generativelanguage.googleapis.com/v1beta/openai', 'Google AI Studio', 'https://aistudio.google.com/app/apikey', []),
  {
    id: 'xai',
    name: 'xAI',
    kind: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'frontier',
    description: 'Grok',
    keyUrl: 'https://console.x.ai',
    models: []
  },
  hosted('mistral', 'Mistral', 'frontier', 'https://api.mistral.ai/v1', 'Mistral, Magistral, Devstral and Codestral', 'https://console.mistral.ai/api-keys', []),
  hosted('deepseek', 'DeepSeek', 'frontier', 'https://api.deepseek.com', 'DeepSeek V4, direct from the lab', 'https://platform.deepseek.com/api_keys', []),
  hosted('moonshot', 'Kimi', 'frontier', 'https://api.moonshot.ai/v1', "Moonshot AI's Kimi models", 'https://platform.moonshot.ai/console/api-keys', []),
  hosted('zai', 'Z.ai', 'frontier', 'https://api.z.ai/api/paas/v4', 'GLM models, pay as you go', 'https://z.ai/manage-apikey/apikey-list', []),
  hosted(
    'qwen',
    'Qwen',
    'frontier',
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'Alibaba Cloud Model Studio (international)',
    'https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key',
    []
  ),
  {
    id: 'minimax',
    name: 'MiniMax',
    // MiniMax's Anthropic-compatible API returns thinking as proper thinking
    // blocks; its OpenAI endpoint inlines <think> tags into the answer.
    kind: 'anthropic',
    baseUrl: 'https://api.minimax.io/anthropic',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'frontier',
    description: 'MiniMax M3 and M2.7 (international)',
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    models: []
  },
  hosted('xiaomi', 'Xiaomi MiMo', 'frontier', 'https://api.xiaomimimo.com/v1', 'MiMo V2.5, pay as you go', 'https://platform.xiaomimimo.com', []),
  hosted('cohere', 'Cohere', 'frontier', 'https://api.cohere.ai/compatibility/v1', 'Command A, through the OpenAI-compatible API', 'https://dashboard.cohere.com/api-keys', []),
  hosted('perplexity', 'Perplexity', 'frontier', 'https://api.perplexity.ai', 'Sonar: answers grounded in live web search', 'https://www.perplexity.ai/settings/api', []),

  // ---- Gateways: many labs behind one key ----
  hosted('openrouter', 'OpenRouter', 'gateway', 'https://openrouter.ai/api/v1', 'Hundreds of models behind one key', 'https://openrouter.ai/keys', [], {
    headers: { 'HTTP-Referer': 'https://eaon.dev', 'X-Title': 'Eaon' }
  }),
  hosted('poe', 'Poe', 'gateway', 'https://api.poe.com/v1', 'Chat and agent models billed from your Poe points', 'https://poe.com/api_key', []),
  hosted('vercel', 'Vercel AI Gateway', 'gateway', 'https://ai-gateway.vercel.sh/v1', 'Every major lab through Vercel, with fallbacks', 'https://vercel.com/docs/ai-gateway/authentication', []),
  hosted(
    'cloudflare-ai-gateway',
    'Cloudflare AI Gateway',
    'gateway',
    'https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat',
    'Workers AI, plus labs you add keys for in the gateway',
    'https://dash.cloudflare.com/profile/api-tokens',
    []
  ),
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    kind: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/v1',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'gateway',
    description: 'Coding models curated and tested by OpenCode',
    keyUrl: 'https://opencode.ai/auth',
    models: []
  },
  hosted('huggingface', 'Hugging Face', 'gateway', 'https://router.huggingface.co/v1', 'Open models routed across inference partners', 'https://huggingface.co/settings/tokens', []),
  hosted('azure', 'Azure OpenAI', 'gateway', '', 'Azure OpenAI and AI Foundry deployments', 'https://ai.azure.com', []),
  hosted(
    'amazon-bedrock',
    'Amazon Bedrock',
    'gateway',
    'https://bedrock-mantle.us-east-1.api.aws/v1',
    'Open models on AWS, with a Bedrock API key',
    'https://console.aws.amazon.com/bedrock/home#/api-keys',
    [
      m('amazon-bedrock', 'openai.gpt-oss-120b', 'GPT OSS 120B', { efforts: OPENAI_EFFORTS, contextWindow: 128_000, maxOutput: 16_384, reasoning: true }),
      m('amazon-bedrock', 'openai.gpt-oss-20b', 'GPT OSS 20B', { efforts: OPENAI_EFFORTS, contextWindow: 128_000, maxOutput: 16_384, reasoning: true })
    ]
  ),

  // ---- Fast inference hosts for open models ----
  hosted('groq', 'Groq', 'inference', 'https://api.groq.com/openai/v1', 'Very fast open models on LPUs', 'https://console.groq.com/keys', []),
  hosted('cerebras', 'Cerebras', 'inference', 'https://api.cerebras.ai/v1', 'Wafer-scale inference, thousands of tokens a second', 'https://cloud.cerebras.ai', []),
  hosted('fireworks', 'Fireworks', 'inference', 'https://api.fireworks.ai/inference/v1', 'Fast serverless open models', 'https://fireworks.ai/account/api-keys', []),
  hosted('together', 'Together AI', 'inference', 'https://api.together.ai/v1', 'Open models, serverless or dedicated', 'https://api.together.ai/settings/api-keys', []),
  hosted('baseten', 'Baseten', 'inference', 'https://inference.baseten.co/v1', 'Model APIs on dedicated-grade infrastructure', 'https://app.baseten.co/settings/api_keys', []),
  hosted('deepinfra', 'DeepInfra', 'inference', 'https://api.deepinfra.com/v1/openai', 'Low-cost serverless open models', 'https://deepinfra.com/dash/api_keys', []),
  hosted('novita', 'Novita AI', 'inference', 'https://api.novita.ai/openai/v1', 'Serverless open models', 'https://novita.ai/settings/key-management', []),
  hosted('sambanova', 'SambaNova', 'inference', 'https://api.sambanova.ai/v1', 'Fast open models on RDUs', 'https://cloud.sambanova.ai/apis', [
    m('sambanova', 'MiniMax-M3', 'MiniMax-M3', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true }),
    m('sambanova', 'DeepSeek-V3.1', 'DeepSeek V3.1', { efforts: [], contextWindow: 131_072, maxOutput: 7168, reasoning: true }),
    m('sambanova', 'gpt-oss-120b', 'GPT OSS 120B', { efforts: OPENAI_EFFORTS, contextWindow: 131_072, maxOutput: 32_768, reasoning: true }),
    m('sambanova', 'Meta-Llama-3.3-70B-Instruct', 'Llama 3.3 70B', { efforts: [], contextWindow: 131_072, maxOutput: 3072, reasoning: false })
  ]),
  hosted('nebius', 'Nebius Token Factory', 'inference', 'https://api.tokenfactory.nebius.com/v1', 'Open models on Nebius (formerly AI Studio)', 'https://studio.nebius.com/settings/api-keys', []),
  hosted('nvidia-nim', 'NVIDIA NIM', 'inference', 'https://integrate.api.nvidia.com/v1', 'NVIDIA-hosted open models, free to try', 'https://build.nvidia.com', []),
  hosted(
    'cloudflare-workers-ai',
    'Cloudflare Workers AI',
    'inference',
    'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    'Open models on Cloudflare’s network',
    'https://dash.cloudflare.com/profile/api-tokens',
    []
  ),

  // ---- China region endpoints: separate accounts and keys from the international ones ----
  hosted('moonshot-cn', 'Kimi (China)', 'regional', 'https://api.moonshot.cn/v1', 'Moonshot AI, mainland China platform', 'https://platform.moonshot.cn/console/api-keys', []),
  hosted('zai-cn', 'BigModel', 'regional', 'https://open.bigmodel.cn/api/paas/v4', "Zhipu's GLM platform (China)", 'https://open.bigmodel.cn/usercenter/apikeys', []),
  hosted('zai-coding-cn', 'GLM Coding Plan (China)', 'regional', 'https://open.bigmodel.cn/api/coding/paas/v4', "Zhipu's GLM coding subscription (China)", 'https://open.bigmodel.cn/usercenter/apikeys', []),
  hosted('qwen-cn', 'Qwen (China)', 'regional', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'Alibaba Cloud Bailian (China)', 'https://bailian.console.aliyun.com/?tab=model#/api-key', []),
  hosted(
    'qwen-token-plan-cn',
    'Qwen Token Plan (China)',
    'regional',
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    "Alibaba Cloud's coding plan (China)",
    'https://bailian.console.aliyun.com/?tab=model#/api-key',
    []
  ),
  {
    id: 'minimax-cn',
    name: 'MiniMax (China)',
    kind: 'anthropic',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'regional',
    description: 'MiniMax, mainland China platform',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    models: []
  },
  hosted('xiaomi-token-plan-cn', 'MiMo Token Plan (China)', 'regional', 'https://token-plan-cn.xiaomimimo.com/v1', "Xiaomi's MiMo subscription (China)", 'https://platform.xiaomimimo.com', [])
]

const shipped = (generated as unknown as { providers: Record<string, CatalogModel[]> }).providers

/** The shipped catalog's models for a provider, or its hand list where the catalog has none. */
export const BUILT_IN: SeedProvider[] = PROVIDERS.map((provider) => {
  const models = shipped[provider.id]
  return models ? { ...provider, models: models.map(({ released: _released, ...model }) => ({ ...model, providerId: provider.id })) } : provider
})

/**
 * What the settings page needs beyond the provider itself: base-URL templates
 * with the fields to fill in, whether a listing exists, sign-in labels.
 */
export const PROVIDER_META: Record<string, ProviderMeta> = {
  'eaon-local': { id: 'eaon-local', listsModels: false },
  chatgpt: { id: 'chatgpt', listsModels: true, signInLabel: 'Sign in with ChatGPT' },
  'openai-codex': { id: 'openai-codex', listsModels: false, signInLabel: 'Sign in with ChatGPT (Codex)' },
  // Account sign-in next to the key field; both need a registered OAuth client (oauth/appClients.ts).
  huggingface: { id: 'huggingface', listsModels: true, signInLabel: 'Sign in with Hugging Face', keyFlow: 'huggingface', accountSignIn: true },
  poe: { id: 'poe', listsModels: true, signInLabel: 'Sign in with Poe', keyFlow: 'poe' },
  // No sign-in, and why — for the providers people most expect one from (checked Sept 2026).
  anthropic: {
    id: 'anthropic',
    listsModels: true,
    // Anthropic's rule for apps (Agent SDK docs, checked Oct 2026): no claude.ai login or plan rate limits
    // in third-party products without its approval — API keys instead. Max and Team plans now include
    // monthly API credits (support.claude.com/en/articles/17154008), which reach Eaon through such a key.
    noSignInReason:
      'Anthropic doesn’t allow other apps to sign in with a Claude account or to use your plan’s usage limits, so Claude in Eaon uses an API key. Your plan’s limits still work in Claude Code itself, which you can run in the ADE.',
    planInAde: 'claude',
    planCredits: {
      title: 'Use your Claude plan’s monthly API credits',
      detail:
        'Claude Max and Team plans include monthly API credits ($100 on Max 5x, $200 on Max 20x, $20 or $100 per Team seat). They pay for API keys from a Claude Console organization linked to your plan, so Claude in Eaon can use them. They reset each month and don’t roll over.',
      steps: [
        'On claude.ai, open Settings → Billing and choose Link organization.',
        'Pick or create a Claude Console organization, and accept the terms.',
        'In that organization, make an API key and paste it below.'
      ],
      links: [
        { label: 'Claude billing settings', url: 'https://claude.ai/settings/billing' },
        { label: 'Console API keys', url: 'https://console.anthropic.com/settings/keys' },
        { label: 'About the credits', url: 'https://support.claude.com/en/articles/17154008' }
      ]
    }
  },
  gemini: { id: 'gemini', listsModels: true, noSignInReason: 'Google forbids other apps from reusing the Gemini CLI or Antigravity sign-in and suspends accounts that do, so Gemini needs an API key from Google AI Studio.' },
  'kimi-coding': { id: 'kimi-coding', listsModels: true, noSignInReason: 'This provider only lets its own tools sign in with a subscription, so other apps need an API key.' },
  'zai-coding': { id: 'zai-coding', listsModels: true, noSignInReason: 'This provider only lets its own tools sign in with a subscription, so other apps need an API key.' },
  'github-copilot': { id: 'github-copilot', listsModels: true, signInLabel: 'Sign in with GitHub' },
  openrouter: { id: 'openrouter', listsModels: true, signInLabel: 'Sign in with OpenRouter', keyFlow: 'openrouter' },
  perplexity: { id: 'perplexity', listsModels: false },
  azure: {
    id: 'azure',
    listsModels: true,
    baseUrlLabel: 'Endpoint',
    baseUrlPlaceholder: 'https://your-resource.openai.azure.com'
  },
  'cloudflare-workers-ai': {
    id: 'cloudflare-workers-ai',
    listsModels: false,
    baseUrlTemplate: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    fields: [{ key: 'account_id', label: 'Account ID', placeholder: '32-character id from the dashboard sidebar' }]
  },
  'cloudflare-ai-gateway': {
    id: 'cloudflare-ai-gateway',
    listsModels: false,
    baseUrlTemplate: 'https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat',
    fields: [
      { key: 'account_id', label: 'Account ID', placeholder: '32-character id from the dashboard sidebar' },
      { key: 'gateway_id', label: 'Gateway ID', placeholder: 'The gateway’s name, under AI → AI Gateway' }
    ]
  },
  'amazon-bedrock': {
    id: 'amazon-bedrock',
    listsModels: true,
    baseUrlTemplate: 'https://bedrock-mantle.{region}.api.aws/v1',
    fields: [{ key: 'region', label: 'Region', placeholder: 'us-east-1', defaultValue: 'us-east-1' }]
  },
  'xiaomi-token-plan': {
    id: 'xiaomi-token-plan',
    listsModels: true,
    baseUrlTemplate: 'https://token-plan-{region}.xiaomimimo.com/v1',
    fields: [{ key: 'region', label: 'Region', placeholder: 'sgp or ams', defaultValue: 'sgp' }]
  }
}

/** Metadata for any provider id, with the defaults filled in. */
export function providerMeta(id: string): ProviderMeta {
  return PROVIDER_META[id] ?? { id, listsModels: true }
}

/**
 * Built-in providers whose kind or URL changed. A base URL the user never
 * edited is stored as the old default; carrying it forward would point the
 * new wire format at the old endpoint (MiniMax moved to its Anthropic API).
 */
export const LEGACY_DEFAULT_URLS: Record<string, string[]> = {
  minimax: ['https://api.minimax.io/v1']
}
