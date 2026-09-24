import { shell, systemPreferences } from 'electron'
import type { ComputerTestResult, ComputerUseStatus, PermissionKind, PermissionState } from '@shared/computerUse'
import { registerToolSource } from '../agent/tools'
import { store } from '../store'
import { disposeInput, inputBackend, interruptInput } from './computer/backend'
import { captureDisplay, orderedDisplays } from './computer/capture'
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
  return {
    platform,
    screen: screenPermission(),
    accessibility,
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
    return { ok: false, error: (error as Error).message, ms: Date.now() - started }
  }
}

registerToolSource({
  id: 'computer',
  tools: (query) => (query.mode === 'work' && query.depth === 0 && query.settings.computerUse.enabled ? [computerTool] : []),
  guidance: () => COMPUTER_GUIDANCE
})

export const computerUseFeature: Feature = {
  id: 'computer-use',
  register: ({ ipcMain, getWindow }) => {
    configureSession({ getWindow, onStopped: interruptInput })
    ipcMain.handle('computer-use:status', () => status())
    ipcMain.handle('computer-use:test', () => test())
    ipcMain.handle('computer-use:stop', () => stopAll())
    ipcMain.handle('computer-use:open-permission', async (_e, kind: PermissionKind) => {
      if (process.platform !== 'darwin' || !(kind in PRIVACY_PANES)) return
      // Asking with prompt=true is what adds Eaon to the Accessibility list,
      // so the user has a switch to turn on rather than a "+" to hunt for.
      if (kind === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true)
      await shell.openExternal(PRIVACY_PANES[kind])
    })
  },
  dispose: () => {
    disposeSession()
    disposeInput()
  }
}
