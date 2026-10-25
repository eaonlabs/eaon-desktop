import type { CliEngineId } from '@shared/engines'

/**
 * The agent CLIs Eaon drives over the Agent Client Protocol: each one the
 * user installed and signed in to themselves, run as it is, through the ACP
 * mode its maker documents for editors and other apps. Eaon never reads
 * their sign-in, calls their services itself, or adds to their prompts.
 *
 * An agent belongs here only when its maker documents ACP for other apps:
 * GitHub's Copilot CLI ACP server page lists "custom frontends", and Gemini
 * CLI is Google's own reference ACP agent (its Zed integration). Claude Code
 * is not here: Anthropic's Agent SDK docs say other apps may not offer
 * claude.ai login or its rate limits without Anthropic's approval.
 */

export type AcpEngineId = Extract<CliEngineId, 'copilot' | 'gemini'>

export interface AcpAgentSpec {
  id: AcpEngineId
  name: string
  /** Executable names to look for on PATH, first match wins. */
  bins: string[]
  /** What starts its ACP mode. */
  args: string[]
  /**
   * The command-line flag that picks the model. The ACP session can't pick
   * one on either CLI yet (Copilot fixes its options when it starts), so each
   * session's process is started with the model it should use.
   */
  modelFlag: string
  /** Lists the models from the CLI's own documented help, when the session doesn't report them. */
  modelsCommand?: { args: string[]; parse: (text: string) => string[] }
  /**
   * Asks the CLI whether the account's plan includes a model: the slash
   * command `/<command> <model>`, which the CLI answers itself, so nothing
   * reaches a model, the plan's usage or the user's history. Sent only when
   * the session lists the command. `refused` matches the answer when the plan
   * doesn't include the model; `autoOnly` when it offers no choice of model at
   * all. The CLI's help lists every model it knows, whatever the plan.
   */
  planCheck?: { command: string; refused: RegExp; autoOnly: RegExp }
  /** How to sign in, in its own terminal, when ACP offers only a terminal method. */
  loginCommand: string
  install: string
  /** The maker's page on ACP, for Settings. */
  docs: string
}

/**
 * The models `copilot help config` lists under `model`: each one a `- "id"`
 * line after the `` `model`: `` heading, up to the next setting.
 */
export function parseCopilotModels(text: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^\s*`model`:/.test(line))
  if (start < 0) return []
  const models: string[] = []
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*-\s*"([^"]+)"\s*$/.exec(line)
    if (!match) break
    models.push(match[1])
  }
  return models
}

export const ACP_AGENTS: Record<AcpEngineId, AcpAgentSpec> = {
  copilot: {
    id: 'copilot',
    name: 'GitHub Copilot',
    bins: ['copilot'],
    args: ['--acp', '--stdio'],
    modelFlag: '--model',
    modelsCommand: { args: ['help', 'config'], parse: parseCopilotModels },
    // `/model <id>` in ACP: 'Model "gpt-5-mini" can't be selected — only Auto mode is available on your plan.'
    // A model the plan lacks still runs, on Auto, so Eaon has to ask.
    planCheck: {
      command: 'model',
      refused: /can[’']?t be selected|not available|isn[’']?t available|not enabled|upgrade your plan/i,
      autoOnly: /only auto(?: mode)? is available/i
    },
    loginCommand: 'copilot login',
    install: 'npm install -g @github/copilot',
    docs: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server'
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    bins: ['gemini'],
    args: ['--acp'],
    modelFlag: '--model',
    loginCommand: 'gemini',
    install: 'npm install -g @google/gemini-cli',
    docs: 'https://github.com/google-gemini/gemini-cli'
  }
}

/** "claude-sonnet-5.5" → "Claude Sonnet 5.5", "gpt-5.4-mini" → "GPT-5.4 Mini": readable without a catalog. */
export function modelLabel(id: string): string {
  const words = id.split('-')
  const out: string[] = []
  for (const word of words) {
    const prev = out[out.length - 1]
    if (/^\d/.test(word) && prev && /^(GPT|o)$/i.test(prev)) out[out.length - 1] = `${prev}-${word}`
    else if (/^(gpt|mai)$/i.test(word)) out.push(word.toUpperCase())
    else out.push(/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1))
  }
  return out.join(' ')
}
