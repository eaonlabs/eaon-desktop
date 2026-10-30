import { join } from 'node:path'
import { app } from 'electron'
import type { EngineModel } from '@shared/engines'
import type { ModelInfo } from '@shared/types'
import { onPath } from '../../shellEnv'
import { cliToolEnv } from '../../features/cliAccounts/current'
import { claudeCodeEnv } from '../../engines/claude/env'
import { claudeCodeStatus } from '../../engines/claude/status'
import { createClaudeAgentAdapter } from './adapter'
import type { QueryFn } from './session'

/** Claude Agent with Electron's side of what it needs: the user's `claude`, environment and sign-in. */

async function claudeEngine() {
  const { engine } = await import('../../engines')
  return engine('claude')
}

export const claudeAgentAdapter = createClaudeAgentAdapter({
  executable: () => onPath('claude'),
  env: () => claudeCodeEnv({ ...process.env, ...cliToolEnv('claude') }, app.getVersion()),
  async auth(force) {
    const status = force || !claudeCodeStatus() ? await (await claudeEngine())?.detect({ force }) : claudeCodeStatus()
    return { auth: status?.auth ?? { state: 'unknown', method: null, plan: null }, checkedAt: status?.checkedAt ?? 0 }
  },
  defaultCwd: () => join(app.getPath('userData'), 'claude-agent'),
  // Loaded on first use: most launches never start Claude.
  query: async () => (await import('@anthropic-ai/claude-agent-sdk')).query as QueryFn
})

/** Claude Code's own model list for this account, as Model providers lists models. */
export function modelsOf(models: EngineModel[], providerId: string): ModelInfo[] {
  return models.map((m) => ({
    // Claude Code's default is a model to pick like the others.
    id: m.id || 'default',
    label: m.id ? m.label : 'Default',
    ...(m.description ? { description: m.description } : {}),
    providerId,
    efforts: m.efforts,
    contextWindow: /\[1m\]/i.test(m.id) ? 1_000_000 : 200_000,
    tools: true,
    vision: true,
    reasoning: true
  }))
}

export async function listClaudeAgentModels(providerId: string): Promise<ModelInfo[]> {
  const engine = await claudeEngine()
  if (!engine) return []
  const list = await engine.listModels({ force: true })
  if (list.staleBecause && !list.retrievedAt) throw new Error(list.staleBecause)
  return modelsOf(list.models, providerId)
}
