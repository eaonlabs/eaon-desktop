/**
 * Speech to text for dictation in the composers. The audio is recorded in the
 * renderer (MediaRecorder, webm/opus) and sent here; this sends it to the
 * first provider the user has a key for. OpenAI first, then Groq, which runs
 * Whisper fast and cheaply. Nothing is sent anywhere without a saved key.
 */

export interface Transcriber {
  provider: 'openai' | 'groq'
  label: string
  url: string
  /** Tried in order: a model the account can't use falls through to the next. */
  models: string[]
}

export const TRANSCRIBERS: Transcriber[] = [
  { provider: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1/audio/transcriptions', models: ['gpt-4o-mini-transcribe', 'whisper-1'] },
  { provider: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1/audio/transcriptions', models: ['whisper-large-v3-turbo'] }
]

/** Both providers refuse files over 25 MB; ten minutes of opus is a few MB. */
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024

export const NO_KEY_MESSAGE =
  'Dictation needs an OpenAI or Groq API key. Add one in Settings → Model providers, then try again.'

export function pickTranscriber(getKey: (providerId: string) => string | undefined): { transcriber: Transcriber; key: string } | null {
  for (const transcriber of TRANSCRIBERS) {
    const key = getKey(transcriber.provider)?.trim()
    if (key) return { transcriber, key }
  }
  return null
}

export interface TranscribeDeps {
  getKey: (providerId: string) => string | undefined
  fetch?: typeof fetch
  timeoutMs?: number
}

/** The file name the provider sees; its extension is how it tells the format. */
function fileNameFor(mimeType: string): string {
  if (/mp4|m4a|aac/.test(mimeType)) return 'speech.m4a'
  if (/ogg/.test(mimeType)) return 'speech.ogg'
  if (/wav/.test(mimeType)) return 'speech.wav'
  return 'speech.webm'
}

/** One request, as multipart form data, the way both APIs take it. */
export function transcriptionRequest(audio: Uint8Array, mimeType: string, model: string, key: string): RequestInit {
  const form = new FormData()
  form.append('file', new Blob([audio], { type: mimeType || 'audio/webm' }), fileNameFor(mimeType))
  form.append('model', model)
  form.append('response_format', 'json')
  return { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form }
}

class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly modelProblem: boolean
  ) {
    super(message)
  }
}

async function errorFrom(response: Response, label: string): Promise<ProviderError> {
  let detail = ''
  try {
    const body = (await response.json()) as { error?: { message?: string; code?: string } }
    detail = body.error?.message ?? ''
    const code = body.error?.code ?? ''
    const modelProblem = /model/i.test(code) || /model/i.test(detail)
    if (response.status === 401) return new ProviderError(`${label} didn't accept the API key saved in Eaon. Check it in Settings → Model providers.`, 401, false)
    if (response.status === 429) return new ProviderError(`${label} is rate-limiting this key, or its quota is used up. Try again in a moment.`, 429, false)
    return new ProviderError(`${label} couldn't transcribe the recording (${response.status}${detail ? `: ${detail}` : ''}).`, response.status, modelProblem)
  } catch {
    return new ProviderError(`${label} couldn't transcribe the recording (${response.status}).`, response.status, false)
  }
}

/**
 * Turns a recording into text. Throws with a message meant for the user: no
 * key, a refused key, an empty or oversized recording, or what the provider said.
 */
export async function transcribe(audio: Uint8Array, mimeType: string, deps: TranscribeDeps): Promise<{ text: string; provider: string }> {
  if (audio.byteLength === 0) throw new Error('Nothing was recorded.')
  if (audio.byteLength > MAX_AUDIO_BYTES) throw new Error('That recording is too long to transcribe. Keep it under ten minutes.')
  const chosen = pickTranscriber(deps.getKey)
  if (!chosen) throw new Error(NO_KEY_MESSAGE)
  const { transcriber, key } = chosen
  const send = deps.fetch ?? fetch

  let last: Error | null = null
  for (const model of transcriber.models) {
    let response: Response
    try {
      response = await send(transcriber.url, { ...transcriptionRequest(audio, mimeType, model, key), signal: AbortSignal.timeout(deps.timeoutMs ?? 120_000) })
    } catch (error) {
      const reason = (error as Error).name === 'TimeoutError' ? 'it took too long' : (error as Error).message
      throw new Error(`Couldn't reach ${transcriber.label} to transcribe (${reason}).`)
    }
    if (response.ok) {
      const body = (await response.json()) as { text?: unknown }
      return { text: typeof body.text === 'string' ? body.text.trim() : '', provider: transcriber.label }
    }
    const error = await errorFrom(response, transcriber.label)
    last = error
    // A model this account can't use: try the next one. Anything else is final.
    if (!(error.modelProblem && (error.status === 400 || error.status === 403 || error.status === 404))) throw error
  }
  throw last ?? new Error(`${transcriber.label} couldn't transcribe the recording.`)
}
