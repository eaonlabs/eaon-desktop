/**
 * Link accounts: one place to bring the user's AI accounts into Eaon, each
 * through the route its provider allows. Eaon may check which AI apps are
 * installed, to put those providers first, but it never reads another app's
 * data, sessions or keychain items: borrowing a sign-in another app holds is
 * what gets accounts suspended (see the brain note "Importing accounts from
 * other AI desktop apps: not ban-safe").
 */

/** Apps Eaon looks for. Presence only: an app bundle or a program on PATH. */
export type DetectedAppId =
  | 'chatgpt'
  | 'codex'
  | 'claude'
  | 'claude-code'
  | 'grok'
  | 'perplexity'
  | 'gemini-cli'
  | 'ollama'
  | 'lm-studio'

export interface DetectedApp {
  id: DetectedAppId
  name: string
  installed: boolean
}

/**
 * How a provider links:
 * - `signin`: the provider's own sanctioned browser sign-in (Sign in with
 *   ChatGPT, OpenRouter, Hugging Face, Poe);
 * - `key`: an API key from the provider's console;
 * - `local`: a runtime on this computer, turned on with no account at all.
 */
export type LinkMethod = 'signin' | 'key' | 'local'

export interface LinkTarget {
  /** Eaon provider id. */
  providerId: string
  method: LinkMethod
  /** Installed apps that make this provider worth putting first. */
  apps: DetectedAppId[]
  /** Shown under the name: what linking gives the user. */
  blurb: string
  /** Why it's done this way, when people expect otherwise (Claude, Grok, Gemini). */
  why?: string
}

/** In display order; detected ones are moved to the top. */
export const LINK_TARGETS: LinkTarget[] = [
  { providerId: 'chatgpt', method: 'signin', apps: ['chatgpt', 'codex'], blurb: 'Your ChatGPT plan, through OpenAI\'s official Sign in with ChatGPT.' },
  {
    providerId: 'anthropic',
    method: 'key',
    apps: ['claude', 'claude-code'],
    blurb: 'Claude models with an API key from the Claude Console.',
    why: 'Anthropic doesn\'t allow other apps to sign in with a Claude plan, so Eaon uses an API key. Your plan keeps working in Claude Code, which you can run in the ADE.'
  },
  {
    providerId: 'xai',
    method: 'key',
    apps: ['grok'],
    blurb: 'Grok models with an API key from the xAI console.',
    why: 'xAI only lets its partners sign in with a Grok account, so Eaon uses an API key.'
  },
  {
    providerId: 'gemini',
    method: 'key',
    apps: ['gemini-cli'],
    blurb: 'Gemini models with a key from Google AI Studio.',
    why: 'Google suspends accounts whose Gemini CLI sign-in is reused by other apps, so Eaon uses an API key.'
  },
  { providerId: 'openrouter', method: 'signin', apps: [], blurb: 'Hundreds of models with one account. Signing in creates a key for Eaon.' },
  { providerId: 'perplexity', method: 'key', apps: ['perplexity'], blurb: 'Sonar models with an API key.' },
  { providerId: 'openai', method: 'key', apps: [], blurb: 'OpenAI\'s API, billed per use, with a key from the OpenAI platform.' },
  { providerId: 'deepseek', method: 'key', apps: [], blurb: 'DeepSeek models with an API key.' },
  { providerId: 'mistral', method: 'key', apps: [], blurb: 'Mistral models with an API key.' },
  { providerId: 'groq', method: 'key', apps: [], blurb: 'Fast open models with an API key.' },
  { providerId: 'huggingface', method: 'signin', apps: [], blurb: 'Open models on Hugging Face\'s inference providers.' },
  { providerId: 'poe', method: 'signin', apps: [], blurb: 'Models on Poe. Signing in creates a key for Eaon.' },
  { providerId: 'ollama', method: 'local', apps: ['ollama'], blurb: 'Models running in Ollama on this computer. No account needed.' },
  { providerId: 'lm-studio', method: 'local', apps: ['lm-studio'], blurb: 'Models running in LM Studio on this computer. No account needed.' }
]
