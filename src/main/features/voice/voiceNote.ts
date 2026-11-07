import { oggOpusToWav, VoiceNoteError, wavSeconds } from './oggOpus'

/**
 * A voice note from a chat app (Telegram, WhatsApp) turned into text on this
 * computer, with the speech model the user downloaded. Nothing is sent
 * anywhere: no hosted speech provider is ever tried, whatever keys are saved,
 * because a friend's voice is not the user's to send to a cloud. The reasons
 * it can fail are sentences meant to be said back to the sender.
 */

export const MAX_VOICE_NOTE_SECONDS = 10 * 60
/** Ten minutes of Opus is a couple of megabytes; far more than this is not a voice note. */
export const MAX_VOICE_NOTE_BYTES = 8 * 1024 * 1024
/** Less than this is a tap on the microphone, not speech. */
const MIN_SECONDS = 0.3

export type VoiceNoteResult =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: 'no-engine' | 'no-model' | 'too-long' | 'unreadable' | 'empty' | 'failed'; message: string }

export interface VoiceNoteDeps {
  /** What this computer can do for speech: the engine is part of the build, and which models are downloaded. */
  state: () => Promise<{ available: boolean; downloaded: string[] }>
  /** The local model dictation is set to, or null when it is set to a hosted provider or nothing. */
  preferred: () => string | null
  transcribe: (wav: Uint8Array, modelId: string) => Promise<string>
  label: (modelId: string) => string
  /** The voice note's audio as the 16 kHz WAV the speech model takes. */
  decode?: (audio: Uint8Array) => Promise<Uint8Array>
}

export const NO_ENGINE = 'This computer has no speech engine, so Eaon can’t listen to voice notes here.'
export const NO_MODEL = 'No speech model is installed, so Eaon can’t listen to voice notes yet.'
/** For the owner, who can fix it. */
export const NO_MODEL_HOW = 'Download one in Eaon → Settings → Model providers → Speech to text, and voice notes are transcribed on this computer.'

export async function transcribeVoiceNote(audio: Uint8Array, deps: VoiceNoteDeps): Promise<VoiceNoteResult> {
  if (audio.byteLength > MAX_VOICE_NOTE_BYTES) return { ok: false, reason: 'too-long', message: 'That voice note is too long. Eaon listens to ones under ten minutes.' }
  const state = await deps.state()
  if (!state.available) return { ok: false, reason: 'no-engine', message: NO_ENGINE }
  if (state.downloaded.length === 0) return { ok: false, reason: 'no-model', message: NO_MODEL }
  const preferred = deps.preferred()
  const model = preferred && state.downloaded.includes(preferred) ? preferred : state.downloaded[0]

  let wav: Uint8Array
  try {
    wav = await (deps.decode ?? oggOpusToWav)(audio)
  } catch (error) {
    const why = error instanceof VoiceNoteError ? error.message : 'Its audio couldn’t be read.'
    return { ok: false, reason: 'unreadable', message: `I couldn’t open that voice note. ${why}` }
  }
  const seconds = wavSeconds(wav)
  if (seconds > MAX_VOICE_NOTE_SECONDS) return { ok: false, reason: 'too-long', message: 'That voice note is too long. Eaon listens to ones under ten minutes.' }
  if (seconds < MIN_SECONDS) return { ok: false, reason: 'empty', message: 'That voice note was too short to make out.' }

  let text: string
  try {
    text = await deps.transcribe(wav, model)
  } catch (error) {
    return { ok: false, reason: 'failed', message: `The speech model couldn’t transcribe it: ${error instanceof Error ? error.message : String(error)}` }
  }
  // Whisper writes bracketed sounds ("[BLANK_AUDIO]", "(music)") for silence and noise.
  const words = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  if (!words) return { ok: false, reason: 'empty', message: 'I couldn’t make out any words in that voice note.' }
  return { ok: true, text: text.replace(/\s+/g, ' ').trim(), model: deps.label(model) }
}
