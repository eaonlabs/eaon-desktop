import type { EngineId } from '@shared/engines'
import { cachedModels, cachedStatuses, disposeEngines, engine, onEnginesChanged, refreshEngines } from '../engines'
import type { Feature } from './types'

/**
 * Agent engines (Eaon's own loop, Codex…): their status, sign-in and models
 * for Settings and every model picker. Channels are `engines:*`; `changed`
 * is pushed whenever a status or model list moves.
 */

/** How often engines are checked again in the background. */
const REFRESH_EVERY_MS = 30 * 60_000
/** First check after launch, once the login shell's PATH has settled. */
const FIRST_CHECK_MS = 5_000

let timer: ReturnType<typeof setInterval> | null = null
let first: ReturnType<typeof setTimeout> | null = null

const isEngineId = (value: unknown): value is EngineId => typeof value === 'string' && engine(value as EngineId) !== undefined

export const enginesFeature: Feature = {
  id: 'engines',
  register: ({ ipcMain, send }) => {
    onEnginesChanged(() => send('engines:changed'))
    ipcMain.handle('engines:status', () => cachedStatuses())
    ipcMain.handle('engines:refresh', (_e, id?: unknown, force?: unknown) =>
      refreshEngines({ ...(isEngineId(id) ? { id } : {}), force: force === true })
    )
    ipcMain.handle('engines:models', (_e, id: unknown) => (isEngineId(id) ? cachedModels(id) : null))
    ipcMain.handle('engines:login', async (_e, id: unknown) => {
      if (!isEngineId(id)) throw new Error('Unknown engine.')
      const adapter = engine(id)
      if (!adapter?.login) throw new Error('This engine signs in on its own.')
      await adapter.login()
      return refreshEngines({ id, force: true })
    })
    ipcMain.handle('engines:cancel-login', async (_e, id: unknown) => {
      if (isEngineId(id)) await engine(id)?.cancelLogin?.()
    })
    first = setTimeout(() => void refreshEngines(), FIRST_CHECK_MS)
    first.unref?.()
    timer = setInterval(() => void refreshEngines(), REFRESH_EVERY_MS)
    timer.unref?.()
  },
  dispose: () => {
    if (first) clearTimeout(first)
    if (timer) clearInterval(timer)
    first = null
    timer = null
  },
  shutdown: () => disposeEngines()
}
