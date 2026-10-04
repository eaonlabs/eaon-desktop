import type { GatewayDefaults } from '@shared/gateway'
import { ensureGatewayRunning, gatewayInfo, setGatewayDefaults } from '../gateway'
import type { Feature } from './types'

/** The gateway's IPC: what the Connect apps page reads, and starting the server for it. */
export const gatewayFeature: Feature = {
  id: 'gateway',
  register: ({ ipcMain }) => {
    ipcMain.handle('gateway:info', () => gatewayInfo())
    ipcMain.handle('gateway:start', () => ensureGatewayRunning())
    ipcMain.handle('gateway:set-defaults', (_e, defaults: GatewayDefaults) => setGatewayDefaults(defaults ?? {}))
  }
}
