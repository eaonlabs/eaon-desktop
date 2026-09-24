/**
 * Eaon's saved API keys, handed to Eaon Code as the environment variables it
 * reads (`getApiKeyEnvVars()` in its packages/ai/src/env-api-keys.ts).
 *
 * Keys are Eaon provider ids; values are Eaon Code's variable names. Where the
 * two apps name a provider differently (Eaon's `gemini` is Eaon Code's
 * `google`, `nvidia-nim` is `nvidia`) the variable is what joins them.
 *
 * Deliberately absent: Azure, whose Eaon Code provider also needs a resource
 * name and deployment map that a key alone does not give it — passing only the
 * key would list Azure models that then fail on first use. Local runtimes
 * (Ollama, llama.cpp) have no key; Eaon Code reaches them through its own
 * models.json.
 */
export const KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  google: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  huggingface: 'HF_TOKEN',
  'nvidia-nim': 'NVIDIA_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  zai: 'ZAI_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY'
}

/**
 * The child's environment: ours, plus shared keys when enabled. A variable
 * already set in the environment wins — someone who exported their own key
 * meant it — and so does Eaon Code's own auth.json, which it prefers over the
 * environment anyway.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  shareKeys: boolean,
  getKey: (providerId: string) => string | undefined
): { env: NodeJS.ProcessEnv; shared: string[] } {
  const env: NodeJS.ProcessEnv = { ...base }
  const shared: string[] = []
  if (shareKeys) {
    for (const [providerId, variable] of Object.entries(KEY_ENV)) {
      if (env[variable]) continue
      const key = getKey(providerId)?.trim()
      if (!key) continue
      env[variable] = key
      shared.push(variable)
    }
  }
  // Eaon Code's TUI colour and pager detection have nothing to talk to here.
  env.TERM = env.TERM || 'dumb'
  return { env, shared: [...new Set(shared)] }
}
