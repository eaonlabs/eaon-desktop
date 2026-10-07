import type { Feature } from './types'
import { createRemote, type RemoteController } from '../remote'
import { workersService } from './workers'

/**
 * Remote devices: the Workers, for a phone on the user's network
 * (docs/remote-api.md). Off until the user turns it on in Settings → Remote
 * devices, which starts a server that wants its own key on every request. The
 * server, its routes and the Bonjour announcement are in `main/remote/`; this
 * is the glue to the app: it follows the workers service, answers the settings
 * page over IPC and ends everything on quit.
 */

let controller: RemoteController | null = null

export const remoteFeature: Feature = {
  id: 'remote',
  register: (ctx) => {
    // After the workers feature, whose engine and hub this follows.
    const workers = workersService()
    if (!workers) return
    const remote = createRemote({
      hub: workers.hub,
      engine: workers.engine,
      remove: workers.remove,
      onStatus: (status) => ctx.send('remote:status', status)
    })
    controller = remote

    const { ipcMain } = ctx
    ipcMain.handle('remote:info', () => remote.info())
    ipcMain.handle('remote:set-enabled', (_e, enabled: boolean) => remote.setEnabled(enabled === true))
    ipcMain.handle('remote:set-port', (_e, port: number) => remote.setPort(Number(port)))
    ipcMain.handle('remote:reset-token', () => remote.resetToken())

    // Not awaited: a port that is taken is a status for the page, not a reason to hold up launch.
    void remote.launch().catch((error) => console.error('[remote] could not start:', error instanceof Error ? error.message : error))
  },
  dispose: () => controller?.dispose(),
  shutdown: () => controller?.stop() ?? Promise.resolve()
}
