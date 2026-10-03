import { systemPreferences } from 'electron'
import { secrets } from '../secrets'
import { pickTranscriber, transcribe } from './voice/transcribe'
import type { Feature } from './types'

/**
 * Dictation for the Chat and Workers composers: asks macOS for the microphone
 * and turns a recording into text. Channels are `voice:*`.
 */
export const voiceFeature: Feature = {
  id: 'voice',
  register: ({ ipcMain }) => {
    // Which provider would transcribe, so the mic button can say what's missing before recording.
    ipcMain.handle('voice:provider', () => pickTranscriber((id) => secrets.get(id))?.transcriber.label ?? null)

    // macOS asks once; after that the answer stands until changed in System
    // Settings → Privacy & Security → Microphone. Elsewhere there is no prompt.
    ipcMain.handle('voice:microphone', async (): Promise<'granted' | 'denied'> => {
      if (process.platform !== 'darwin') return 'granted'
      const status = systemPreferences.getMediaAccessStatus('microphone')
      if (status === 'granted') return 'granted'
      if (status === 'denied' || status === 'restricted') return 'denied'
      return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied'
    })

    ipcMain.handle('voice:transcribe', async (_e, audio: Uint8Array, mimeType: string) => {
      try {
        const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio as ArrayBuffer)
        return { ok: true as const, ...(await transcribe(bytes, String(mimeType ?? ''), { getKey: (id) => secrets.get(id) })) }
      } catch (error) {
        return { ok: false as const, error: (error as Error).message }
      }
    })
  }
}
