/**
 * Speech to text for dictation: which providers can turn a recording into
 * text, and the models each offers. All of them take the same request —
 * OpenAI's `POST /audio/transcriptions`, multipart, with `file` and `model` —
 * so any custom or local provider that speaks it (a whisper.cpp or
 * faster-whisper server, say) works too, with a model name the user types.
 *
 * Settings → Model providers → Speech to text picks one; with none picked,
 * dictation uses the first of OpenAI and Groq that has a key.
 */

export interface SpeechProvider {
  providerId: string
  /** Suggested models, best first. The first is the default. */
  models: { id: string; label: string }[]
  /** The transcription endpoint, when it isn't the provider's base URL + /audio/transcriptions. */
  url?: string
}

export const SPEECH_PROVIDERS: SpeechProvider[] = [
  {
    providerId: 'openai',
    url: 'https://api.openai.com/v1/audio/transcriptions',
    models: [
      { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe' },
      { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
      { id: 'whisper-1', label: 'Whisper' }
    ]
  },
  {
    providerId: 'groq',
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    models: [
      { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' },
      { id: 'whisper-large-v3', label: 'Whisper Large v3' }
    ]
  },
  { providerId: 'mistral', url: 'https://api.mistral.ai/v1/audio/transcriptions', models: [{ id: 'voxtral-mini-latest', label: 'Voxtral Mini' }] },
  { providerId: 'together', url: 'https://api.together.ai/v1/audio/transcriptions', models: [{ id: 'openai/whisper-large-v3', label: 'Whisper Large v3' }] },
  {
    providerId: 'deepinfra',
    url: 'https://api.deepinfra.com/v1/openai/audio/transcriptions',
    models: [{ id: 'openai/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' }]
  }
]

/** Tried in this order when the user hasn't picked one. */
export const AUTO_SPEECH_PROVIDERS = ['openai', 'groq']

export function speechProvider(providerId: string): SpeechProvider | undefined {
  return SPEECH_PROVIDERS.find((p) => p.providerId === providerId)
}

/** Where a provider's transcriptions go: its known endpoint, or its own base URL's. */
export function speechUrl(providerId: string, baseUrl: string | undefined): string | null {
  const known = speechProvider(providerId)?.url
  if (known) return known
  const base = baseUrl?.trim().replace(/\/+$/, '')
  return base ? `${base}/audio/transcriptions` : null
}
