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

/**
 * A speech-to-text model picked for one place (the ADE's hold-to-talk), in
 * place of the one under Settings → Model providers → Speech to text.
 */
export interface SpeechPick {
  providerId: string
  modelId: string | null
}

/* ------------------------------------------------------- on this computer */

/**
 * Dictation that never leaves the computer: whisper.cpp's server, bundled with
 * Eaon (resources/whisper), running one of these models, downloaded once from
 * Hugging Face into Eaon's own folder. Picked as the speech provider by this id.
 */
export const LOCAL_SPEECH_ID = 'eaon-whisper'

export interface LocalSpeechModel {
  id: string
  label: string
  /** One line for the picker: what it's good for. */
  blurb: string
  file: string
  bytes: number
  /** SHA-256 of the file, checked once it has downloaded. */
  sha256: string
  /** Speaks only English; the others detect the language. */
  englishOnly?: boolean
}

export const LOCAL_SPEECH_MODELS: LocalSpeechModel[] = [
  {
    id: 'base',
    label: 'Whisper Base',
    blurb: 'Fast, for short notes',
    file: 'ggml-base.bin',
    bytes: 147951465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
  },
  {
    id: 'small',
    label: 'Whisper Small',
    blurb: 'More accurate, still quick',
    file: 'ggml-small.bin',
    bytes: 487601967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'
  },
  {
    id: 'large-v3-turbo',
    label: 'Whisper Large v3 Turbo',
    blurb: 'Most accurate, best on Apple silicon or a GPU',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
  }
]

export const localSpeechModel = (id: string | null | undefined): LocalSpeechModel | undefined => LOCAL_SPEECH_MODELS.find((m) => m.id === id)

/**
 * The model on this computer to offer where dictation isn't set up: the one
 * picked (`pickedId`, when a local model is), else one already downloaded,
 * else the quickest to download.
 */
export function offeredSpeechModel(pickedId: string | null, downloaded: readonly string[] = []): LocalSpeechModel {
  return localSpeechModel(pickedId) ?? localSpeechModel(downloaded[0]) ?? LOCAL_SPEECH_MODELS[0]
}

/** Where a model downloads from. */
export const localSpeechUrl = (model: LocalSpeechModel): string => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.file}`

/** What Settings shows of the local models: which are downloaded, and any download in progress. */
export interface LocalSpeechState {
  /** Whether this build of Eaon has whisper-server for this machine. */
  available: boolean
  downloaded: string[]
  /** The model downloading now, and how far along (0–1). */
  downloading: { id: string; progress: number } | null
  error: string | null
}
