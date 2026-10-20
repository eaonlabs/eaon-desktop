/**
 * Settings → Agent providers: the coding CLIs the ADE runs, what is on this
 * computer, and how they are kept up to date (main/features/agentProviders.ts).
 */

export interface AgentTool {
  id: string
  label: string
  /** The command it runs as. */
  bin: string | null
  /** Where that command is, when it's on PATH. */
  path: string | null
  installed: boolean
  version: string | null
  /** The newest version npm has, for one installed with npm. */
  latest: string | null
  /** Installed with npm and older than `latest`: npm can update it. */
  updatable: boolean
  installHint: string | null
  guide: string | null
  /** One of the other CLIs, offered only once installed. */
  other: boolean
}

export interface AgentToolsState {
  tools: AgentTool[]
  checking: boolean
  at: number
  /** The tool being updated now. */
  updating: string | null
  error: string | null
}

/** The npm package each CLI installs from, for those npm installs. */
export const AGENT_PACKAGES: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  opencode: 'opencode-ai',
  gemini: '@google/gemini-cli',
  copilot: '@github/copilot',
  qwen: '@qwen-code/qwen-code',
  amp: '@sourcegraph/amp',
  auggie: '@augmentcode/auggie',
  codebuff: 'codebuff'
}

/** Where each CLI's own setup guide is. */
export const AGENT_GUIDES: Record<string, string> = {
  claude: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  codex: 'https://github.com/openai/codex#quickstart',
  antigravity: 'https://antigravity.google',
  opencode: 'https://opencode.ai/docs',
  cursor: 'https://docs.cursor.com/en/cli/overview',
  gemini: 'https://github.com/google-gemini/gemini-cli#quickstart',
  copilot: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
  qwen: 'https://github.com/QwenLM/qwen-code',
  amp: 'https://ampcode.com/manual',
  droid: 'https://docs.factory.ai/cli/getting-started/quickstart',
  kimi: 'https://github.com/MoonshotAI/kimi-cli',
  goose: 'https://block.github.io/goose/docs/getting-started/installation',
  aider: 'https://aider.chat/docs/install.html',
  crush: 'https://github.com/charmbracelet/crush',
  openhands: 'https://docs.all-hands.dev',
  cline: 'https://docs.cline.bot',
  warp: 'https://docs.warp.dev'
}

/** A CLI's limits on Settings → Usage & limits, by the agent id: how "Connected" is known. */
export const AGENT_USAGE_ID: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor',
  opencode: 'opencode',
  grok: 'grok',
  droid: 'droid',
  copilot: 'copilot',
  antigravity: 'antigravity'
}
