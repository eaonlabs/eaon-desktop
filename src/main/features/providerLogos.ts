import { dialog } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { MAX_LOGO_BYTES, type ProviderLogos } from '@shared/providerLogos'
import { getProvider } from '../providers'
import { clearUserLogo, lookUpLogo, onLogosChanged, readLogos, setUserLogo, stopLogoTimers, sweepLogos } from '../providers/logos'
import type { Feature } from './types'

/**
 * Provider logos for the windows (providers/logos.ts does the work): the
 * saved ones, picking an image for a provider, resetting it, and looking a
 * custom provider's logo up from its base URL again. Channels:
 * `provider-logos:*`; every change is sent as `provider-logos:changed`.
 */

const SWEEP_AFTER_START_MS = 20_000
const SWEEP_EVERY_MS = 6 * 3_600_000

let startTimer: ReturnType<typeof setTimeout> | null = null
let everyTimer: ReturnType<typeof setInterval> | null = null

const isProviderId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200

type Picked = { ok: true; logos: ProviderLogos } | { ok: false; reason: string } | { ok: false; canceled: true }

export const providerLogosFeature: Feature = {
  id: 'provider-logos',
  register: ({ ipcMain, send, getWindow }) => {
    onLogosChanged((logos) => send('provider-logos:changed', logos))

    ipcMain.handle('provider-logos:list', () => readLogos())

    // Settings → Model providers is open: a provider added from the Eaon CLI is looked up now, not at the next sweep.
    ipcMain.handle('provider-logos:sweep', () => sweepLogos())

    ipcMain.handle('provider-logos:choose', async (_event, providerId: unknown): Promise<Picked> => {
      if (!isProviderId(providerId) || !getProvider(providerId)) return { ok: false, reason: 'That provider no longer exists.' }
      const window = getWindow()
      const options: Electron.OpenDialogOptions = {
        title: 'Choose a logo',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'ico'] }]
      }
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      const path = picked.filePaths[0]
      if (picked.canceled || !path) return { ok: false, canceled: true }
      // Checked before reading, so a huge file is never loaded.
      const size = (await stat(path)).size
      if (size > MAX_LOGO_BYTES) return { ok: false, reason: `It’s ${(size / 1024 / 1024).toFixed(1)} MB; a logo can be at most 1 MB.` }
      return setUserLogo(providerId, await readFile(path))
    })

    ipcMain.handle('provider-logos:reset', (_event, providerId: unknown) => (isProviderId(providerId) ? clearUserLogo(providerId) : readLogos()))

    ipcMain.handle('provider-logos:look-up', (_event, providerId: unknown) => (isProviderId(providerId) ? lookUpLogo(providerId) : readLogos()))

    startTimer = setTimeout(() => void sweepLogos(), SWEEP_AFTER_START_MS)
    everyTimer = setInterval(() => void sweepLogos(), SWEEP_EVERY_MS)
    everyTimer.unref?.()
  },
  dispose: () => {
    if (startTimer) clearTimeout(startTimer)
    if (everyTimer) clearInterval(everyTimer)
    stopLogoTimers()
  }
}
