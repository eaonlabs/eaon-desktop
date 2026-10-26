import { ipcRenderer } from 'electron'
import type { LocalSpeechState, SpeechHubResult, SpeechPick } from '@shared/speech'

/** Renderer bridge for dictation. Exposed as `window.api.voice`. */
export const voiceApi = {
  /** Which provider would transcribe ("OpenAI", "Groq"), or null with no key saved. `pick` overrides the model in Settings. */
  provider: (pick?: SpeechPick | null): Promise<string | null> => ipcRenderer.invoke('voice:provider', pick ?? null),
  /** Asks macOS for the microphone the first time; elsewhere always granted. */
  microphone: (): Promise<'granted' | 'denied'> => ipcRenderer.invoke('voice:microphone'),
  /** The speech models that run on this computer: which are downloaded, and any download in progress. */
  localState: (): Promise<LocalSpeechState> => ipcRenderer.invoke('voice:local-state'),
  /** Downloads a local speech model; resolves when it is ready, rejects with why it isn't. */
  localDownload: (id: string): Promise<void> => ipcRenderer.invoke('voice:local-download', id),
  localCancel: (): Promise<void> => ipcRenderer.invoke('voice:local-cancel'),
  localDelete: (id: string): Promise<void> => ipcRenderer.invoke('voice:local-delete', id),
  /** whisper.cpp models on Hugging Face matching `query` (a language, a model), or the official and most downloaded with none. */
  hubSearch: (query: string): Promise<SpeechHubResult[]> => ipcRenderer.invoke('voice:hub-search', query),
  /** Downloads a model from Hugging Face; resolves with its id once it's ready, rejects with why it isn't. */
  hubDownload: (repoId: string, filename: string): Promise<string> => ipcRenderer.invoke('voice:hub-download', repoId, filename),
  onLocalChanged: (listener: (state: LocalSpeechState) => void): (() => void) => {
    const handler = (_e: unknown, state: LocalSpeechState): void => listener(state)
    ipcRenderer.on('voice:local-changed', handler)
    return () => ipcRenderer.removeListener('voice:local-changed', handler)
  },
  /** Sends a recording to be turned into text, by `pick` when given, else by the model in Settings. */
  transcribe: (audio: Uint8Array, mimeType: string, pick?: SpeechPick | null): Promise<{ ok: true; text: string; provider: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('voice:transcribe', audio, mimeType, pick ?? null)
}
