import { ipcRenderer } from 'electron'

/** Renderer bridge for dictation. Exposed as `window.api.voice`. */
export const voiceApi = {
  /** Which provider would transcribe ("OpenAI", "Groq"), or null with no key saved. */
  provider: (): Promise<string | null> => ipcRenderer.invoke('voice:provider'),
  /** Asks macOS for the microphone the first time; elsewhere always granted. */
  microphone: (): Promise<'granted' | 'denied'> => ipcRenderer.invoke('voice:microphone'),
  /** Sends a recording to be turned into text. */
  transcribe: (audio: Uint8Array, mimeType: string): Promise<{ ok: true; text: string; provider: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('voice:transcribe', audio, mimeType)
}
