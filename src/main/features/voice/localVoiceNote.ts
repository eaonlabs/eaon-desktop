import { LOCAL_SPEECH_ID } from '@shared/speech'
import { store } from '../../store'
import { localSpeechLabel, localSpeechState, transcribeLocally } from './localWhisper'
import { transcribeVoiceNote, type VoiceNoteResult } from './voiceNote'

/** A voice note, transcribed with this computer's speech engine and the models downloaded here. */
export function transcribeVoiceNoteLocally(audio: Uint8Array): Promise<VoiceNoteResult> {
  // The model dictation is set to when that is one of the local models; else the first one downloaded.
  return transcribeVoiceNote(audio, {
    state: async () => {
      const { available, downloaded } = await localSpeechState()
      return { available, downloaded }
    },
    preferred: () => {
      const voice = store.getSettings().voice
      return voice?.speechProviderId === LOCAL_SPEECH_ID ? (voice.speechModelId ?? 'base') : null
    },
    transcribe: transcribeLocally,
    label: localSpeechLabel
  })
}
