import type { EngineModels, EngineStatus } from '@shared/engines'
import { app } from 'electron'
import type { EngineAdapter } from './types'

/**
 * Eaon's own agent loop as an engine. It is always installed, needs no
 * account of its own and runs on whichever provider and model the turn picks,
 * so its "models" are the providers' (see providers/) and it lists none here.
 * Turns still go through `agent/loop.ts` directly; this adapter exists so
 * engine pickers and settings can treat it like the others.
 */
export const nativeEngine: EngineAdapter = {
  id: 'native',
  async detect(): Promise<EngineStatus> {
    return {
      id: 'native',
      name: 'Eaon',
      installed: true,
      path: null,
      foundIn: 'Built in',
      version: app.getVersion(),
      latestVersion: null,
      updateAvailable: false,
      outdated: false,
      minVersion: null,
      updateHint: null,
      auth: { state: 'not-required', method: null, plan: null },
      error: null,
      checkedAt: Date.now()
    }
  },
  async listModels(): Promise<EngineModels> {
    return { engine: 'native', models: [], retrievedAt: null, staleBecause: null }
  },
  async runTurn() {
    throw new Error('The native engine runs through agent/loop.ts, not runTurn.')
  },
  async dispose() {}
}
