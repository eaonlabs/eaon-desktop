import type { ModelInfo, Provider } from '@shared/types'
import { ALL_EFFORTS, OPENAI_EFFORTS } from './models'

/**
 * Every provider the app ships knowing about. Users can disable any of them
 * and add their own OpenAI-compatible endpoints on top (see `index.ts`).
 *
 * Seed model lists are a starting point only: once a key is added the list is
 * refreshed from the provider's own `/models`, so a new release shows up
 * without an app update. Seeds exist so the picker is useful before that
 * first refresh, and they carry capabilities (context window, output cap,
 * effort) that `/models` endpoints rarely report.
 */

export type SeedProvider = Omit<Provider, 'hasKey' | 'local' | 'fallbackCount' | 'signedIn'> & { local?: boolean }

const m = (providerId: string, id: string, label: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  label,
  providerId,
  tools: true,
  ...extra
})

export const BUILT_IN: SeedProvider[] = [
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
  {
    id: 'llama-cpp',
    name: 'Llama.cpp',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    enabled: true,
    builtIn: true,
    local: true,
    auth: 'none',
    category: 'local',
    description: 'llama-server on port 8080',
    models: []
  },
  {
    id: 'mlx',
    name: 'MLX',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    enabled: true,
    builtIn: true,
    local: true,
    auth: 'none',
    category: 'local',
    description: 'mlx_lm.server on Apple silicon',
    models: []
  },

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
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'frontier',
    description: 'GPT',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      m('openai', 'gpt-5', 'GPT-5', { efforts: OPENAI_EFFORTS, contextWindow: 400_000, vision: true, reasoning: true }),
      m('openai', 'gpt-5-mini', 'GPT-5 mini', { efforts: OPENAI_EFFORTS, contextWindow: 400_000, vision: true, reasoning: true }),
      m('openai', 'gpt-4.1', 'GPT-4.1', { contextWindow: 1_000_000, vision: true }),
      m('openai', 'gpt-4o', 'GPT-4o', { contextWindow: 128_000, vision: true })
    ]
  },
  {
    id: 'gemini',
    name: 'Gemini',
    kind: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'frontier',
    description: 'Google AI Studio',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    models: [
      m('gemini', 'gemini-2.5-pro', 'Gemini 2.5 Pro', { efforts: OPENAI_EFFORTS, contextWindow: 1_000_000, vision: true, reasoning: true }),
      m('gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', { efforts: OPENAI_EFFORTS, contextWindow: 1_000_000, vision: true, reasoning: true })
    ]
  },
  {
    id: 'xai',
    name: 'xAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'frontier',
    description: 'Grok',
    keyUrl: 'https://console.x.ai',
    models: []
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'frontier',
    keyUrl: 'https://console.mistral.ai/api-keys',
    models: []
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    kind: 'openai-compatible',
    baseUrl: 'https://api.minimax.io/v1',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'frontier',
    keyUrl: 'https://www.minimax.io/platform',
    models: []
  },

  // ---- Gateways ----
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'gateway',
    description: 'Hundreds of models behind one key',
    keyUrl: 'https://openrouter.ai/keys',
    headers: { 'HTTP-Referer': 'https://eaon.dev', 'X-Title': 'Eaon' },
    models: []
  },
  {
    id: 'azure',
    name: 'Azure',
    kind: 'openai-compatible',
    baseUrl: '',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'gateway',
    description: 'Azure OpenAI / AI Foundry — paste your resource URL ending in /openai/v1',
    models: []
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    kind: 'openai-compatible',
    baseUrl: 'https://router.huggingface.co/v1',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'gateway',
    keyUrl: 'https://huggingface.co/settings/tokens',
    models: []
  },

  // ---- Fast inference hosts ----
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'inference',
    keyUrl: 'https://console.groq.com/keys',
    models: []
  },
  {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    kind: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    enabled: true,
    builtIn: true,
    auth: 'key',
    category: 'inference',
    keyUrl: 'https://build.nvidia.com',
    models: []
  }
]
