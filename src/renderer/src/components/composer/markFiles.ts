/**
 * Which file in assets/providers/marks draws each provider's bare mark
 * (ProviderMark.tsx), apart from the component so a test can check that
 * every provider Eaon lists has one (test/provider-marks.test.ts).
 */

/** Marks stored as white glyphs (the logo is one colour). */
export const MONO = new Set([
  'baseten',
  // Codex's mark is OpenAI's knot, in white (assets/providers/codex.svg is it on a black tile).
  'codex',
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
export const MARK: Record<string, string> = {
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
  // The other coding agents Usage & limits lists: one plain mark of Eaon's own for them.
  antigravity: 'generic-agent',
  devin: 'generic-agent',
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
