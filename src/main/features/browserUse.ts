import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserControlStatus } from '@shared/browserUse'
import { registerToolSource, type ToolContext } from '../agent/tools'
import { store } from '../store'
import { browserById, devtoolsUrl, installedBrowsers, listening, openInspectPage, profileDir, type ChromiumBrowser } from './browserUse/chromium'
import { BROWSER_USE_VERSION, install, installState, uninstall } from './browserUse/setup'
import { BrowserUseSession, type BrowserUseTool } from './browserUse/session'
import { BROWSER_USE_GUIDANCE, browserUseAgentTools, type BrowserUseLink } from './browserUse/tools'
import type { Feature } from './types'

/**
 * Browser control: the agent in the user's own browser through Browser Use,
 * attached over the browser's DevTools protocol once the user has allowed
 * remote debugging in it. It replaces the Eaon extension: nothing to install
 * in the browser, no pairing code. Settings → Browser control sets it up.
 */

const root = (): string => join(app.getPath('userData'), 'browser-use')
let session: BrowserUseSession | null = null
let ownsTab = false
let setupStep: string | null = null
let setupError: string | null = null

const sessionOf = (): BrowserUseSession => (session ??= new BrowserUseSession(root()))

/** Browser Use's tool list, kept per version so a turn has it before the first connection. */
function toolsFile(): string {
  return join(root(), `tools-${BROWSER_USE_VERSION}.json`)
}
function knownTools(): BrowserUseTool[] | null {
  const live = session?.knownTools()
  if (live) return live
  try {
    const saved = JSON.parse(readFileSync(toolsFile(), 'utf8')) as BrowserUseTool[]
    return Array.isArray(saved) && saved.length ? saved : null
  } catch {
    return null
  }
}

/** The browser to use: the one chosen, else the first that allows debugging, else the first installed. */
async function pickBrowser(): Promise<{ browser: ChromiumBrowser | null; url: string | null }> {
  const chosen = browserById(store.getSettings().browserUse.browser)
  const candidates = chosen ? [chosen] : installedBrowsers()
  for (const browser of candidates) {
    const dir = profileDir(browser)
    const url = dir ? devtoolsUrl(dir) : null
    if (url && (await listening(url))) return { browser, url }
  }
  return { browser: candidates[0] ?? null, url: null }
}

const link: BrowserUseLink = {
  async connect(ctx: ToolContext) {
    if (!store.getSettings().browserUse.enabled) return { ok: false, text: 'Browser control is turned off in Settings → Browser control.' }
    if (!installState(root()).installed) return { ok: false, text: 'Browser control isn’t set up yet. The user can set it up in Settings → Browser control.' }
    const { browser, url } = await pickBrowser()
    if (!browser) return { ok: false, text: "No Chromium browser (Chrome, Edge, Brave, Arc, Comet…) was found on this computer." }
    if (!url) {
      return {
        ok: false,
        text: `${browser.name} isn't open, or it doesn't allow remote debugging yet. Ask the user to open ${browser.name}, or to turn on "Allow remote debugging" from Settings → Browser control (a switch on ${browser.inspect}).`
      }
    }
    const current = sessionOf()
    if (current.connectedTo !== url) {
      ownsTab = false
      ctx.progress(`Connecting to ${browser.name} — if it asks, click Allow there.`)
    }
    try {
      await current.ensure(url)
      const tools = current.knownTools()
      if (tools) writeFileSync(toolsFile(), JSON.stringify(tools))
      return { ok: true }
    } catch (error) {
      return { ok: false, text: `Couldn't connect to ${browser.name}: ${(error as Error).message}. If ${browser.name} asked to allow remote debugging, the user needs to click Allow.` }
    }
  },
  call: (name, args, signal) => sessionOf().call(name, args, signal),
  ownsTab: () => ownsTab,
  setOwnsTab: (owns) => (ownsTab = owns)
}

async function status(): Promise<BrowserControlStatus> {
  const settings = store.getSettings().browserUse
  const state = installState(root())
  const browsers = await Promise.all(
    installedBrowsers().map(async (b) => {
      const dir = profileDir(b)
      const url = dir ? devtoolsUrl(dir) : null
      return { id: b.id, name: b.name, debugging: Boolean(url && (await listening(url))) }
    })
  )
  return {
    enabled: settings.enabled,
    browser: settings.browser,
    installed: state.installed,
    version: state.installed ? state.version : null,
    setupStep,
    setupError,
    browsers,
    connected: Boolean(session?.connectedTo)
  }
}

registerToolSource({
  id: 'browser-use',
  tools: (query) => {
    if (!(query.mode === 'work' && query.depth === 0 && query.settings.browserUse.enabled)) return []
    const tools = knownTools()
    // Offered once Browser Use has been set up and has listed its tools (it does at setup).
    return tools ? browserUseAgentTools(link, tools) : []
  },
  guidance: () => (knownTools() ? BROWSER_USE_GUIDANCE : null)
})

export const browserUseFeature: Feature = {
  id: 'browser-use',
  register: ({ ipcMain, send }) => {
    ipcMain.handle('browser-control:status', () => status())
    ipcMain.handle('browser-control:setup', async () => {
      setupError = null
      try {
        await install(root(), (step) => {
          setupStep = step
          send('browser-control:progress', step)
        })
        // Its tool list, read once now so the agent has the tools before it first connects.
        await listToolsOffline().catch(() => undefined)
        store.patchSettings({ browserUse: { ...store.getSettings().browserUse, enabled: true } })
      } catch (error) {
        setupError = (error as Error).message
      } finally {
        setupStep = null
      }
      return status()
    })
    ipcMain.handle('browser-control:open-inspect', async (_e, id: unknown) => {
      const browser = browserById(typeof id === 'string' ? id : null) ?? installedBrowsers()[0]
      if (!browser) return { ok: false, error: 'No Chromium browser was found.' }
      try {
        await openInspectPage(browser)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    })
    ipcMain.handle('browser-control:remove', async () => {
      await session?.stop()
      session = null
      uninstall(root())
      store.patchSettings({ browserUse: { ...store.getSettings().browserUse, enabled: false } })
      return status()
    })
    ipcMain.handle('browser-control:disconnect', async () => {
      await session?.stop()
      return status()
    })
  },
  dispose: () => {
    void session?.stop()
  }
}

/**
 * Browser Use's tools, listed without attaching to any browser: its server
 * answers tools/list before it connects anywhere. Pointed at an address
 * nothing listens on, so no browser is asked.
 */
async function listToolsOffline(): Promise<void> {
  const probe = new BrowserUseSession(root())
  try {
    await probe.ensure('ws://127.0.0.1:9/devtools/browser/eaon-setup')
    const tools = probe.knownTools()
    if (tools) writeFileSync(toolsFile(), JSON.stringify(tools))
  } finally {
    await probe.stop()
  }
}
