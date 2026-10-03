import { app, shell, systemPreferences } from 'electron'
import type { ComputerTestResult, ComputerUseStatus, PermissionKind, PermissionState } from '@shared/computerUse'
import { registerToolSource } from '../agent/tools'
import { store } from '../store'
import { disposeInput, inputBackend, interruptInput } from './computer/backend'
import { captureDisplay, orderedDisplays, requestScreenAccess, ScreenCaptureDenied } from './computer/capture'
import { differentlySignedCopies, permissionOwner, resetAccessibility } from './computer/mac'
import { configureSession, disposeSession, isDriving, STOP_LABEL, stopAll, withEaonHidden } from './computer/session'
import { COMPUTER_GUIDANCE, computerTool } from './computer/tool'
import type { Feature } from './types'

/**
 * Computer use: screenshots plus mouse and keyboard control, as one Work tool
 * (`computer`), and the Settings page's status, permission and test calls.
 *
 * The tool is offered only when Settings → Computer use is on, only in Work
 * mode, and only to the main agent — swarm sub-agents run in parallel, and
 * two agents sharing one pointer would undo each other's clicks.
 */

const PRIVACY_PANES: Record<PermissionKind, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
}

/**
 * Set when the setup step asks for Screen Recording. Eaon's own answer
 * (`getMediaAccessStatus`) only changes once Eaon restarts, so this is how
 * the page knows to offer "Quit & reopen" after the user comes back from
 * System Settings. Kept here rather than in the page so it survives leaving
 * Settings and coming back.
 */
let screenRequested = false

function screenPermission(): PermissionState {
  if (process.platform !== 'darwin') return 'not-needed'
  try {
    return systemPreferences.getMediaAccessStatus('screen') as PermissionState
  } catch {
    return 'unknown'
  }
}

async function status(): Promise<ComputerUseStatus> {
  const platform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux'
  const backend = inputBackend()
  const check = await backend.check()
  let accessibility: PermissionState = 'not-needed'
  if (platform === 'darwin') {
    // The helper's own answer is the one that matters (it posts the events),
    // but it is attributed to Eaon either way; fall back to Electron's.
    const trusted = check.trusted ?? systemPreferences.isTrustedAccessibilityClient(false)
    accessibility = trusted ? 'granted' : 'denied'
  }
  const owner = platform === 'darwin' ? await permissionOwner() : null
  return {
    platform,
    screen: screenPermission(),
    accessibility,
    owner,
    ...(accessibility === 'denied' && owner?.self ? { otherCopies: await differentlySignedCopies() } : {}),
    screenRequested,
    canRelaunch: app.isPackaged,
    input: { available: check.available, backend: backend.name, ...(check.detail ? { detail: check.detail } : {}) },
    locked: platform === 'darwin' ? (check.locked ?? null) : null,
    displays: orderedDisplays().map((d, i) => ({
      id: d.id,
      primary: i === 0,
      width: d.bounds.width,
      height: d.bounds.height,
      scaleFactor: d.scaleFactor
    })),
    stopShortcut: STOP_LABEL,
    driving: isDriving()
  }
}

async function test(): Promise<ComputerTestResult> {
  const started = Date.now()
  try {
    // The same path the tool takes, Eaon hidden and all, so what the page
    // shows is exactly what the model would receive.
    const shot = await withEaonHidden(() => captureDisplay(orderedDisplays()[0], store.getSettings().computerUse.quality))
    return {
      ok: true,
      dataUrl: `data:image/jpeg;base64,${shot.jpeg.toString('base64')}`,
      width: shot.frame.width,
      height: shot.frame.height,
      bytes: shot.jpeg.length,
      ms: Date.now() - started,
      ...(shot.warning ? { error: shot.warning } : {})
    }
  } catch (error) {
    // The tool's wording is written for the model; the page has the setup steps.
    const message =
      error instanceof ScreenCaptureDenied
        ? 'macOS blocked the screenshot because Screen Recording is off. Follow the setup steps at the top of this page.'
        : (error as Error).message
    return { ok: false, error: message, ms: Date.now() - started }
  }
}

registerToolSource({
  id: 'computer',
  tools: (query) => (query.mode === 'work' && query.depth === 0 && query.settings.computerUse.enabled ? [computerTool] : []),
  guidance: () => COMPUTER_GUIDANCE
})

export const computerUseFeature: Feature = {
  id: 'computer-use',
  register: ({ ipcMain, getWindow, getWindows }) => {
    configureSession({ getWindow, getWindows, onStopped: interruptInput })
    ipcMain.handle('computer-use:status', () => status())
    ipcMain.handle('computer-use:test', () => test())
    ipcMain.handle('computer-use:stop', () => stopAll())
    ipcMain.handle('computer-use:open-permission', async (_e, kind: PermissionKind) => {
      if (process.platform !== 'darwin' || !(kind in PRIVACY_PANES)) return
      // Each list only shows apps that have asked, so ask first: the user
      // then has a switch to turn on rather than a "+" to hunt for. Asking
      // with prompt=true is what adds Eaon to the Accessibility list.
      if (kind === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true)
      else {
        screenRequested = true
        await requestScreenAccess()
      }
      await shell.openExternal(PRIVACY_PANES[kind])
    })
    // A switch that shows as on while Eaon is still refused belongs to an
    // older, differently signed Eaon: clear the entry, ask again, and open
    // the list so the user can switch this copy on.
    ipcMain.handle('computer-use:reset-accessibility', async () => {
      if (process.platform !== 'darwin') return { ok: false, error: 'Only macOS has this list.' }
      const result = await resetAccessibility()
      if (!result.ok) return result
      systemPreferences.isTrustedAccessibilityClient(true)
      await shell.openExternal(PRIVACY_PANES.accessibility)
      return result
    })
    // Screen Recording applies only after a relaunch. app.quit() rather than
    // app.exit() so the held quit in index.ts still saves chats and closes
    // MCP servers; the relaunch happens when the process finally exits.
    // Not in development: the dev server would not come back with it.
    ipcMain.handle('computer-use:relaunch', () => {
      if (!app.isPackaged) return false
      app.relaunch()
      app.quit()
      return true
    })
  },
  dispose: () => {
    disposeSession()
    disposeInput()
  }
}
