import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectChoice } from '@shared/connectApps'
import { exists, exportLines, type ConnectContext, type Connector } from '../connector'

/**
 * Apps Eaon can't (or shouldn't) write settings for:
 *
 * - Copilot CLI and Poolside take a custom endpoint only from environment
 *   variables, so connecting saves the choice and Eaon opens them in a
 *   terminal with the variables set.
 * - Terminal opens a shell with the OpenAI and Anthropic variables most
 *   tools read.
 * - Cline (a VS Code extension) and DeepSeek Harness (its web UI writes a
 *   Cordis patch file whose entries replace each other whole) are set up by
 *   hand from the steps and values Eaon shows.
 */

/** A launch app is "connected" once its choice is saved; nothing on disk to inspect. */
function saved(choice: ConnectChoice): { record: { model: string; smallModel: string | null; connectedAt: number; keys: Record<string, never> }; written: [] } {
  return { record: { model: choice.model, smallModel: choice.smallModel ?? null, connectedAt: Date.now(), keys: {} }, written: [] }
}

function copilotEnv(ctx: ConnectContext, choice: ConnectChoice): Record<string, string> {
  return {
    COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_BASE_URL: ctx.info.openaiBaseUrl,
    COPILOT_PROVIDER_API_KEY: ctx.info.token,
    COPILOT_MODEL: choice.model
  }
}

/** GitHub Copilot CLI's bring-your-own-model mode (COPILOT_PROVIDER_* variables). */
export const copilotCli: Connector = {
  id: 'copilot-cli',
  name: 'Copilot CLI',
  kind: 'launch',
  blurb: 'Open Copilot CLI with your Eaon models.',
  hasSmallModel: false,
  installHint: 'npm install -g @github/copilot',
  note: 'Copilot CLI reads these settings only when it starts, so open it from here (or export them yourself).',
  files: () => [],
  installed: (ctx) => Boolean(ctx.which('copilot')),
  connect: (_ctx, choice) => saved(choice),
  launch: (ctx, choice) => ({ env: copilotEnv(ctx, choice), command: 'copilot' }),
  manual: (ctx, choice) => ['Set these, then run `copilot`:', exportLines(copilotEnv(ctx, choice), ctx.platform)].join('\n')
}

function poolsideEnv(ctx: ConnectContext, choice: ConnectChoice): Record<string, string> {
  return {
    // pool's docs give a base without /v1 (http://127.0.0.1:8080); the gateway answers with or without it.
    POOLSIDE_STANDALONE_BASE_URL: ctx.info.anthropicBaseUrl,
    POOLSIDE_API_KEY: ctx.info.token,
    POOLSIDE_STANDALONE_MODEL: choice.model
  }
}

/** Poolside's `pool` in standalone mode against any OpenAI-compatible endpoint. */
export const poolside: Connector = {
  id: 'poolside',
  name: 'Poolside',
  kind: 'launch',
  blurb: 'Open Poolside\'s pool with your Eaon models.',
  hasSmallModel: false,
  installHint: 'See docs.poolside.ai/cli/install',
  note: 'pool reads these settings when it starts, so open it from here (or export them yourself).',
  files: () => [],
  installed: (ctx) => Boolean(ctx.which('pool')),
  connect: (_ctx, choice) => saved(choice),
  launch: (ctx, choice) => ({ env: poolsideEnv(ctx, choice), command: 'pool' }),
  manual: (ctx, choice) => ['Set these, then run `pool`:', exportLines(poolsideEnv(ctx, choice), ctx.platform)].join('\n')
}

function terminalEnv(ctx: ConnectContext, choice: ConnectChoice): Record<string, string> {
  return {
    OPENAI_BASE_URL: ctx.info.openaiBaseUrl,
    OPENAI_API_KEY: ctx.info.token,
    OPENAI_MODEL: choice.model,
    ANTHROPIC_BASE_URL: ctx.info.anthropicBaseUrl,
    ANTHROPIC_AUTH_TOKEN: ctx.info.token,
    ANTHROPIC_MODEL: choice.model
  }
}

export const terminal: Connector = {
  id: 'terminal',
  name: 'Terminal',
  kind: 'launch',
  blurb: 'A shell where OpenAI and Anthropic tools use your Eaon models.',
  hasSmallModel: false,
  note: 'Tools started from that shell use Eaon; other terminals are unchanged.',
  files: () => [],
  installed: () => true,
  connect: (_ctx, choice) => saved(choice),
  launch: (ctx, choice) => ({ env: terminalEnv(ctx, choice), command: null }),
  manual: (ctx, choice) => exportLines(terminalEnv(ctx, choice), ctx.platform)
}

/** Cline installed in VS Code, Cursor, Windsurf or VSCodium (its extension id is saoudrizwan.claude-dev). */
function clineInstalled(ctx: ConnectContext): boolean {
  for (const dir of ['.vscode', '.cursor', '.windsurf', '.vscode-oss']) {
    try {
      if (readdirSync(join(ctx.home, dir, 'extensions')).some((name) => name.startsWith('saoudrizwan.claude-dev-'))) return true
    } catch {
      /* not installed there */
    }
  }
  return Boolean(ctx.which('cline'))
}

export const cline: Connector = {
  id: 'cline',
  name: 'Cline',
  kind: 'manual',
  blurb: 'Use your Eaon models in Cline.',
  hasSmallModel: false,
  installHint: 'code --install-extension saoudrizwan.claude-dev',
  note: 'Cline keeps its settings inside your editor, so Eaon can\'t set them for you. Paste these in Cline\'s settings.',
  files: () => [],
  installed: (ctx) => clineInstalled(ctx),
  manual: (ctx, choice) =>
    [
      'In Cline, open Settings → API Configuration and set:',
      'API Provider: OpenAI Compatible',
      `Base URL: ${ctx.info.openaiBaseUrl}`,
      `API Key: ${ctx.info.token}`,
      `Model ID: ${choice.model}`,
      'Context Window: at least 32,000'
    ].join('\n')
}

export const deepseekHarness: Connector = {
  id: 'deepseek-harness',
  name: 'DeepSeek Harness',
  kind: 'manual',
  blurb: 'Use your Eaon models in DeepSeek Harness.',
  hasSmallModel: false,
  installHint: 'npm install -g @deepseek-ai/dsh',
  note: 'DeepSeek Harness saves providers from its own Models page, so Eaon gives you the values to enter there.',
  files: () => [],
  installed: (ctx) => Boolean(ctx.which('dsh')) || exists(join(ctx.home, '.dsh')),
  manual: (ctx, choice) =>
    [
      'In DeepSeek Harness, open Settings → Models → Add model provider → Custom model API:',
      'Provider ID: eaon',
      'Display name: Eaon',
      `Base URL: ${ctx.info.openaiBaseUrl}`,
      'API protocol: OpenAI Chat Completions',
      `API key: ${ctx.info.token}`,
      `Model: ${choice.model}`,
      '',
      'Then pick it in the model picker; that also makes it the default for new sessions.'
    ].join('\n')
}
