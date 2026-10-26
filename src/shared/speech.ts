/**
 * Speech to text for dictation: which providers can turn a recording into
 * text, and the models each offers. All of them take the same request —
 * OpenAI's `POST /audio/transcriptions`, multipart, with `file` and `model` —
 * so any custom or local provider that speaks it (a whisper.cpp or
 * faster-whisper server, say) works too, with a model from its own list.
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

/**
 * Built-in local runtimes that only run chat models: none of them serves
 * /audio/transcriptions, so they're never offered for speech (Eaon's own
 * "On this computer" runs GGUF chat models with llama.cpp; speech on this
 * computer is LOCAL_SPEECH_ID). vLLM can serve Whisper, so it stays.
 */
const CHAT_ONLY_RUNTIMES = new Set(['eaon-local', 'ollama', 'lm-studio', 'llama-cpp', 'mlx', 'jan'])

/** Whether a provider can be asked to turn speech into text. */
export function canTranscribe(provider: { id: string }): boolean {
  return !CHAT_ONLY_RUNTIMES.has(provider.id)
}

/** A model id that reads like speech to text, so a provider's own list shows those first. */
export const looksLikeSpeechModel = (id: string): boolean => /whisper|transcri|speech|\bstt\b|\basr\b|voxtral|parakeet|canary|scribe/i.test(id)

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
  /** Found on Hugging Face (Settings → Speech to text → Find more): the repo it came from. */
  repoId?: string
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

/** One of the models above, or one downloaded from Hugging Face when `hub` (LocalSpeechState.hub) is given. */
export const localSpeechModel = (id: string | null | undefined, hub: readonly LocalSpeechModel[] = []): LocalSpeechModel | undefined =>
  LOCAL_SPEECH_MODELS.find((m) => m.id === id) ?? hub.find((m) => m.id === id)

/**
 * The model on this computer to offer where dictation isn't set up: the one
 * picked (`pickedId`, when a local model is), else one already downloaded,
 * else the quickest to download.
 */
export function offeredSpeechModel(pickedId: string | null, state: Pick<LocalSpeechState, 'downloaded' | 'hub'> | null = null): LocalSpeechModel {
  const hub = state?.hub ?? []
  return localSpeechModel(pickedId, hub) ?? localSpeechModel(state?.downloaded[0], hub) ?? LOCAL_SPEECH_MODELS[0]
}

/* ------------------------------------------------- more from Hugging Face */

/** A Hugging Face model's id here: where it came from, so it can't clash with the models above. */
export const hubSpeechId = (repoId: string, filename: string): string => `hf:${repoId}/${filename}`

/** The id a file from Hugging Face goes by: one of the listed models' when it's that very file, so it isn't kept twice. */
export function speechIdFor(repoId: string, filename: string): string {
  const listed = repoId === OFFICIAL_SPEECH_REPO ? LOCAL_SPEECH_MODELS.find((m) => m.file === filename) : undefined
  return listed?.id ?? hubSpeechId(repoId, filename)
}

/** A whisper.cpp model file in a Hugging Face repo, offered under Find more. */
export interface SpeechHubFile {
  repoId: string
  filename: string
  label: string
  bytes: number
}

/** A repo with whisper.cpp models in it. */
export interface SpeechHubResult {
  repoId: string
  name: string
  author: string
  downloads: number
  /** ggerganov/whisper.cpp itself: the models whisper.cpp's own authors publish. */
  official: boolean
  files: SpeechHubFile[]
  /** A line under the repo's name: why it's shown for this search. */
  note?: string
}

/**
 * Languages Whisper understands, by the names people search for, with the
 * codes model makers put in repo names ("whisper-small-ja"). Its own
 * multilingual models handle all of them, and others besides.
 */
const LANGUAGES: Record<string, string[]> = {
  arabic: ['ar'], armenian: ['hy'], azerbaijani: ['az'], bengali: ['bn'], bulgarian: ['bg'], catalan: ['ca'], chinese: ['zh', 'cn'],
  croatian: ['hr'], czech: ['cs'], danish: ['da'], dutch: ['nl'], english: ['en'], estonian: ['et'], filipino: ['tl'], finnish: ['fi'],
  french: ['fr'], georgian: ['ka'], german: ['de'], greek: ['el'], hebrew: ['he'], hindi: ['hi'], hungarian: ['hu'], icelandic: ['is'],
  indonesian: ['id'], italian: ['it'], japanese: ['ja', 'jp'], kazakh: ['kk'], korean: ['ko'], latvian: ['lv'], lithuanian: ['lt'],
  malay: ['ms'], marathi: ['mr'], norwegian: ['no'], persian: ['fa'], polish: ['pl'], portuguese: ['pt'], punjabi: ['pa'], romanian: ['ro'],
  russian: ['ru'], serbian: ['sr'], slovak: ['sk'], slovenian: ['sl'], spanish: ['es'], swahili: ['sw'], swedish: ['sv'], tamil: ['ta'],
  telugu: ['te'], thai: ['th'], turkish: ['tr'], ukrainian: ['uk'], urdu: ['ur'], uzbek: ['uz'], vietnamese: ['vi'], welsh: ['cy']
}

