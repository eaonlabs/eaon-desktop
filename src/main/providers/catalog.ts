import type { ModelInfo, Provider } from '@shared/types'
import type { ProviderMeta } from '@shared/providers'
import { ALL_EFFORTS, OPENAI_EFFORTS } from './models'

/**
 * Every provider the app ships knowing about. Users can disable any of them
 * and add their own OpenAI-compatible endpoints on top (see `index.ts`).
 *
 * Base URLs, auth and seed models follow Eaon Code's provider package
 * (`packages/ai/src/providers/*`, generated from models.dev plus its own
 * corrections), which is kept current; hosts it does not cover were checked
 * by hand. Seed model lists are a starting point only: once a key is added the
 * list is refreshed from the provider's own `/models`, so a new release shows
 * up without an app update. Seeds exist so the picker is useful before that
 * first refresh, and they carry capabilities (context window, output cap,
 * which effort levels the endpoint takes) that `/models` endpoints rarely
 * report. `efforts: []` means the endpoint does not take a reasoning effort
 * for that model, so the picker is hidden rather than offering a setting the
 * request would ignore.
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

export const BUILT_IN: SeedProvider[] = [
  // ---- Subscriptions: sign in with an existing plan, or a coding-plan key ----
  {
    id: 'openai-codex',
    name: 'ChatGPT',
    kind: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    enabled: true,
    builtIn: true,
    auth: 'oauth',
    oauthFlow: 'openai-codex',
    category: 'subscription',
    description: 'Use your ChatGPT Plus or Pro plan (Codex)',
    models: [
      m('openai-codex', 'gpt-6-astra', 'GPT-6 Astra', { efforts: ALL_EFFORTS, contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai-codex', 'gpt-5.6-sol', 'GPT-5.6 Sol', { efforts: ALL_EFFORTS, contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai-codex', 'gpt-5.6-terra', 'GPT-5.6 Terra', { efforts: ALL_EFFORTS, contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai-codex', 'gpt-5.6-luna', 'GPT-5.6 Luna', { efforts: ALL_EFFORTS, contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai-codex', 'gpt-5.5', 'GPT-5.5', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai-codex', 'gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 128_000, maxOutput: 128_000, reasoning: true })
    ]
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
    models: [
      m('github-copilot', 'claude-sonnet-5', 'Claude Sonnet 5', { contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('github-copilot', 'claude-opus-5', 'Claude Opus 5', { contextWindow: 1_000_000, maxOutput: 64_000, vision: true, reasoning: true }),
      m('github-copilot', 'claude-fable-5.1', 'Claude Fable 5.1', { contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('github-copilot', 'claude-opus-4.8', 'Claude Opus 4.8', { contextWindow: 1_000_000, maxOutput: 64_000, vision: true, reasoning: true }),
      m('github-copilot', 'claude-sonnet-4.6', 'Claude Sonnet 4.6', { contextWindow: 1_000_000, maxOutput: 32_000, vision: true, reasoning: true }),
      m('github-copilot', 'claude-haiku-4.5', 'Claude Haiku 4.5 (latest)', { contextWindow: 200_000, maxOutput: 64_000, vision: true, reasoning: true }),
      m('github-copilot', 'gpt-6-astra', 'GPT-6 Astra', { efforts: ALL_EFFORTS, contextWindow: 1_050_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('github-copilot', 'gpt-5.6-sol', 'GPT-5.6 Sol', { efforts: ALL_EFFORTS, contextWindow: 1_050_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('github-copilot', 'gpt-5.6-terra', 'GPT-5.6 Terra', { efforts: ALL_EFFORTS, contextWindow: 1_050_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('github-copilot', 'gpt-5.6-luna', 'GPT-5.6 Luna', { efforts: ALL_EFFORTS, contextWindow: 1_050_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('github-copilot', 'gpt-5.5', 'GPT-5.5', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('github-copilot', 'gpt-5.4', 'GPT-5.4', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('github-copilot', 'gpt-5.3-codex', 'GPT-5.3 Codex', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('github-copilot', 'gpt-5-mini', 'GPT-5 Mini', { efforts: OPENAI_EFFORTS, contextWindow: 264_000, maxOutput: 64_000, vision: true, reasoning: true }),
      m('github-copilot', 'gemini-3.8-flash', 'Gemini 3.8 Flash', { efforts: [], contextWindow: 1_000_000, maxOutput: 64_000, vision: true, reasoning: true }),
      m('github-copilot', 'grok-4.6', 'Grok 4.6', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 500_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('github-copilot', 'kimi-k3', 'Kimi K3', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true }),
      m('github-copilot', 'mai-code-1.1-flash', 'MAI-Code-1.1-Flash', { efforts: OPENAI_EFFORTS, contextWindow: 256_000, maxOutput: 128_000, vision: true, reasoning: true })
    ]
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
    models: [
      m('kimi-coding', 'k3', 'Kimi K3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true }),
      m('kimi-coding', 'k3-256k', 'Kimi K3-256K', { efforts: ['light', 'high', 'ultra'], contextWindow: 262_144, maxOutput: 131_072, vision: true, reasoning: true }),
      m('kimi-coding', 'kimi-for-coding', 'Kimi K2.7 Code', { efforts: OPENAI_EFFORTS, contextWindow: 262_144, maxOutput: 32_768, vision: true, reasoning: true }),
      m('kimi-coding', 'kimi-for-coding-highspeed', 'Kimi For Coding HighSpeed', { efforts: OPENAI_EFFORTS, contextWindow: 262_144, maxOutput: 32_768, vision: true, reasoning: true })
    ]
  },
  hosted('zai-coding', 'GLM Coding Plan', 'subscription', 'https://api.z.ai/api/coding/paas/v4', "Z.ai's GLM coding subscription", 'https://z.ai/manage-apikey/apikey-list', [
    m('zai-coding', 'glm-5.3', 'GLM-5.3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('zai-coding', 'glm-5.3-highspeed', 'GLM-5.3 Highspeed', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('zai-coding', 'glm-5.3-flash', 'GLM-5.3-Flash', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
    m('zai-coding', 'glm-5.2', 'GLM-5.2', { efforts: ['high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('zai-coding', 'glm-5-turbo', 'GLM-5-Turbo', { efforts: [], contextWindow: 200_000, maxOutput: 131_072, reasoning: true }),
    m('zai-coding', 'glm-4.7', 'GLM-4.7', { efforts: [], contextWindow: 204_800, maxOutput: 131_072, reasoning: true })
  ]),
  hosted(
    'qwen-token-plan',
    'Qwen Token Plan',
    'subscription',
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    "Alibaba Cloud's coding plan: Qwen, DeepSeek, GLM and Kimi",
    'https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key',
    [
      m('qwen-token-plan', 'qwen3.8-max', 'Qwen3.8 Max', { efforts: ['light', 'medium', 'extra-high'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
      m('qwen-token-plan', 'qwen3.8-flash', 'Qwen3.8 Flash', { efforts: ['light', 'medium', 'extra-high'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
      m('qwen-token-plan', 'qwen3.7-max', 'Qwen3.7 Max', { efforts: [], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
      m('qwen-token-plan', 'qwen3.7-plus', 'Qwen3.7 Plus', { efforts: [], contextWindow: 1_000_000, maxOutput: 65_536, vision: true, reasoning: true }),
      m('qwen-token-plan', 'qwen3.6-plus', 'Qwen3.6 Plus', { efforts: [], contextWindow: 1_000_000, maxOutput: 65_536, vision: true, reasoning: true }),
      m('qwen-token-plan', 'deepseek-v4-pro', 'DeepSeek V4 Pro', { efforts: ['high', 'ultra'], contextWindow: 1_000_000, maxOutput: 384_000, reasoning: true }),
      m('qwen-token-plan', 'glm-5.2', 'GLM-5.2', { efforts: ['high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
      m('qwen-token-plan', 'kimi-k2.7-code', 'Kimi K2.7 Code', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: true }),
      m('qwen-token-plan', 'MiniMax-M2.5', 'MiniMax-M2.5', { efforts: [], contextWindow: 196_608, maxOutput: 32_768, reasoning: true })
    ]
  ),
  hosted('xiaomi-token-plan', 'MiMo Token Plan', 'subscription', 'https://token-plan-sgp.xiaomimimo.com/v1', "Xiaomi's MiMo subscription (Singapore or Amsterdam)", 'https://platform.xiaomimimo.com', [
    m('xiaomi-token-plan', 'mimo-v2.5-pro', 'MiMo-V2.5-Pro', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true }),
    m('xiaomi-token-plan', 'mimo-v2.5', 'MiMo-V2.5', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true })
  ]),
  hosted('opencode-go', 'OpenCode Go', 'subscription', 'https://opencode.ai/zen/go/v1', 'Flat-rate open models from OpenCode', 'https://opencode.ai/auth', [
    m('opencode-go', 'kimi-k3', 'Kimi K3', { efforts: ['ultra'], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true }),
    m('opencode-go', 'glm-5.3', 'GLM-5.3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('opencode-go', 'deepseek-v4-pro', 'DeepSeek V4 Pro (New)', { efforts: ['high', 'ultra'], contextWindow: 1_000_000, maxOutput: 384_000, reasoning: true }),
    m('opencode-go', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', { efforts: ['high', 'ultra'], contextWindow: 1_000_000, maxOutput: 384_000, vision: true, reasoning: true }),
    m('opencode-go', 'qwen3.8-max', 'Qwen3.8 Max', { efforts: ['light', 'medium', 'extra-high'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
    m('opencode-go', 'minimax-m3', 'MiniMax-M3', { efforts: OPENAI_EFFORTS, contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
    m('opencode-go', 'mimo-v2.5-pro', 'MiMo V2.5 Pro', { efforts: OPENAI_EFFORTS, contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true }),
    m('opencode-go', 'gpt-5.6-luna', 'GPT-5.6 Luna', { efforts: ALL_EFFORTS, contextWindow: 1_050_000, maxOutput: 128_000, vision: true, reasoning: true }),
    m('opencode-go', 'grok-4.6', 'Grok 4.6', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 500_000, maxOutput: 500_000, vision: true, reasoning: true })
  ]),

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
    models: [
      m('anthropic', 'claude-opus-5-5', 'Opus 5.5', { efforts: ALL_EFFORTS, contextWindow: 1_000_000, maxOutput: 64_000, vision: true, reasoning: true }),
      m('anthropic', 'claude-fable-5-1', 'Fable 5.1', { efforts: ALL_EFFORTS, contextWindow: 1_000_000, maxOutput: 64_000, vision: true, reasoning: true }),
      m('anthropic', 'claude-opus-5', 'Opus 5', { efforts: ALL_EFFORTS, contextWindow: 1_000_000, maxOutput: 64_000, vision: true, reasoning: true }),
      m('anthropic', 'claude-sonnet-5', 'Sonnet 5', { efforts: ALL_EFFORTS, contextWindow: 1_000_000, maxOutput: 64_000, vision: true, reasoning: true }),
      m('anthropic', 'claude-opus-4-8', 'Opus 4.8', { efforts: ALL_EFFORTS, contextWindow: 1_000_000, maxOutput: 64_000, vision: true, reasoning: true }),
      m('anthropic', 'claude-haiku-4-5', 'Haiku 4.5', { contextWindow: 200_000, maxOutput: 64_000, vision: true, reasoning: true })
    ]
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
    models: [
      m('openai', 'gpt-6-astra', 'GPT-6 Astra', { efforts: ALL_EFFORTS, contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai', 'gpt-5.6-sol', 'GPT-5.6 Sol', { efforts: ALL_EFFORTS, contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', { efforts: ALL_EFFORTS, contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', { efforts: ALL_EFFORTS, contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai', 'gpt-5.5', 'GPT-5.5', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai', 'gpt-5.5-pro', 'GPT-5.5 Pro', { efforts: ['medium', 'high', 'extra-high'], contextWindow: 1_050_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai', 'gpt-5.4', 'GPT-5.4', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai', 'gpt-5.4-mini', 'GPT-5.4 mini', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 400_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai', 'gpt-5.4-nano', 'GPT-5.4 nano', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 400_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai', 'gpt-5.3-codex', 'GPT-5.3 Codex', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 400_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai', 'gpt-5', 'GPT-5', { efforts: OPENAI_EFFORTS, contextWindow: 400_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai', 'gpt-5-mini', 'GPT-5 Mini', { efforts: OPENAI_EFFORTS, contextWindow: 400_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('openai', 'gpt-4.1', 'GPT-4.1', { efforts: [], contextWindow: 1_047_576, maxOutput: 32_768, vision: true, reasoning: false }),
      m('openai', 'gpt-4o', 'GPT-4o', { efforts: [], contextWindow: 128_000, maxOutput: 16_384, vision: true, reasoning: false }),
      m('openai', 'o3', 'o3', { efforts: OPENAI_EFFORTS, contextWindow: 200_000, maxOutput: 100_000, vision: true, reasoning: true }),
      m('openai', 'o4-mini', 'o4-mini', { efforts: OPENAI_EFFORTS, contextWindow: 200_000, maxOutput: 100_000, vision: true, reasoning: true })
    ]
  },
  hosted('gemini', 'Gemini', 'frontier', 'https://generativelanguage.googleapis.com/v1beta/openai', 'Google AI Studio', 'https://aistudio.google.com/app/apikey', [
    m('gemini', 'gemini-3.8-flash', 'Gemini 3.8 Flash', { efforts: OPENAI_EFFORTS, contextWindow: 1_048_576, maxOutput: 65_536, vision: true, reasoning: true }),
    m('gemini', 'gemini-3.7-flash', 'Gemini 3.7 Flash', { efforts: OPENAI_EFFORTS, contextWindow: 1_048_576, maxOutput: 65_536, vision: true, reasoning: true }),
    m('gemini', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', { efforts: OPENAI_EFFORTS, contextWindow: 1_048_576, maxOutput: 65_536, vision: true, reasoning: true }),
    m('gemini', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', { efforts: ['light', 'high'], contextWindow: 1_048_576, maxOutput: 65_536, vision: true, reasoning: true }),
    m('gemini', 'gemini-2.5-pro', 'Gemini 2.5 Pro', { efforts: OPENAI_EFFORTS, contextWindow: 1_048_576, maxOutput: 65_536, vision: true, reasoning: true }),
    m('gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', { efforts: OPENAI_EFFORTS, contextWindow: 1_048_576, maxOutput: 65_536, vision: true, reasoning: true }),
    m('gemini', 'gemma-4-31b-it', 'Gemma 4 31B IT', { efforts: [], contextWindow: 262_144, maxOutput: 32_768, vision: true, reasoning: true })
  ]),
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
    models: [
      m('xai', 'grok-4.6', 'Grok 4.6', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 500_000, maxOutput: 500_000, vision: true, reasoning: true }),
      m('xai', 'grok-4.5', 'Grok 4.5', { efforts: OPENAI_EFFORTS, contextWindow: 500_000, maxOutput: 500_000, vision: true, reasoning: true }),
      m('xai', 'grok-4.3', 'Grok 4.3', { efforts: OPENAI_EFFORTS, contextWindow: 1_000_000, maxOutput: 30_000, vision: true, reasoning: true })
    ]
  },
  hosted('mistral', 'Mistral', 'frontier', 'https://api.mistral.ai/v1', 'Mistral, Magistral, Devstral and Codestral', 'https://console.mistral.ai/api-keys', [
    m('mistral', 'mistral-large-latest', 'Mistral Large (latest)', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: false }),
    m('mistral', 'mistral-medium-latest', 'Mistral Medium (latest)', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: true }),
    m('mistral', 'mistral-small-latest', 'Mistral Small (latest)', { efforts: [], contextWindow: 256_000, maxOutput: 256_000, vision: true, reasoning: true }),
    m('mistral', 'magistral-medium-latest', 'Magistral Medium (latest)', { efforts: [], contextWindow: 128_000, maxOutput: 16_384, reasoning: true }),
    m('mistral', 'devstral-latest', 'Devstral 2', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, reasoning: false }),
    m('mistral', 'devstral-medium-latest', 'Devstral 2 (latest)', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, reasoning: false }),
    m('mistral', 'codestral-latest', 'Codestral (latest)', { efforts: [], contextWindow: 256_000, maxOutput: 4_096, reasoning: false }),
    m('mistral', 'ministral-8b-latest', 'Ministral 8B (latest)', { efforts: [], contextWindow: 128_000, maxOutput: 128_000, reasoning: false }),
    m('mistral', 'pixtral-large-latest', 'Pixtral Large (latest)', { efforts: [], contextWindow: 128_000, maxOutput: 128_000, vision: true, reasoning: false })
  ]),
  hosted('deepseek', 'DeepSeek', 'frontier', 'https://api.deepseek.com', 'DeepSeek V4, direct from the lab', 'https://platform.deepseek.com/api_keys', [
    m('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', { efforts: ['high', 'ultra'], contextWindow: 1_000_000, maxOutput: 384_000, reasoning: true }),
    m('deepseek', 'deepseek-flash', 'DeepSeek V4.1 Flash', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 384_000, vision: true, reasoning: true }),
    m('deepseek', 'deepseek-chat', 'DeepSeek Chat', { efforts: [], contextWindow: 128_000, maxOutput: 8192, reasoning: false }),
    m('deepseek', 'deepseek-reasoner', 'DeepSeek Reasoner', { efforts: [], contextWindow: 128_000, maxOutput: 65_536, reasoning: true })
  ]),
  hosted('moonshot', 'Kimi', 'frontier', 'https://api.moonshot.ai/v1', "Moonshot AI's Kimi models", 'https://platform.moonshot.ai/console/api-keys', [
    m('moonshot', 'kimi-k3', 'Kimi K3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true }),
    m('moonshot', 'kimi-k2.7-code', 'Kimi K2.7 Code', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: true }),
    m('moonshot', 'kimi-k2.7-code-highspeed', 'Kimi K2.7 Code HighSpeed', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: true }),
    m('moonshot', 'kimi-k2.6', 'Kimi K2.6', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: true })
  ]),
  hosted('zai', 'Z.ai', 'frontier', 'https://api.z.ai/api/paas/v4', 'GLM models, pay as you go', 'https://z.ai/manage-apikey/apikey-list', [
    m('zai', 'glm-5.3', 'GLM-5.3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('zai', 'glm-5.3-highspeed', 'GLM-5.3 Highspeed', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('zai', 'glm-5.3-flash', 'GLM-5.3-Flash', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
    m('zai', 'glm-5.2', 'GLM-5.2', { efforts: ['high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('zai', 'glm-5-turbo', 'GLM-5-Turbo', { efforts: [], contextWindow: 200_000, maxOutput: 131_072, reasoning: true }),
    m('zai', 'glm-4.7', 'GLM-4.7', { efforts: [], contextWindow: 204_800, maxOutput: 131_072, reasoning: true })
  ]),
  hosted(
    'qwen',
    'Qwen',
    'frontier',
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'Alibaba Cloud Model Studio (international)',
    'https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key',
    [
      m('qwen', 'qwen3.8-max', 'Qwen3.8 Max', { efforts: ['light', 'medium', 'extra-high'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
      m('qwen', 'qwen3.8-flash', 'Qwen3.8 Flash', { efforts: ['light', 'medium', 'extra-high'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
      m('qwen', 'qwen3.7-plus', 'Qwen3.7 Plus', { efforts: [], contextWindow: 1_000_000, maxOutput: 65_536, vision: true, reasoning: true }),
      m('qwen', 'qwen3-coder-plus', 'Qwen3 Coder Plus', { efforts: [], contextWindow: 1_000_000, maxOutput: 65_536, reasoning: false }),
      m('qwen', 'qwen-plus', 'Qwen Plus', { efforts: [], contextWindow: 1_000_000, maxOutput: 32_768, reasoning: true }),
      m('qwen', 'qwen-flash', 'Qwen Flash', { efforts: [], contextWindow: 1_000_000, maxOutput: 32_768, reasoning: true })
    ]
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
    models: [
      m('minimax', 'MiniMax-M3', 'MiniMax-M3', { efforts: OPENAI_EFFORTS, contextWindow: 1_048_576, maxOutput: 512_000, vision: true, reasoning: true }),
      m('minimax', 'MiniMax-M2.7', 'MiniMax-M2.7', { efforts: OPENAI_EFFORTS, contextWindow: 204_800, maxOutput: 131_072, reasoning: true }),
      m('minimax', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.7-highspeed', { efforts: OPENAI_EFFORTS, contextWindow: 204_800, maxOutput: 131_072, reasoning: true })
    ]
  },
  hosted('xiaomi', 'Xiaomi MiMo', 'frontier', 'https://api.xiaomimimo.com/v1', 'MiMo V2.5, pay as you go', 'https://platform.xiaomimimo.com', [
    m('xiaomi', 'mimo-v2.5-pro', 'MiMo-V2.5-Pro', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true }),
    m('xiaomi', 'mimo-v2.5', 'MiMo-V2.5', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true }),
    m('xiaomi', 'mimo-v2.5-pro-ultraspeed', 'MiMo-V2.5-Pro-UltraSpeed', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true })
  ]),
  hosted('cohere', 'Cohere', 'frontier', 'https://api.cohere.ai/compatibility/v1', 'Command A, through the OpenAI-compatible API', 'https://dashboard.cohere.com/api-keys', [
    m('cohere', 'command-a-03-2025', 'Command A', { efforts: [], contextWindow: 256_000, maxOutput: 8000, reasoning: false }),
    m('cohere', 'command-a-reasoning-08-2025', 'Command A Reasoning', { efforts: [], contextWindow: 256_000, maxOutput: 32_000, reasoning: true }),
    m('cohere', 'command-a-vision-07-2025', 'Command A Vision', { efforts: [], contextWindow: 128_000, maxOutput: 8000, vision: true, reasoning: false, tools: false }),
    m('cohere', 'command-r-plus-08-2024', 'Command R+', { efforts: [], contextWindow: 128_000, maxOutput: 4000, reasoning: false }),
    m('cohere', 'command-r7b-12-2024', 'Command R7B', { efforts: [], contextWindow: 128_000, maxOutput: 4000, reasoning: false })
  ]),
  hosted('perplexity', 'Perplexity', 'frontier', 'https://api.perplexity.ai', 'Sonar: answers grounded in live web search', 'https://www.perplexity.ai/settings/api', [
    // Sonar does not take function tools; the adapter leaves them off.
    m('perplexity', 'sonar-pro', 'Sonar Pro', { efforts: [], contextWindow: 200_000, maxOutput: 8000, reasoning: false, tools: false }),
    m('perplexity', 'sonar', 'Sonar', { efforts: [], contextWindow: 128_000, reasoning: false, tools: false }),
    m('perplexity', 'sonar-reasoning-pro', 'Sonar Reasoning Pro', { efforts: [], contextWindow: 128_000, reasoning: true, tools: false }),
    m('perplexity', 'sonar-deep-research', 'Sonar Deep Research', { efforts: [], contextWindow: 128_000, reasoning: true, tools: false })
  ]),

  // ---- Gateways: many labs behind one key ----
  hosted('openrouter', 'OpenRouter', 'gateway', 'https://openrouter.ai/api/v1', 'Hundreds of models behind one key', 'https://openrouter.ai/keys', [], {
    headers: { 'HTTP-Referer': 'https://eaon.dev', 'X-Title': 'Eaon' }
  }),
  hosted('vercel', 'Vercel AI Gateway', 'gateway', 'https://ai-gateway.vercel.sh/v1', 'Every major lab through Vercel, with fallbacks', 'https://vercel.com/docs/ai-gateway/authentication', [
    m('vercel', 'anthropic/claude-sonnet-5', 'Claude Sonnet 5', { contextWindow: 1_000_000, maxOutput: 64_000, vision: true, reasoning: true }),
    m('vercel', 'anthropic/claude-opus-5.5', 'Claude Opus 5.5', { contextWindow: 1_000_000, maxOutput: 64_000, vision: true, reasoning: true }),
    m('vercel', 'openai/gpt-6-astra', 'GPT-6 Astra', { efforts: OPENAI_EFFORTS, contextWindow: 1_050_000, maxOutput: 128_000, vision: true, reasoning: true }),
    m('vercel', 'openai/gpt-5.6-sol', 'GPT-5.6 Sol', { efforts: OPENAI_EFFORTS, contextWindow: 1_050_000, maxOutput: 128_000, vision: true, reasoning: true }),
    m('vercel', 'google/gemini-3.8-flash', 'Gemini 3.8 Flash', { efforts: OPENAI_EFFORTS, contextWindow: 1_000_000, maxOutput: 65_535, vision: true, reasoning: true }),
    m('vercel', 'xai/grok-4.6', 'Grok 4.6', { efforts: OPENAI_EFFORTS, contextWindow: 500_000, maxOutput: 128_000, vision: true, reasoning: true }),
    m('vercel', 'moonshotai/kimi-k3', 'Kimi K3', { efforts: [], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
    m('vercel', 'zai/glm-5.3', 'GLM 5.3', { efforts: [], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('vercel', 'deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro', { efforts: [], contextWindow: 1_000_000, maxOutput: 384_000, reasoning: true })
  ]),
  hosted(
    'cloudflare-ai-gateway',
    'Cloudflare AI Gateway',
    'gateway',
    'https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat',
    'Workers AI, plus labs you add keys for in the gateway',
    'https://dash.cloudflare.com/profile/api-tokens',
    [
      m('cloudflare-ai-gateway', 'workers-ai/@cf/moonshotai/kimi-k2.6', 'Kimi K2.6', { efforts: [], contextWindow: 262_144, maxOutput: 256_000, vision: true, reasoning: true }),
      m('cloudflare-ai-gateway', 'workers-ai/@cf/zai-org/glm-5.3', 'GLM 5.3', { efforts: [], contextWindow: 1_310_720, maxOutput: 1_310_720, reasoning: true }),
      m('cloudflare-ai-gateway', 'workers-ai/@cf/openai/gpt-oss-120b', 'GPT OSS 120B', { efforts: [], contextWindow: 128_000, maxOutput: 16_384, reasoning: true }),
      m('cloudflare-ai-gateway', 'workers-ai/@cf/qwen/qwen3.8-27b', 'Qwen3.8 27B', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: true })
    ]
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
    models: [
      m('opencode', 'claude-sonnet-5', 'Claude Sonnet 5', { contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('opencode', 'claude-opus-5', 'Claude Opus 5', { contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('opencode', 'claude-fable-5-1', 'Claude Fable 5.1', { contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('opencode', 'gpt-6-astra', 'GPT-6 Astra', { efforts: ALL_EFFORTS, contextWindow: 1_050_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('opencode', 'gpt-5.6-sol', 'GPT-5.6 Sol (50% Off)', { efforts: ALL_EFFORTS, contextWindow: 1_050_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('opencode', 'gpt-5.5', 'GPT-5.5', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 1_050_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('opencode', 'gpt-5.3-codex', 'GPT-5.3 Codex', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 400_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('opencode', 'grok-4.6', 'Grok 4.6', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 500_000, maxOutput: 500_000, vision: true, reasoning: true }),
      m('opencode', 'kimi-k3', 'Kimi K3', { efforts: ['ultra'], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true }),
      m('opencode', 'glm-5.3', 'GLM-5.3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
      m('opencode', 'deepseek-v4-pro', 'DeepSeek V4 Pro', { efforts: ['high', 'ultra'], contextWindow: 1_000_000, maxOutput: 384_000, reasoning: true }),
      m('opencode', 'minimax-m3', 'MiniMax-M3', { efforts: OPENAI_EFFORTS, contextWindow: 512_000, maxOutput: 128_000, vision: true, reasoning: true }),
      m('opencode', 'qwen3.6-plus', 'Qwen3.6 Plus', { efforts: OPENAI_EFFORTS, contextWindow: 262_144, maxOutput: 65_536, vision: true, reasoning: true }),
      m('opencode', 'big-pickle', 'Big Pickle', { efforts: OPENAI_EFFORTS, contextWindow: 200_000, maxOutput: 32_000, reasoning: true })
    ]
  },
  hosted('huggingface', 'Hugging Face', 'gateway', 'https://router.huggingface.co/v1', 'Open models routed across inference partners', 'https://huggingface.co/settings/tokens', [
    m('huggingface', 'moonshotai/Kimi-K3', 'Kimi K3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
    m('huggingface', 'zai-org/GLM-5.3', 'GLM-5.3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true }),
    m('huggingface', 'deepseek-ai/DeepSeek-V4.1-Flash', 'DeepSeek V4.1 Flash', { efforts: ['light', 'high', 'extra-high', 'ultra'], contextWindow: 1_048_576, maxOutput: 384_000, vision: true, reasoning: true }),
    m('huggingface', 'deepseek-ai/DeepSeek-V4-Pro', 'DeepSeek V4 Pro', { efforts: ['high'], contextWindow: 1_048_576, maxOutput: 393_216, reasoning: true }),
    m('huggingface', 'Qwen/Qwen3.8-2.4T-A95B', 'Qwen3.8 2.4T A95B', { efforts: ['light', 'medium', 'extra-high'], contextWindow: 262_144, maxOutput: 131_072, reasoning: true }),
    m('huggingface', 'MiniMaxAI/MiniMax-M3', 'MiniMax-M3', { efforts: OPENAI_EFFORTS, contextWindow: 524_288, maxOutput: 512_000, vision: true, reasoning: true }),
    m('huggingface', 'XiaomiMiMo/MiMo-V2.5-Pro', 'MiMo-V2.5-Pro', { efforts: ['light', 'medium', 'high', 'extra-high'], contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true }),
    m('huggingface', 'openai/gpt-oss-120b', 'GPT OSS 120B', { efforts: OPENAI_EFFORTS, contextWindow: 131_072, maxOutput: 32_768, reasoning: true }),
    m('huggingface', 'Qwen/Qwen3-Coder-480B-A35B-Instruct', 'Qwen3-Coder-480B-A35B-Instruct', { efforts: [], contextWindow: 262_144, maxOutput: 66_536, reasoning: false }),
    m('huggingface', 'meta-llama/Llama-3.3-70B-Instruct', 'Llama-3.3-70B-Instruct', { efforts: [], contextWindow: 131_072, maxOutput: 4_096, reasoning: false })
  ]),
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
  hosted('groq', 'Groq', 'inference', 'https://api.groq.com/openai/v1', 'Very fast open models on LPUs', 'https://console.groq.com/keys', [
    m('groq', 'openai/gpt-oss-120b', 'GPT OSS 120B', { efforts: OPENAI_EFFORTS, contextWindow: 131_072, maxOutput: 65_536, reasoning: true }),
    m('groq', 'openai/gpt-oss-20b', 'GPT OSS 20B', { efforts: OPENAI_EFFORTS, contextWindow: 131_072, maxOutput: 65_536, reasoning: true }),
    m('groq', 'qwen/qwen3.8-27b', 'Qwen3.8 27B', { efforts: OPENAI_EFFORTS, contextWindow: 131_042, maxOutput: 16_384, vision: true, reasoning: true }),
    m('groq', 'qwen/qwen3.6-27b', 'Qwen3.6 27B', { efforts: ['high'], contextWindow: 131_072, maxOutput: 16_384, vision: true, reasoning: true }),
    m('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', { efforts: [], contextWindow: 131_072, maxOutput: 32_768, reasoning: false }),
    m('groq', 'llama-3.1-8b-instant', 'Llama 3.1 8B', { efforts: [], contextWindow: 131_072, maxOutput: 131_072, reasoning: false })
  ]),
  hosted('cerebras', 'Cerebras', 'inference', 'https://api.cerebras.ai/v1', 'Wafer-scale inference, thousands of tokens a second', 'https://cloud.cerebras.ai', [
    m('cerebras', 'gpt-oss-120b', 'GPT OSS 120B', { efforts: OPENAI_EFFORTS, contextWindow: 131_072, maxOutput: 40_960, reasoning: true }),
    m('cerebras', 'qwen-3.8-27b', 'Qwen3.8 27B', { efforts: OPENAI_EFFORTS, contextWindow: 65_536, maxOutput: 32_768, vision: true, reasoning: true })
  ]),
  hosted('fireworks', 'Fireworks', 'inference', 'https://api.fireworks.ai/inference/v1', 'Fast serverless open models', 'https://fireworks.ai/account/api-keys', [
    m('fireworks', 'accounts/fireworks/models/kimi-k3', 'Kimi K3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true }),
    m('fireworks', 'accounts/fireworks/models/glm-5p3', 'GLM 5.3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_048_573, maxOutput: 262_144, reasoning: true }),
    m('fireworks', 'accounts/fireworks/models/glm-5p3-flash', 'GLM 5.3 Flash', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_048_573, maxOutput: 131_072, vision: true, reasoning: true }),
    m('fireworks', 'accounts/fireworks/models/deepseek-v4p1-flash', 'DeepSeek V4.1 Flash', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 384_000, vision: true, reasoning: true }),
    m('fireworks', 'accounts/fireworks/models/deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 384_000, reasoning: true }),
    m('fireworks', 'accounts/fireworks/models/qwen3p8-max', 'Qwen3.8 Max', { efforts: ['light', 'medium', 'extra-high'], contextWindow: 262_144, maxOutput: 131_072, reasoning: true }),
    m('fireworks', 'accounts/fireworks/models/minimax-m3', 'MiniMax-M3', { efforts: OPENAI_EFFORTS, contextWindow: 512_000, maxOutput: 512_000, vision: true, reasoning: true }),
    m('fireworks', 'accounts/fireworks/models/gpt-oss-120b', 'GPT OSS 120B', { efforts: OPENAI_EFFORTS, contextWindow: 131_072, maxOutput: 32_768, reasoning: true })
  ]),
  hosted('together', 'Together AI', 'inference', 'https://api.together.ai/v1', 'Open models, serverless or dedicated', 'https://api.together.ai/settings/api-keys', [
    m('together', 'moonshotai/Kimi-K3', 'Kimi K3', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true }),
    m('together', 'zai-org/GLM-5.3', 'GLM-5.3', { efforts: [], contextWindow: 1_048_576, maxOutput: 262_144, reasoning: true }),
    m('together', 'deepseek-ai/DeepSeek-V4-Pro', 'DeepSeek V4 Pro', { efforts: ['high'], contextWindow: 512_000, maxOutput: 384_000, reasoning: true }),
    m('together', 'deepseek-ai/DeepSeek-V4-Flash-0731', 'DeepSeek V4 Flash 0731', { efforts: [], contextWindow: 1_000_000, maxOutput: 384_000, reasoning: true }),
    m('together', 'Qwen/Qwen3.7-Max', 'Qwen3.7 Max', { efforts: [], contextWindow: 1_000_000, maxOutput: 500_000, reasoning: false }),
    m('together', 'MiniMaxAI/MiniMax-M3', 'MiniMax-M3', { efforts: [], contextWindow: 524_288, maxOutput: 250_000, vision: true, reasoning: true }),
    m('together', 'openai/gpt-oss-120b', 'GPT OSS 120B', { efforts: OPENAI_EFFORTS, contextWindow: 131_072, maxOutput: 131_072, reasoning: true }),
    m('together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Llama 3.3 70B', { efforts: [], contextWindow: 131_072, maxOutput: 131_072, reasoning: false })
  ]),
  hosted('baseten', 'Baseten', 'inference', 'https://inference.baseten.co/v1', 'Model APIs on dedicated-grade infrastructure', 'https://app.baseten.co/settings/api_keys', [
    m('baseten', 'moonshotai/Kimi-K3', 'Kimi K3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_048_576, maxOutput: 262_144, vision: true, reasoning: true }),
    m('baseten', 'zai-org/GLM-5.3', 'GLM 5.3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_048_576, maxOutput: 262_144, vision: true, reasoning: true }),
    m('baseten', 'deepseek-ai/DeepSeek-V4-Pro', 'DeepSeek V4 Pro', { efforts: ALL_EFFORTS, contextWindow: 1_048_576, maxOutput: 262_144, reasoning: true }),
    m('baseten', 'deepseek-ai/DeepSeek-V4.1-Flash', 'DeepSeek V4.1 Flash', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_048_576, maxOutput: 32_768, vision: true, reasoning: true }),
    m('baseten', 'openai/gpt-oss-120b', 'OpenAI GPT 120B', { efforts: ALL_EFFORTS, contextWindow: 128_072, maxOutput: 128_072, reasoning: true }),
    m('baseten', 'thinkingmachines/inkling', 'Inkling', { efforts: ALL_EFFORTS, contextWindow: 1_048_576, maxOutput: 32_768, vision: true, reasoning: true })
  ]),
  hosted('deepinfra', 'DeepInfra', 'inference', 'https://api.deepinfra.com/v1/openai', 'Low-cost serverless open models', 'https://deepinfra.com/dash/api_keys', [
    m('deepinfra', 'moonshotai/Kimi-K3', 'Kimi K3', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true }),
    m('deepinfra', 'zai-org/GLM-5.3', 'GLM-5.3', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true }),
    m('deepinfra', 'deepseek-ai/DeepSeek-V4-Pro', 'DeepSeek V4 Pro', { efforts: [], contextWindow: 1_048_576, maxOutput: 384_000, reasoning: true }),
    m('deepinfra', 'deepseek-ai/DeepSeek-V4.1-Flash', 'DeepSeek V4.1 Flash', { efforts: [], contextWindow: 1_048_576, maxOutput: 384_000, vision: true, reasoning: true }),
    m('deepinfra', 'Qwen/Qwen3.8-Max', 'Qwen3.8 Max', { efforts: OPENAI_EFFORTS, contextWindow: 256_000, maxOutput: 131_072, reasoning: true }),
    m('deepinfra', 'MiniMaxAI/MiniMax-M3', 'MiniMax-M3', { efforts: [], contextWindow: 524_288, maxOutput: 131_072, vision: true, reasoning: true }),
    m('deepinfra', 'openai/gpt-oss-120b', 'GPT OSS 120B', { efforts: OPENAI_EFFORTS, contextWindow: 131_072, maxOutput: 32_768, reasoning: true })
  ]),
  hosted('novita', 'Novita AI', 'inference', 'https://api.novita.ai/openai/v1', 'Serverless open models', 'https://novita.ai/settings/key-management', [
    m('novita', 'moonshotai/kimi-k3', 'Kimi K3', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true }),
    m('novita', 'zai-org/glm-5.3', 'GLM-5.3', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true }),
    m('novita', 'deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro', { efforts: [], contextWindow: 1_048_576, maxOutput: 393_216, reasoning: true }),
    m('novita', 'deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', { efforts: [], contextWindow: 1_048_576, maxOutput: 393_216, reasoning: true }),
    m('novita', 'qwen/qwen3.8-max', 'Qwen3.8 Max', { efforts: [], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('novita', 'minimax/minimax-m3', 'MiniMax-M3', { efforts: [], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('novita', 'xiaomimimo/mimo-v2.5-pro', 'MiMo-V2.5-Pro', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true })
  ]),
  hosted('sambanova', 'SambaNova', 'inference', 'https://api.sambanova.ai/v1', 'Fast open models on RDUs', 'https://cloud.sambanova.ai/apis', [
    m('sambanova', 'MiniMax-M3', 'MiniMax-M3', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true }),
    m('sambanova', 'DeepSeek-V3.1', 'DeepSeek V3.1', { efforts: [], contextWindow: 131_072, maxOutput: 7168, reasoning: true }),
    m('sambanova', 'gpt-oss-120b', 'GPT OSS 120B', { efforts: OPENAI_EFFORTS, contextWindow: 131_072, maxOutput: 32_768, reasoning: true }),
    m('sambanova', 'Meta-Llama-3.3-70B-Instruct', 'Llama 3.3 70B', { efforts: [], contextWindow: 131_072, maxOutput: 3072, reasoning: false })
  ]),
  hosted('nebius', 'Nebius Token Factory', 'inference', 'https://api.tokenfactory.nebius.com/v1', 'Open models on Nebius (formerly AI Studio)', 'https://studio.nebius.com/settings/api-keys', [
    m('nebius', 'moonshotai/Kimi-K2.6', 'Kimi K2.6', { efforts: [], contextWindow: 262_144, maxOutput: 131_072, reasoning: true }),
    m('nebius', 'deepseek-ai/DeepSeek-V3.2', 'DeepSeek V3.2', { efforts: [], contextWindow: 163_840, maxOutput: 65_536, reasoning: true }),
    m('nebius', 'Qwen/Qwen3-Coder-480B-A35B-Instruct', 'Qwen3 Coder 480B', { efforts: [], contextWindow: 262_144, maxOutput: 65_536, reasoning: false }),
    m('nebius', 'openai/gpt-oss-120b', 'GPT OSS 120B', { efforts: OPENAI_EFFORTS, contextWindow: 131_072, maxOutput: 32_768, reasoning: true })
  ]),
  hosted('nvidia-nim', 'NVIDIA NIM', 'inference', 'https://integrate.api.nvidia.com/v1', 'NVIDIA-hosted open models, free to try', 'https://build.nvidia.com', [
    m('nvidia-nim', 'moonshotai/kimi-k3', 'Kimi K3', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true }),
    m('nvidia-nim', 'deepseek-ai/deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813', { efforts: [], contextWindow: 1_000_000, maxOutput: 384_000, reasoning: true }),
    m('nvidia-nim', 'deepseek-ai/deepseek-v4-flash-0731', 'DeepSeek V4 Flash 0731', { efforts: [], contextWindow: 1_000_000, maxOutput: 384_000, reasoning: true }),
    m('nvidia-nim', 'nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra 550B A55B', { efforts: [], contextWindow: 1_000_000, maxOutput: 65_536, reasoning: true }),
    m('nvidia-nim', 'nvidia/nemotron-3-super-120b-a12b', 'Nemotron 3 Super', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, reasoning: true }),
    m('nvidia-nim', 'moonshotai/kimi-k2.6', 'Kimi K2.6', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: true }),
    m('nvidia-nim', 'openai/gpt-oss-20b', 'GPT OSS 20B', { efforts: [], contextWindow: 131_072, maxOutput: 32_768, reasoning: true }),
    m('nvidia-nim', 'nvidia/llama-3.1-nemotron-ultra-253b-v1', 'Llama 3.1 Nemotron Ultra 253B', { efforts: [], contextWindow: 128_000, maxOutput: 16_384, reasoning: true })
  ]),
  hosted(
    'cloudflare-workers-ai',
    'Cloudflare Workers AI',
    'inference',
    'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    'Open models on Cloudflare’s network',
    'https://dash.cloudflare.com/profile/api-tokens',
    [
      m('cloudflare-workers-ai', '@cf/moonshotai/kimi-k2.6', 'Kimi K2.6', { efforts: OPENAI_EFFORTS, contextWindow: 262_144, maxOutput: 256_000, vision: true, reasoning: true }),
      m('cloudflare-workers-ai', '@cf/zai-org/glm-5.3', 'GLM 5.3', { efforts: OPENAI_EFFORTS, contextWindow: 1_310_720, maxOutput: 1_310_720, reasoning: true }),
      m('cloudflare-workers-ai', '@cf/deepseek-ai/deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813', { efforts: ['high', 'ultra'], contextWindow: 1_048_576, maxOutput: 1_048_576, reasoning: true }),
      m('cloudflare-workers-ai', '@cf/openai/gpt-oss-120b', 'GPT OSS 120B', { efforts: OPENAI_EFFORTS, contextWindow: 128_000, maxOutput: 16_384, reasoning: true }),
      m('cloudflare-workers-ai', '@cf/qwen/qwen3.8-27b', 'Qwen3.8 27B', { efforts: ['light', 'medium', 'extra-high'], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: true }),
      m('cloudflare-workers-ai', '@cf/google/gemma-4-26b-a4b-it', 'Gemma 4 26B A4B IT', { efforts: OPENAI_EFFORTS, contextWindow: 256_000, maxOutput: 16_384, vision: true, reasoning: true }),
      m('cloudflare-workers-ai', '@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B 16E Instruct', { efforts: [], contextWindow: 131_000, maxOutput: 16_384, vision: true, reasoning: false }),
      m('cloudflare-workers-ai', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B Instruct fp8 Fast', { efforts: [], contextWindow: 24_000, maxOutput: 24_000, reasoning: false })
    ]
  ),

  // ---- China region endpoints: separate accounts and keys from the international ones ----
  hosted('moonshot-cn', 'Kimi (China)', 'regional', 'https://api.moonshot.cn/v1', 'Moonshot AI, mainland China platform', 'https://platform.moonshot.cn/console/api-keys', [
    m('moonshot-cn', 'kimi-k3', 'Kimi K3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true }),
    m('moonshot-cn', 'kimi-k2.7-code', 'Kimi K2.7 Code', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: true }),
    m('moonshot-cn', 'kimi-k2.7-code-highspeed', 'Kimi K2.7 Code HighSpeed', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: true }),
    m('moonshot-cn', 'kimi-k2.6', 'Kimi K2.6', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: true })
  ]),
  hosted('zai-cn', 'BigModel', 'regional', 'https://open.bigmodel.cn/api/paas/v4', "Zhipu's GLM platform (China)", 'https://open.bigmodel.cn/usercenter/apikeys', [
    m('zai-cn', 'glm-5.3', 'GLM-5.3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('zai-cn', 'glm-5.3-highspeed', 'GLM-5.3 Highspeed', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('zai-cn', 'glm-5.3-flash', 'GLM-5.3-Flash', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
    m('zai-cn', 'glm-5.2', 'GLM-5.2', { efforts: ['high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('zai-cn', 'glm-5.1', 'GLM-5.1', { efforts: [], contextWindow: 200_000, maxOutput: 131_072, reasoning: true }),
    m('zai-cn', 'glm-5v-turbo', 'GLM-5V-Turbo', { efforts: [], contextWindow: 200_000, maxOutput: 131_072, vision: true, reasoning: true }),
    m('zai-cn', 'glm-4.7', 'GLM-4.7', { efforts: [], contextWindow: 204_800, maxOutput: 131_072, reasoning: true })
  ]),
  hosted('zai-coding-cn', 'GLM Coding Plan (China)', 'regional', 'https://open.bigmodel.cn/api/coding/paas/v4', "Zhipu's GLM coding subscription (China)", 'https://open.bigmodel.cn/usercenter/apikeys', [
    m('zai-coding-cn', 'glm-5.3', 'GLM-5.3', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('zai-coding-cn', 'glm-5.3-highspeed', 'GLM-5.3 Highspeed', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('zai-coding-cn', 'glm-5.3-flash', 'GLM-5.3-Flash', { efforts: ['light', 'high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
    m('zai-coding-cn', 'glm-5.2', 'GLM-5.2', { efforts: ['high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
    m('zai-coding-cn', 'glm-5.1', 'GLM-5.1', { efforts: [], contextWindow: 200_000, maxOutput: 131_072, reasoning: true }),
    m('zai-coding-cn', 'glm-5v-turbo', 'GLM-5V-Turbo', { efforts: [], contextWindow: 200_000, maxOutput: 131_072, vision: true, reasoning: true }),
    m('zai-coding-cn', 'glm-4.7', 'GLM-4.7', { efforts: [], contextWindow: 204_800, maxOutput: 131_072, reasoning: true })
  ]),
  hosted('qwen-cn', 'Qwen (China)', 'regional', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'Alibaba Cloud Bailian (China)', 'https://bailian.console.aliyun.com/?tab=model#/api-key', [
    m('qwen-cn', 'qwen3.8-max', 'Qwen3.8 Max', { efforts: ['light', 'medium', 'extra-high'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
    m('qwen-cn', 'qwen3.8-flash', 'Qwen3.8 Flash', { efforts: ['light', 'medium', 'extra-high'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
    m('qwen-cn', 'qwen3.7-plus', 'Qwen3.7 Plus', { efforts: [], contextWindow: 1_000_000, maxOutput: 65_536, vision: true, reasoning: true }),
    m('qwen-cn', 'qwen3-coder-plus', 'Qwen3 Coder Plus', { efforts: [], contextWindow: 1_000_000, maxOutput: 65_536, reasoning: false })
  ]),
  hosted(
    'qwen-token-plan-cn',
    'Qwen Token Plan (China)',
    'regional',
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    "Alibaba Cloud's coding plan (China)",
    'https://bailian.console.aliyun.com/?tab=model#/api-key',
    [
      m('qwen-token-plan-cn', 'qwen3.8-max', 'Qwen3.8 Max', { efforts: ['light', 'medium', 'extra-high'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
      m('qwen-token-plan-cn', 'qwen3.8-flash', 'Qwen3.8 Flash', { efforts: ['light', 'medium', 'extra-high'], contextWindow: 1_000_000, maxOutput: 131_072, vision: true, reasoning: true }),
      m('qwen-token-plan-cn', 'qwen3.7-max', 'Qwen3.7 Max', { efforts: [], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
      m('qwen-token-plan-cn', 'qwen3.7-plus', 'Qwen3.7 Plus', { efforts: [], contextWindow: 1_000_000, maxOutput: 65_536, vision: true, reasoning: true }),
      m('qwen-token-plan-cn', 'qwen3.6-plus', 'Qwen3.6 Plus', { efforts: [], contextWindow: 1_000_000, maxOutput: 65_536, vision: true, reasoning: true }),
      m('qwen-token-plan-cn', 'deepseek-v4-pro', 'DeepSeek V4 Pro', { efforts: ['high', 'ultra'], contextWindow: 1_000_000, maxOutput: 384_000, reasoning: true }),
      m('qwen-token-plan-cn', 'glm-5.2', 'GLM-5.2', { efforts: ['high', 'ultra'], contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true }),
      m('qwen-token-plan-cn', 'kimi-k2.7-code', 'Kimi K2.7 Code', { efforts: [], contextWindow: 262_144, maxOutput: 262_144, vision: true, reasoning: true })
    ]
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
    models: [
      m('minimax-cn', 'MiniMax-M3', 'MiniMax-M3', { efforts: OPENAI_EFFORTS, contextWindow: 1_048_576, maxOutput: 512_000, vision: true, reasoning: true }),
      m('minimax-cn', 'MiniMax-M2.7', 'MiniMax-M2.7', { efforts: OPENAI_EFFORTS, contextWindow: 204_800, maxOutput: 131_072, reasoning: true }),
      m('minimax-cn', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.7-highspeed', { efforts: OPENAI_EFFORTS, contextWindow: 204_800, maxOutput: 131_072, reasoning: true })
    ]
  },
  hosted('xiaomi-token-plan-cn', 'MiMo Token Plan (China)', 'regional', 'https://token-plan-cn.xiaomimimo.com/v1', "Xiaomi's MiMo subscription (China)", 'https://platform.xiaomimimo.com', [
    m('xiaomi-token-plan-cn', 'mimo-v2.5-pro', 'MiMo-V2.5-Pro', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true }),
    m('xiaomi-token-plan-cn', 'mimo-v2.5', 'MiMo-V2.5', { efforts: [], contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true })
  ])
]

/**
 * What the settings page needs beyond the provider itself: base-URL templates
 * with the fields to fill in, whether a listing exists, sign-in labels.
 */
export const PROVIDER_META: Record<string, ProviderMeta> = {
  'openai-codex': { id: 'openai-codex', listsModels: false, signInLabel: 'Sign in with ChatGPT' },
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
