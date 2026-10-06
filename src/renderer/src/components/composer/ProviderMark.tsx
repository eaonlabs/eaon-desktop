import type { JSX } from 'react'

/**
 * A provider's bare mark, without the tile its logo is drawn on elsewhere:
 * the model picker's tab row shows marks on the panel itself. The files in
 * assets/providers/marks are the logos with their tile keyed out. A
 * single-colour mark is stored white and darkened in light mode by CSS
 * (`.pmark[data-mono]`); a coloured one is shown as it is.
 */

const files = import.meta.glob('../../assets/providers/marks/*.{png,svg}', { eager: true, query: '?url', import: 'default' }) as Record<
  string,
  string
>

const URLS: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.split('/').pop()!.replace(/\.(png|svg)$/, ''), url])
)

/** Marks stored as white glyphs (the logo is one colour). */
const MONO = new Set([
  'baseten',
  'codex',
  'githubcopilot',
  'groq',
  'lmstudio',
  'ollama',
  'openai',
  'opencode',
  'vercel',
  'xai',
  'xiaomimimo',
  'zai'
])

/** Provider id → mark file, mirroring BRAND_ICONS in icons/brand.tsx. */
const MARK: Record<string, string> = {
  openai: 'openai',
  'openai-codex': 'openai',
  chatgpt: 'openai',
  'github-copilot': 'githubcopilot',
  azure: 'azure',
  anthropic: 'anthropic',
  openrouter: 'openrouter',
  mistral: 'mistral',
  groq: 'groq',
  xai: 'xai',
  gemini: 'gemini',
  minimax: 'minimax',
  'minimax-cn': 'minimax',
  huggingface: 'huggingface',
  'nvidia-nim': 'nvidia',
  'llama-cpp': 'llama-cpp',
  ollama: 'ollama',
  deepseek: 'deepseek',
  cohere: 'cohere',
  perplexity: 'perplexity',
  poe: 'poe',
  cerebras: 'cerebras',
  fireworks: 'fireworks',
  together: 'together',
  deepinfra: 'deepinfra',
  novita: 'novita',
  sambanova: 'sambanova',
  moonshot: 'kimi',
  'moonshot-cn': 'kimi',
  'kimi-coding': 'kimi',
  qwen: 'qwen',
  'qwen-cn': 'qwen',
  'qwen-token-plan': 'qwen',
  'qwen-token-plan-cn': 'qwen',
  zai: 'zai',
  'zai-coding': 'zai',
  'zai-cn': 'zhipu',
  'zai-coding-cn': 'zhipu',
  xiaomi: 'xiaomimimo',
  'xiaomi-token-plan': 'xiaomimimo',
  'xiaomi-token-plan-cn': 'xiaomimimo',
  opencode: 'opencode',
  'opencode-go': 'opencode',
  vercel: 'vercel',
  baseten: 'baseten',
  nebius: 'nebius',
  'cloudflare-workers-ai': 'workersai',
  'cloudflare-ai-gateway': 'cloudflare',
  'amazon-bedrock': 'bedrock',
  'lm-studio': 'lmstudio',
  vllm: 'vllm',
  jan: 'jan',
  eaon: 'eaon'
}

/** Which mark file a provider uses, so two providers sharing one can be told apart. */
export function markKey(providerId: string): string {
  return MARK[providerId] ?? `monogram:${providerId}`
}

export function ProviderMark({ providerId, name, size = 16 }: { providerId: string; name?: string; size?: number }): JSX.Element {
  const file = MARK[providerId]
  const url = file ? URLS[file] : undefined
  if (url) {
    return <img className="pmark" data-mono={MONO.has(file) || undefined} src={url} width={size} height={size} alt="" draggable={false} />
  }
  // No logo shipped: the provider's first letter in a ring, sized like a mark.
  return (
    <span className="pmark pmark--letter" style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }} aria-hidden="true">
      {(name ?? providerId).trim().charAt(0).toUpperCase()}
    </span>
  )
}