/** "Uzbek" for "uz" in a file's name. Not the codes that are also words (is, it, no, id). */
function languageOfCode(word: string): string | null {
  if (/^(is|it|no|id)$/i.test(word)) return null
  const name = Object.keys(LANGUAGES).find((n) => LANGUAGES[n].includes(word.toLowerCase()))
  return name ? name[0].toUpperCase() + name.slice(1) : null
}

/** The language a search names, if it names one: "Uzbek", with the codes repos use for it. */
export function whisperLanguage(query: string): { name: string; codes: string[] } | null {
  const word = query.trim().toLowerCase()
  const codes = LANGUAGES[word]
  return codes ? { name: word[0].toUpperCase() + word.slice(1), codes } : null
}

/**
 * A Hugging Face repo of speech-to-text models (Whisper and the like). The
 * chat-model browser (Settings → Models) flags these: llama.cpp can't run
 * them, and dictation takes its models from Speech to text instead.
 */
export function isSpeechRepo(repo: { id: string; pipeline_tag?: string; tags?: readonly string[] }): boolean {
  if (repo.pipeline_tag === 'automatic-speech-recognition') return true
  if ((repo.tags ?? []).some((t) => t === 'automatic-speech-recognition' || t === 'whisper')) return true
  return /whisper|speech[-_]?to[-_]?text|(^|[-_/])(asr|stt)([-_]|$)/i.test(repo.id)
}

/** The repo whisper.cpp's authors publish their models in, shown first. */
export const OFFICIAL_SPEECH_REPO = 'ggerganov/whisper.cpp'

/** Files in a repo that aren't whisper.cpp models even though they end in .bin: training state, PyTorch and CTranslate2 weights, Core ML parts. */
const NOT_A_MODEL = /(^|\/)(training_args|pytorch_model|optimizer|scheduler|rng_state|model)\.bin$|\.mlmodelc\/|(^|\/)ct2[^/]*\/|coreml/i

/**
 * The files in a repo that look like whisper.cpp models: `.bin` files named
 * for ggml (or in a repo tagged for it), never the other things a repo keeps
 * in `.bin`. GGUF speech models are left out: whisper.cpp can't load them.
 * The download still checks the file's first bytes before keeping it.
 */
export function whisperModelFiles(repoId: string, files: readonly string[], tags: readonly string[] = []): string[] {
  const ggmlRepo = /ggml|whisper\.cpp/i.test(repoId) || tags.some((t) => /^(ggml|whisper\.cpp)$/i.test(t))
  return files.filter((f) => f.toLowerCase().endsWith('.bin') && !NOT_A_MODEL.test(f) && (/ggml/i.test(f.split('/').pop() ?? '') || ggmlRepo))
}

/** A readable name for a model file: "Kotoba Whisper v2.0 · Q5_0", or the repo's name when the file is just "ggml-model.bin". */
export function hubSpeechLabel(repoId: string, filename: string): string {
  const quantOf = (name: string): string => /[-_.](q\d_\d|q\d_k\w*|f16|fp16|f32|fp32)$/i.exec(name)?.[1] ?? ''
  let base = (filename.split('/').pop() ?? filename).replace(/\.(bin|gguf)$/i, '').replace(/^ggml[-_]/i, '')
  const quant = quantOf(base)
  if (quant) base = base.slice(0, -quant.length - 1)
  if (!base || /^model$/i.test(base)) base = (repoId.split('/').pop() ?? repoId).replace(/[-_]ggml(?:[-_]q\d.*)?$/i, '').replace(/^ggml[-_]/i, '')
  const words = base
    .replace(/\.en$/i, ' English')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => languageOfCode(w) ?? (/^[a-z]{3,}$/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
  const named = !/whisper/i.test(words) && /whisper/i.test(repoId) ? `Whisper ${words}` : words
  return quant ? `${named} · ${quant.toUpperCase().replace(/^FP/, 'F')}` : named
}

/** Speaks only English: a ".en" model, as whisper.cpp names them. */
export const hubSpeechEnglishOnly = (filename: string): boolean => /\.en([-_.]|$)/i.test(filename.replace(/\.bin$/i, ''))

/** Where a model downloads from. */
export const localSpeechUrl = (model: LocalSpeechModel): string => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.file}`

/** What Settings shows of the local models: which are downloaded, and any download in progress. */
export interface LocalSpeechState {
  /** Whether this build of Eaon has whisper-server for this machine. */
  available: boolean
  downloaded: string[]
  /** The model downloading now, how far along (0–1), and what to call it (a Hugging Face one isn't in the list). */
  downloading: { id: string; progress: number; label: string; bytes: number } | null
  error: string | null
  /** Models downloaded from Hugging Face (Find more), beside the ones above. */
  hub: LocalSpeechModel[]
}
