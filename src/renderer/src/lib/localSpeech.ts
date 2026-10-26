import { useEffect, useState } from 'react'
import { LOCAL_SPEECH_ID, type LocalSpeechState } from '@shared/speech'
import { useApp } from '../state/store'

/**
 * The speech models that run on this computer (main/features/voice/localWhisper.ts),
 * for every place that offers them: Settings → Model providers → Speech to
 * text, Settings → General, and the dictation setup in Chat, Workers and the ADE.
 */

/** Speech to text's row under Settings → Model providers: not a provider, but where the speech model is picked. */
export const SPEECH_SETTINGS = '__speech'

/** The local models' state from main, following downloads as they progress. */
export function useLocalSpeech(): LocalSpeechState | null {
  const [state, setState] = useState<LocalSpeechState | null>(null)
  useEffect(() => {
    let live = true
    void window.api.voice.localState().then((s) => live && setState(s))
    const off = window.api.voice.onLocalChanged((s) => live && setState(s))
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}

/** Which model would transcribe ("Whisper Base on this computer", "OpenAI"), or null when none can; asked again as settings and downloads change. */
export function useSpeechInUse(local: LocalSpeechState | null): string | null | undefined {
  const voice = useApp((s) => s.settings?.voice)
  const providers = useApp((s) => s.providers)
  const [using, setUsing] = useState<string | null | undefined>(undefined)
  const downloaded = local?.downloaded.join(',')
  useEffect(() => {
    let live = true
    void window.api.voice.provider().then(
      (label) => live && setUsing(label),
      () => live && setUsing(null)
    )
    return () => {
      live = false
    }
  }, [voice?.speechProviderId, voice?.speechModelId, providers, downloaded])
  return using
}

export const megabytes = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)

/** "62 of 148 MB": how far a download has come. */
export const downloadedOf = (progress: number, bytes: number): string => `${Math.round((progress * bytes) / 1e6)} of ${megabytes(bytes)}`

/**
 * Downloads a model. True once it is on this computer, false when it was
 * stopped (the part stays, and the next try picks up from it); throws why
 * it failed, in words for a person.
 */
export async function downloadSpeechModel(id: string): Promise<boolean> {
  try {
    await window.api.voice.localDownload(id)
    return true
  } catch (error) {
    const message = (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    if (/abort/i.test(message)) return false
    throw new Error(message)
  }
}

/** Downloads a model from Hugging Face (Find more): its id once it's on this computer, null when stopped; throws why it failed. */
export async function downloadHubModel(repoId: string, filename: string): Promise<string | null> {
  try {
    return await window.api.voice.hubDownload(repoId, filename)
  } catch (error) {
    const message = (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    if (/abort/i.test(message)) return null
    throw new Error(message)
  }
}

/**
 * Makes a model on this computer the one dictation uses: in the ADE alone
 * when the ADE has a model of its own (Settings → ADE), else everywhere.
 */
export function chooseLocalSpeech(id: string, { ade = false }: { ade?: boolean } = {}): void {
  const { patchSettings } = useApp.getState()
  if (ade) void patchSettings({ ade: { dictation: { speechProviderId: LOCAL_SPEECH_ID, speechModelId: id } } })
  else void patchSettings({ voice: { speechProviderId: LOCAL_SPEECH_ID, speechModelId: id } })
}
