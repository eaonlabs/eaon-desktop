import { app, systemPreferences } from 'electron'
import { secrets } from '../secrets'
import { store } from '../store'
import { getProvider } from '../providers'
import { pickTranscriber, transcribe, type SpeechChoice } from './voice/transcribe'
import { LOCAL_SPEECH_ID, canTranscribe, type SpeechPick } from '@shared/speech'
import { checkHfFile } from '../ipcGuards'
import {
  cancelLocalSpeechDownload,
  deleteLocalSpeechModel,
  downloadHubSpeechModel,
  downloadLocalSpeechModel,
  localSpeechLabel,
  localSpeechState,
  onLocalSpeechChange,
  transcribeLocally
} from './voice/localWhisper'
import { searchSpeechHub } from './voice/speechHub'
import type { Feature } from './types'

/**
 * Dictation for the Chat and Workers composers: asks macOS for the microphone
 * and turns a recording into text. Channels are `voice:*`.
 */
export const voiceFeature: Feature = {
  id: 'voice',
  register: ({ ipcMain, send }) => {
    // Which provider would transcribe, so the mic button can say what's missing before recording.
    // `pick` is a model chosen for one place (the ADE's hold-to-talk) instead of the one in Settings.
    ipcMain.handle('voice:provider', async (_e, pick?: unknown) => {
      const wanted = pickOf(pick)
      const local = localChoice(wanted)
      if (local) return (await localSpeechState()).downloaded.includes(local) ? `${localSpeechLabel(local)} on this computer` : null
      return pickTranscriber((id) => secrets.get(id), speechChoice(wanted))?.transcriber.label ?? null
    })

    // Models that run on this computer (voice/localWhisper.ts).
    onLocalSpeechChange(() => void localSpeechState().then((state) => send('voice:local-changed', state)))
    ipcMain.handle('voice:local-state', () => localSpeechState())
    ipcMain.handle('voice:local-download', (_e, id: unknown) => downloadLocalSpeechModel(String(id)))
    ipcMain.handle('voice:local-cancel', () => cancelLocalSpeechDownload())
    ipcMain.handle('voice:local-delete', (_e, id: unknown) => deleteLocalSpeechModel(String(id)))
    // More whisper.cpp models, from anywhere on Hugging Face (voice/speechHub.ts).
    ipcMain.handle('voice:hub-search', (_e, query: unknown) => searchSpeechHub(typeof query === 'string' ? query.slice(0, 200) : ''))
    ipcMain.handle('voice:hub-download', (_e, repoId: unknown, filename: unknown) => {
      const file = checkHfFile(repoId, filename, app.getPath('userData'))
      return downloadHubSpeechModel(file.repoId, file.filename)
    })

    // macOS asks once; after that the answer stands until changed in System
    // Settings → Privacy & Security → Microphone. Elsewhere there is no prompt.
    ipcMain.handle('voice:microphone', async (): Promise<'granted' | 'denied'> => {
      if (process.platform !== 'darwin') return 'granted'
      const status = systemPreferences.getMediaAccessStatus('microphone')
      if (status === 'granted') return 'granted'
      if (status === 'denied' || status === 'restricted') return 'denied'
      return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied'
    })

    ipcMain.handle('voice:transcribe', async (_e, audio: Uint8Array, mimeType: string, pick?: unknown) => {
      try {
        const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio as ArrayBuffer)
        const wanted = pickOf(pick)
        const local = localChoice(wanted)
        if (local) {
          if (bytes.byteLength <= 44) throw new Error('Nothing was recorded.')
          return { ok: true as const, text: await transcribeLocally(bytes, local), provider: `${localSpeechLabel(local)} on this computer` }
        }
        return { ok: true as const, ...(await transcribe(bytes, String(mimeType ?? ''), { getKey: (id) => secrets.get(id), choice: speechChoice(wanted) })) }
      } catch (error) {
        return { ok: false as const, error: (error as Error).message }
      }
    })
  }
}

/** A model picked for one place, from the renderer: a provider id and maybe a model, or nothing. */
function pickOf(raw: unknown): SpeechPick | null {
  const pick = raw as Partial<SpeechPick> | null | undefined
  if (!pick || typeof pick.providerId !== 'string' || !pick.providerId) return null
  return { providerId: pick.providerId, modelId: typeof pick.modelId === 'string' && pick.modelId ? pick.modelId : null }
}

/**
 * The model to use: one picked for this place, else the one in Settings →
 * Model providers → Speech to text. A chat-only runtime (Eaon's "On this
 * computer" for chat models, Ollama…) can't transcribe, so one picked before
 * they were left out of that list counts as nothing picked.
 */
function selected(pick: SpeechPick | null): { speechProviderId: string | null; speechModelId: string | null } {
  const chosen = pick ? { speechProviderId: pick.providerId, speechModelId: pick.modelId } : (store.getSettings().voice ?? {})
  const { speechProviderId = null, speechModelId = null } = chosen
  if (speechProviderId && !canTranscribe({ id: speechProviderId })) return { speechProviderId: null, speechModelId: null }
  return { speechProviderId, speechModelId }
}

/** The local model dictation is set to, or null when it uses a hosted provider. */
function localChoice(pick: SpeechPick | null = null): string | null {
  const { speechProviderId, speechModelId } = selected(pick)
  return speechProviderId === LOCAL_SPEECH_ID ? (speechModelId ?? 'base') : null
}

/** The speech-to-text model picked (for this place, or in Settings → Model providers), or null to pick automatically. */
function speechChoice(pick: SpeechPick | null = null): SpeechChoice | null {
  const { speechProviderId, speechModelId } = selected(pick)
  if (!speechProviderId || !speechModelId || speechProviderId === LOCAL_SPEECH_ID) return null
  const provider = getProvider(speechProviderId)
  return {
    providerId: speechProviderId,
    modelId: speechModelId,
    label: provider?.name ?? speechProviderId,
    baseUrl: provider?.baseUrl,
    keyless: Boolean(provider?.local) || provider?.auth === 'none'
  }
}
