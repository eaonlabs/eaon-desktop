import { BrowserWindow, dialog, protocol, shell } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { safeModPath, type ModManifest } from '@shared/mods'
import type { Feature } from '../types'
import { enabledModDir, enabledMods, onModsChanged } from './service'
import * as mods from './service'
import { modDataFile, modsRoot } from './files'
import { registerModTools } from './tools'

/**
 * Mods (shared/mods.ts): installing them, serving their panels and handing
 * their parts to Chat, the agent loop and the ADE's CLIs.
 *
 * Channels (all `mods:`): `list`, `install-bundled`, `inspect`,
 * `install-staged`, `discard-staged`, `uninstall`, `set-enabled`,
 * `add-source`, `remove-source`, `refresh`, `open-folder`, `panel-load`,
 * `panel-save`, and the `changed` event.
 */

export const MOD_SCHEME = 'eaon-mod'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

/**
 * The policy every mod page is served under: scripts, styles, pictures and
 * fonts from its own mod only, and no network at all — no fetch, no
 * WebSocket, no form posts, no frames. With the frame's sandbox (scripts,
 * nothing else: an opaque origin, no `window.api`) a panel can draw and
 * compute, and reach the app only by the messages the host answers.
 */
export const panelPolicy = (id: string): string => {
  const own = `${MOD_SCHEME}://${id}`
  return [
    "default-src 'none'",
    `script-src ${own} 'unsafe-inline'`,
    `style-src ${own} 'unsafe-inline'`,
    `img-src ${own} data: blob:`,
    `font-src ${own} data:`,
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; ')
}

/** A file of an installed, enabled mod, for `eaon-mod://<id>/<path>`. */
export function serveModFile(raw: string): Response {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return new Response('Not found', { status: 404 })
  }
  const id = url.hostname
  const rel = safeModPath(decodeURIComponent(url.pathname.replace(/^\//, '')))
  const dir = enabledModDir(id)
  const type = rel ? TYPES[extname(rel).toLowerCase()] : undefined
  if (!dir || !rel || !type) return new Response('Not found', { status: 404 })
  try {
    const body = readFileSync(join(dir, ...rel.split('/')))
    return new Response(body, {
      headers: {
        'Content-Type': type,
        'Content-Security-Policy': panelPolicy(id),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      }
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

/* --------------------------------------------------------- panel storage */

const PANEL_DATA_LIMIT = 256 * 1024

function loadPanelData(id: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(modDataFile(id), 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function savePanelData(id: string, key: string, value: string | null): void {
  if (!enabledModDir(id)) throw new Error('That mod isn’t on.')
  if (typeof key !== 'string' || !key || key.length > 100) throw new Error('A panel’s storage key is a short name.')
  const data = loadPanelData(id)
  if (value === null) delete data[key]
  else if (typeof value === 'string') data[key] = value
  else throw new Error('A panel stores text.')
  const text = JSON.stringify(data)
  if (text.length > PANEL_DATA_LIMIT) throw new Error('This panel’s storage is full.')
  mkdirSync(dirname(modDataFile(id)), { recursive: true })
  writeFileSync(modDataFile(id), text)
}

/* ---------------------------------------------------- instructions for Chat */

/**
 * The enabled mods' instructions, as one block added to a Chat turn's
 * instructions (main/index.ts, `chat:stream`), or '' when there are none.
 */
export function modInstructions(list: ModManifest[] = enabledMods()): string {
  const parts = list.filter((m) => m.contributes.instructions).map((m) => `From the ${m.name} mod:\n${m.contributes.instructions}`)
  return parts.length ? `The user turned on these mods. Follow their instructions too:\n\n${parts.join('\n\n')}` : ''
}

/** Project instructions with the mods' added after them. */
export const withModInstructions = (projectInstructions: string): string =>
  [projectInstructions, modInstructions()].filter((part) => part && part.trim()).join('\n\n')

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const modsFeature: Feature = {
  id: 'mods',
  register: ({ ipcMain, send, getWindow }) => {
    protocol.handle(MOD_SCHEME, (request) => serveModFile(request.url))
    registerModTools(enabledMods)
    try {
      mods.syncBundledMods()
    } catch (error) {
      console.error('[mods] could not update bundled mods:', error)
    }
    onModsChanged(() => send('mods:changed', mods.listMods()))
    // Sources are read in the background: the marketplace opens on the bundled mods at once.
    void mods.refreshSources().catch(() => undefined)

    ipcMain.handle('mods:list', () => mods.listMods())
    ipcMain.handle('mods:install-bundled', (_e, id: string) => {
      mods.installBundled(String(id))
      return mods.listMods()
    })
    /**
     * Reads a mod for review without installing it. Folders and files are
     * picked here, in main, so the renderer never names a path to read.
     */
    ipcMain.handle('mods:inspect', async (_e, target: { kind: 'folder' } | { kind: 'file' } | { kind: 'url'; url: string } | { kind: 'indexed'; id: string }) => {
      try {
        if (target?.kind === 'folder' || target?.kind === 'file') {
          const parent = getWindow() ?? BrowserWindow.getFocusedWindow()
          const options: Electron.OpenDialogOptions =
            target.kind === 'folder'
              ? { title: 'Choose a mod folder', properties: ['openDirectory'] }
              : { title: 'Choose a packed mod', properties: ['openFile'], filters: [{ name: 'Eaon mod', extensions: ['json'] }] }
          const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
          const path = picked.filePaths[0]
          if (picked.canceled || !path) return { ok: false, cancelled: true }
          const inspected = target.kind === 'folder' ? mods.inspectFolder(path) : mods.inspectPackText(readFileSync(path, 'utf8'), { kind: 'file', path })
          return { ok: true, ...inspected }
        }
        if (target?.kind === 'url') return { ok: true, ...(await mods.inspectUrl(String(target.url))) }
        if (target?.kind === 'indexed') {
          const url = mods.indexedUrl(String(target.id))
          if (!url) return { ok: false, error: 'That mod isn’t in any of your sources any more.' }
          return { ok: true, ...(await mods.inspectUrl(url)) }
        }
        return { ok: false, error: 'Nothing to open.' }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    })
    ipcMain.handle('mods:install-staged', (_e, token: string) => {
      mods.installStaged(String(token))
      return mods.listMods()
    })
    ipcMain.handle('mods:discard-staged', (_e, token: string) => mods.discardStaged(String(token)))
    ipcMain.handle('mods:uninstall', (_e, id: string) => {
      mods.uninstall(String(id))
      return mods.listMods()
    })
    ipcMain.handle('mods:set-enabled', (_e, id: string, enabled: boolean) => {
      mods.setEnabled(String(id), enabled === true)
      return mods.listMods()
    })
    ipcMain.handle('mods:add-source', async (_e, url: string) => {
      try {
        await mods.addSource(String(url))
        return { ok: true, list: mods.listMods() }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    })
    ipcMain.handle('mods:remove-source', (_e, url: string) => {
      mods.removeSource(String(url))
      return mods.listMods()
    })
    ipcMain.handle('mods:refresh', async () => {
      await mods.refreshSources()
      return mods.listMods()
    })
    ipcMain.handle('mods:open-folder', async () => {
      mkdirSync(modsRoot(), { recursive: true })
      await shell.openPath(modsRoot())
    })
    // A panel's own notes. The host page passes the mod's id; the panel itself never reaches IPC.
    ipcMain.handle('mods:panel-load', (_e, id: string) => (enabledModDir(String(id)) ? loadPanelData(String(id)) : {}))
    ipcMain.handle('mods:panel-save', (_e, id: string, key: string, value: string | null) => savePanelData(String(id), key, value))
  }
}
