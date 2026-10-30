import type { JSX } from 'react'
import { LogoMark } from '../../icons/customLogo'
import { providerLogoNow, useProviderLogo } from '../../state/providerLogos'
import type { CliEngineId, EngineId } from '@shared/engines'

/** Each agent CLI's logo key for ProviderMark: plain `gemini` is the Gemini API provider's. */
// Claude's is Anthropic's mark: the Agent SDK's branding rules keep apps built on it from looking like Claude Code.
export const ENGINE_MARK: Record<CliEngineId, string> = { codex: 'codex', claude: 'anthropic', copilot: 'github-copilot', gemini: 'gemini-cli' }

/** The logo key for a model picker row: its engine's own for an agent CLI's model, else its provider's. */
export const optionMark = (option: { engine: EngineId; groupId: string }): string => (option.engine === 'native' ? option.groupId : ENGINE_MARK[option.engine])

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
  'cursor',
  'droid',
  'eaon',
  'grok',
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
  // The agent CLIs as engines (ENGINE_MARK): their tabs in Chat's model picker.
  codex: 'codex',
  'github-copilot': 'githubcopilot',
  'gemini-cli': 'geminicli',
  azure: 'azure',
  anthropic: 'anthropic',
  'claude-agent': 'anthropic',
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
  // Eaon's own: Eaon Lite, Eaon Event and the models on this computer share its mark.
  eaon: 'eaon',
  'eaon-gateway': 'eaon',
  'eaon-free': 'eaon',
  'eaon-local': 'eaon',
  // Pi, the coding agent (Usage & limits): its own mark from pi.dev.
  pi: 'pi',
  // The coding CLIs whose own usage Settings → Usage counts (`cli:<tool>`, as the usage summary names them).
  'cli:claude-code': 'claudecode',
  'cli:claude-desktop': 'anthropic',
  'cli:codex': 'codex',
  'cli:cursor': 'cursor',
  'cli:gemini-cli': 'geminicli',
  'cli:grok': 'grok',
  'cli:qwen-code': 'qwen',
  'cli:copilot-cli': 'githubcopilot',
  'cli:opencode': 'opencode',
  'cli:amp': 'amp',
  'cli:droid': 'droid',
  'cli:kimi-cli': 'kimi'
}

/** Which mark file a provider uses, so two providers sharing one can be told apart. */
export function markKey(providerId: string): string {
  if (providerLogoNow(providerId)) return `logo:${providerId}`
  return MARK[providerId] ?? `monogram:${providerId}`
}

export function ProviderMark({ providerId, name, size = 16 }: { providerId: string; name?: string; size?: number }): JSX.Element {
  // The person's own logo, or one found from a custom provider's base URL, comes first.
  const custom = useProviderLogo(providerId)
  if (custom) return <LogoMark logo={custom} size={size} />
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
