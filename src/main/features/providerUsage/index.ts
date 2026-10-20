import type { ProviderUsage, ProviderUsageState } from '@shared/providerUsage'
import { onCliLogsChange } from '../usage/cliLogs'
import type { Feature } from '../types'
import { readCopilot, readDeepSeek, readOpenRouter } from './eaonKeys'
import { readCursor, readDevin, readGrok, readOpencode, readSignedInOnly } from './readers'
import { cliModelTokens, providerTokens } from './tokens'

/**
 * Settings → Usage & limits, and the sidebar's rings: every signed-in coding
 * tool's limits but Claude Code's and Codex's (the cliAccounts feature reads
 * those), and recent token totals for all of them. Read on demand and kept
 * for a few minutes, so opening the page or a ring's card doesn't ask every
 * provider again. Channels are `provider-usage:*`.
 */

const FRESH_MS = 3 * 60_000

let state: ProviderUsageState = { providers: [], tokens: {}, loading: false, at: 0 }
let running: Promise<ProviderUsageState> | null = null
let notify: (state: ProviderUsageState) => void = () => {}

/** Every reader at once; one that throws is dropped rather than failing the rest. */
async function readAll(): Promise<ProviderUsage[]> {
  const settled = await Promise.allSettled([readCursor(), readCopilot(), readGrok(), readOpencode(), readDevin(), readOpenRouter(), readDeepSeek(), readSignedInOnly()])
  const out: ProviderUsage[] = []
  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value) continue
    if (Array.isArray(result.value)) out.push(...result.value)
    else out.push(result.value)
  }
  return out
}

export function refreshProviderUsage(force = false): Promise<ProviderUsageState> {
  if (!force && state.at && Date.now() - state.at < FRESH_MS) return Promise.resolve(state)
  if (running) return running
  state = { ...state, loading: true }
  notify(state)
  running = (async () => {
    const [providers, tokens] = await Promise.all([readAll(), providerTokens().catch(() => ({}))])
    state = { providers, tokens, loading: false, at: Date.now() }
    notify(state)
    return state
  })().finally(() => {
    running = null
  })
  return running
}

export const providerUsageFeature: Feature = {
  id: 'provider-usage',
  register: ({ ipcMain, send }) => {
    notify = (next) => send('provider-usage:changed', next)
    ipcMain.handle('provider-usage:state', () => refreshProviderUsage(false))
    ipcMain.handle('provider-usage:refresh', () => refreshProviderUsage(true))
    ipcMain.handle('provider-usage:cli-models', () => cliModelTokens(90))
    // New CLI logs read: the token totals follow without asking every provider again.
    onCliLogsChange(() => {
      void providerTokens().then((tokens) => {
        state = { ...state, tokens }
        notify(state)
      })
    })
  }
}
