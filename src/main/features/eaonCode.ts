import { app, dialog } from 'electron'
import { existsSync } from 'node:fs'
import type { EaonCommand, EaonResult, EaonStartOptions, EaonUiResponse } from '@shared/eaonCode'
import { secrets } from '../secrets'
import { store } from '../store'
import { EaonCodeBridge } from './eaonCode/bridge'
import { installEaonCode } from './eaonCode/install'
import { RecentFolders } from './eaonCode/recents'
import { openInTerminal } from './eaonCode/terminal'
import type { Feature } from './types'

/** Wraps a handler so the renderer gets `{ ok, error }` instead of Electron's prefixed rejection text. */
async function result<T>(work: () => Promise<T> | T): Promise<EaonResult<T>> {
  try {
    return { ok: true, data: await work() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

let bridge: EaonCodeBridge | null = null

/**
 * The Code tab: an Eaon Code session driven over its RPC mode.
 *
 * Every channel is `eaon-code:*`. Requests are invoke/handle; the session's
 * events arrive batched on `eaon-code:events`, process state changes on
 * `eaon-code:process`, and install output on `eaon-code:install-log`.
 * API keys stay in this process: they go into the child's environment and
 * only their variable names ever reach the renderer.
 */
export const eaonCodeFeature: Feature = {
  id: 'eaon-code',
  register: ({ ipcMain, send, getWindow }) => {
    const recents = RecentFolders.at(app.getPath('userData'))
    const active = new EaonCodeBridge({
      getSettings: () => {
        const { binaryPath, shareKeys } = store.getSettings().eaonCode
        return { binaryPath, shareKeys }
      },
      getKey: (providerId) => secrets.get(providerId),
      onEvents: (events) => send('eaon-code:events', events),
      onProcess: (info) => send('eaon-code:process', info)
    })
    bridge = active

    ipcMain.handle('eaon-code:status', (_e, refresh?: boolean) => active.status(Boolean(refresh)))
    ipcMain.handle('eaon-code:process', () => active.processInfo())
    ipcMain.handle('eaon-code:shared-keys', () => active.sharedKeyNames())

    ipcMain.handle('eaon-code:install', () =>
      result(async () => {
        const outcome = await installEaonCode((line) => send('eaon-code:install-log', line))
        const status = await active.status(true)
        if (!outcome.ok) throw new Error(outcome.message)
        if (status.state !== 'ready') throw new Error(status.error ?? "The installer finished, but Eaon Code wasn't found where it puts it.")
        // A path set in Settings still wins over what was just installed; say so rather than look like nothing happened.
        if (status.source !== 'installer') {
          throw new Error(`Installed, but Eaon is still using ${status.binaryPath}, the path set below. Clear it to use the new install.`)
        }
        return status
      })
    )

    ipcMain.handle('eaon-code:start', (_e, cwd: string, options?: EaonStartOptions) =>
      result(async () => {
        const snapshot = await active.start(cwd, options ?? {})
        recents.add(cwd)
        if (store.getSettings().eaonCode.lastCwd !== cwd) {
          store.patchSettings({ eaonCode: { ...store.getSettings().eaonCode, lastCwd: cwd } })
        }
        return snapshot
      })
    )
    ipcMain.handle('eaon-code:stop', () => result(() => active.stop()))
    ipcMain.handle('eaon-code:command', (_e, command: EaonCommand) => result(() => active.command(command)))
    ipcMain.handle('eaon-code:ui-respond', (_e, id: string, response: EaonUiResponse) => active.respondUi(id, response))

    ipcMain.handle('eaon-code:sessions', (_e, cwd: string) => result(() => active.sessions(cwd)))
    ipcMain.handle('eaon-code:recents', () => recents.list())
    // The ADE's folder: remembered as recent and reopened next launch. Nothing
    // is started — the ADE is terminals only, and each pane runs its own CLI.
    ipcMain.handle('eaon-code:use-folder', (_e, cwd: string) => {
      if (typeof cwd !== 'string' || !cwd) return recents.list()
      recents.add(cwd)
      if (store.getSettings().eaonCode.lastCwd !== cwd) {
        store.patchSettings({ eaonCode: { ...store.getSettings().eaonCode, lastCwd: cwd } })
      }
      return recents.list()
    })
    ipcMain.handle('eaon-code:forget-recent', (_e, cwd: string) => recents.remove(cwd))

    ipcMain.handle('eaon-code:pick-folder', async () => {
      const window = getWindow()
      const options: Electron.OpenDialogOptions = {
        title: 'Choose a project folder',
        buttonLabel: 'Open',
        properties: ['openDirectory', 'createDirectory']
      }
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    })
    ipcMain.handle('eaon-code:pick-binary', async () => {
      const window = getWindow()
      const options: Electron.OpenDialogOptions = { title: 'Locate eaon-code', properties: ['openFile', 'showHiddenFiles'] }
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    })

    /**
     * `continueSession` hands the running session to the terminal. The in-app
     * process is stopped first: two processes appending to one session file
     * would interleave their entries.
     */
    ipcMain.handle('eaon-code:open-terminal', (_e, cwd: string, continueSession?: boolean) =>
      result(async () => {
        const status = await active.status()
        if (!status.launch || status.state !== 'ready') throw new Error(status.error ?? 'Eaon Code is not installed.')
        // A session is only written to disk after its first reply; before that
        // there is nothing for the terminal to continue.
        const current = continueSession ? active.currentSessionFile() : null
        const sessionFile = current && existsSync(current) ? current : null
        if (sessionFile) await active.stop()
        const opened = await openInTerminal(cwd, status.launch, sessionFile ?? undefined)
        if (!opened.ok) throw new Error(opened.error)
        return { continued: Boolean(sessionFile) }
      })
    )
  },
  dispose: () => {
    bridge?.dispose()
    bridge = null
  }
}
