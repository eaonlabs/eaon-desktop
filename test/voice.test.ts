import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_AUDIO_BYTES, NO_KEY_MESSAGE, pickTranscriber, transcribe } from '../src/main/features/voice/transcribe'
import { followLevel, formatElapsed, levelFromSamples } from '../src/renderer/src/components/composer/voiceLevel'
import { joinTranscript } from '../src/renderer/src/components/composer/useDictation'
import { canTranscribe, hubSpeechEnglishOnly, hubSpeechId, hubSpeechLabel, isSpeechRepo, offeredSpeechModel, whisperModelFiles } from '../src/shared/speech'

/**
 * Dictation turns a recording into text with the user's own OpenAI or Groq
 * key. A fake fetch stands in for both: nothing here reaches a real API.
 */

const audio = new Uint8Array([1, 2, 3, 4])
const keys = (map: Record<string, string>) => (id: string) => map[id]

interface Sent {
  url: string
  auth: string | null
  model: string | null
  file: File | null
}

function fakeFetch(answers: { status: number; body: unknown }[]) {
  const sent: Sent[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    const form = init.body as FormData
    sent.push({
      url,
      auth: new Headers(init.headers).get('authorization'),
      model: form.get('model') as string | null,
      file: form.get('file') as File | null
    })
    const answer = answers[Math.min(sent.length - 1, answers.length - 1)]
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { fetch, sent }
}

test('OpenAI is used when its key is saved, Groq otherwise, and nothing without either', () => {
  assert.equal(pickTranscriber(keys({ openai: 'sk-a', groq: 'gsk-b' }))?.transcriber.provider, 'openai')
  assert.equal(pickTranscriber(keys({ groq: 'gsk-b' }))?.transcriber.provider, 'groq')
  assert.equal(pickTranscriber(keys({ openai: '  ' })), null, 'a blank key is no key')
  assert.equal(pickTranscriber(keys({})), null)
})

test('a recording goes up as multipart with the key, the model and a file the provider can read', async () => {
  const { fetch, sent } = fakeFetch([{ status: 200, body: { text: '  Book a table for two.  ' } }])
  const result = await transcribe(audio, 'audio/webm;codecs=opus', { getKey: keys({ openai: 'sk-test' }), fetch })
  assert.deepEqual(result, { text: 'Book a table for two.', provider: 'OpenAI' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal(sent[0].auth, 'Bearer sk-test')
  assert.equal(sent[0].model, 'gpt-4o-mini-transcribe')
  assert.equal(sent[0].file?.name, 'speech.webm')
  assert.equal(sent[0].file?.size, audio.byteLength)
})

test('a model the account cannot use falls back to whisper-1', async () => {
  const { fetch, sent } = fakeFetch([
    { status: 404, body: { error: { message: 'The model `gpt-4o-mini-transcribe` does not exist', code: 'model_not_found' } } },
    { status: 200, body: { text: 'hello' } }
  ])
  const result = await transcribe(audio, 'audio/webm', { getKey: keys({ openai: 'sk' }), fetch })
  assert.equal(result.text, 'hello')
  assert.deepEqual(sent.map((s) => s.model), ['gpt-4o-mini-transcribe', 'whisper-1'])
})

test('Groq gets its own endpoint and model', async () => {
  const { fetch, sent } = fakeFetch([{ status: 200, body: { text: 'hi' } }])
  await transcribe(audio, 'audio/mp4', { getKey: keys({ groq: 'gsk' }), fetch })
  assert.equal(sent[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions')
  assert.equal(sent[0].model, 'whisper-large-v3-turbo')
  assert.equal(sent[0].file?.name, 'speech.m4a')
})

test('a speech-to-text model picked in settings is used instead of the automatic choice', async () => {
  // Mistral picked, though an OpenAI key is saved too.
  const mistral = fakeFetch([{ status: 200, body: { text: 'bonjour' } }])
  const choice = { providerId: 'mistral', modelId: 'voxtral-mini-latest', label: 'Mistral' }
  const result = await transcribe(audio, 'audio/webm', { getKey: keys({ openai: 'sk', mistral: 'ms' }), choice, fetch: mistral.fetch })
  assert.deepEqual(result, { text: 'bonjour', provider: 'Mistral' })
  assert.equal(mistral.sent[0].url, 'https://api.mistral.ai/v1/audio/transcriptions')
  assert.equal(mistral.sent[0].model, 'voxtral-mini-latest')
  assert.equal(mistral.sent[0].auth, 'Bearer ms')

  // A local whisper server: its own base URL, a typed model, and no key at all.
  const local = fakeFetch([{ status: 200, body: { text: 'hi' } }])
  const server = { providerId: 'custom-whisper', modelId: 'large-v3', label: 'Whisper box', baseUrl: 'http://127.0.0.1:9000/v1/', keyless: true }
  await transcribe(audio, 'audio/webm', { getKey: keys({}), choice: server, fetch: local.fetch })
  assert.equal(local.sent[0].url, 'http://127.0.0.1:9000/v1/audio/transcriptions')
  assert.equal(local.sent[0].auth, null, 'no empty bearer')

  // Picked but no key: says which provider, rather than asking for OpenAI or Groq.
  await assert.rejects(transcribe(audio, 'audio/webm', { getKey: keys({ openai: 'sk' }), choice }), /set to Mistral, which needs an API key/)
  assert.equal(pickTranscriber(keys({ openai: 'sk' }), choice), null)
})

test('refusals come back as messages a person can act on', async () => {
  await assert.rejects(transcribe(audio, 'audio/webm', { getKey: keys({}) }), { message: NO_KEY_MESSAGE })
  await assert.rejects(transcribe(new Uint8Array(), 'audio/webm', { getKey: keys({ openai: 'sk' }) }), /Nothing was recorded/)
  await assert.rejects(transcribe(new Uint8Array(MAX_AUDIO_BYTES + 1), 'audio/webm', { getKey: keys({ openai: 'sk' }) }), /too long/)

  const bad = fakeFetch([{ status: 401, body: { error: { message: 'Incorrect API key' } } }])
  await assert.rejects(transcribe(audio, 'audio/webm', { getKey: keys({ openai: 'sk' }), fetch: bad.fetch }), /didn't accept the API key/)
  assert.equal(bad.sent.length, 1, 'a refused key is not retried with another model')

  const limited = fakeFetch([{ status: 429, body: { error: { message: 'quota' } } }])
  await assert.rejects(transcribe(audio, 'audio/webm', { getKey: keys({ groq: 'g' }), fetch: limited.fetch }), /rate-limiting/)

  const offline = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof globalThis.fetch
  await assert.rejects(transcribe(audio, 'audio/webm', { getKey: keys({ openai: 'sk' }), fetch: offline }), /Couldn't reach OpenAI/)
})

test('the waveform level: silence is zero, speech climbs, and bars fall slower than they rise', () => {
  assert.equal(levelFromSamples(new Float32Array(512)), 0)
  const quiet = levelFromSamples(new Float32Array(512).fill(0.002))
  const loud = levelFromSamples(new Float32Array(512).fill(0.3))
  assert.ok(quiet < 0.1 && loud > 0.8, `${quiet} ${loud}`)
  assert.ok(levelFromSamples(new Float32Array(512).fill(1)) <= 1)
  const up = followLevel(0, 1)
  const down = 1 - followLevel(1, 0)
  assert.ok(up > down, 'attack is faster than release')
})

test('the timer and the transcript joining the message', () => {
  assert.equal(formatElapsed(7_400), '0:07')
  assert.equal(formatElapsed(102_000), '1:42')
  assert.equal(joinTranscript('', ' Hello there. '), 'Hello there.')
  assert.equal(joinTranscript('Check this:', 'the logs'), 'Check this: the logs')
  assert.equal(joinTranscript('Line one\n', 'line two'), 'Line one\nline two')
  assert.equal(joinTranscript('Keep me', '  '), 'Keep me')
})

test('when the first provider can’t transcribe (key refused, quota, unreachable, down), the next one with a key does', async () => {
  for (const first of [401, 429, 503]) {
    const both = fakeFetch([
      { status: first, body: { error: { message: 'nope' } } },
      { status: 200, body: { text: 'from groq' } }
    ])
    const result = await transcribe(audio, 'audio/webm', { getKey: keys({ openai: 'sk', groq: 'gsk' }), fetch: both.fetch })
    assert.equal(result.text, 'from groq', `after ${first}`)
    assert.equal(result.provider, 'Groq')
    assert.deepEqual(both.sent.map((s) => new URL(s.url).host), ['api.openai.com', 'api.groq.com'])
  }
  // A bad recording is the recording's fault: no second provider is asked.
  const bad = fakeFetch([{ status: 400, body: { error: { message: 'Invalid file format' } } }])
  await assert.rejects(transcribe(audio, 'audio/webm', { getKey: keys({ openai: 'sk', groq: 'gsk' }), fetch: bad.fetch }), /couldn't transcribe the recording \(400/)
  assert.equal(bad.sent.length, 1)
  // Both failing reports the first provider's problem.
  const down = fakeFetch([{ status: 401, body: { error: { message: 'bad key' } } }])
  await assert.rejects(transcribe(audio, 'audio/webm', { getKey: keys({ openai: 'sk', groq: 'gsk' }), fetch: down.fetch }), /OpenAI didn't accept the API key/)
})

test('where dictation isn’t set up, the model offered is the local one picked, else one already downloaded, else the quickest download', () => {
  const kotoba = { id: hubSpeechId('kotoba-tech/kotoba-whisper-v2.0-ggml', 'ggml-kotoba-whisper-v2.0-q5_0.bin'), label: 'Kotoba Whisper v2.0 · Q5_0', blurb: '', file: 'k', bytes: 1, sha256: '', repoId: 'kotoba-tech/kotoba-whisper-v2.0-ggml' }
  assert.equal(offeredSpeechModel('large-v3-turbo', { downloaded: ['small'], hub: [] }).id, 'large-v3-turbo')
  assert.equal(offeredSpeechModel(null, { downloaded: ['small'], hub: [] }).id, 'small')
  assert.equal(offeredSpeechModel(null, { downloaded: [kotoba.id], hub: [kotoba] }).label, 'Kotoba Whisper v2.0 · Q5_0')
  assert.equal(offeredSpeechModel(null).id, 'base')
  assert.equal(offeredSpeechModel('no-such-model').id, 'base')
})

test('from a Hugging Face repo, only whisper.cpp model files are offered: never GGUF, training state, CTranslate2 or Core ML files', () => {
  assert.deepEqual(whisperModelFiles('royshilkrot/whisper-medium-korean-ggml', ['training_args.bin', 'whisper-medium-korean.bin', 'model.safetensors']), ['whisper-medium-korean.bin'])
  assert.deepEqual(whisperModelFiles('BricksDisplay/whisper-ggml', ['ggml-base-encoder.mlmodelc/weights/weight.bin', 'ggml-base-q5_1.bin']), ['ggml-base-q5_1.bin'])
  assert.deepEqual(whisperModelFiles('maleo-ai/whisper-small-id', ['ct2-int8/model.bin', 'ggml-small-id-q8_0.bin', 'pytorch_model.bin']), ['ggml-small-id-q8_0.bin'])
  assert.deepEqual(whisperModelFiles('nizom333/whisper-medium-uzbek-gguf', ['whisper-medium-uzbek-Q8_0.gguf']), [])
  // A .bin in a repo that says nothing of ggml could be anything.
  assert.deepEqual(whisperModelFiles('someone/whisper-small-fr', ['model-weights.bin']), [])
})

test('Hugging Face model files get readable names', () => {
  assert.equal(hubSpeechLabel('ggerganov/whisper.cpp', 'ggml-base.en-q5_1.bin'), 'Whisper Base English · Q5_1')
  assert.equal(hubSpeechLabel('ggerganov/whisper.cpp', 'ggml-large-v3-turbo.bin'), 'Whisper Large v3 Turbo')
  assert.equal(hubSpeechLabel('kotoba-tech/kotoba-whisper-v2.0-ggml', 'ggml-kotoba-whisper-v2.0-q5_0.bin'), 'Kotoba Whisper v2.0 · Q5_0')
  assert.equal(hubSpeechLabel('Limtech/whisper-large-v3-russian-ggml', 'ggml-model.bin'), 'Whisper Large v3 Russian')
  assert.equal(hubSpeechLabel('cstr/whisper-large-v3-turbo-german-ggml', 'ggml-model-q5_0.bin'), 'Whisper Large v3 Turbo German · Q5_0')
  assert.equal(hubSpeechEnglishOnly('ggml-small.en-q8_0.bin'), true)
  assert.equal(hubSpeechEnglishOnly('ggml-small-q8_0.bin'), false)
})

test('chat-only runtimes are never offered for speech, and speech repos are told apart from chat models', () => {
  for (const id of ['eaon-local', 'ollama', 'lm-studio', 'llama-cpp', 'mlx', 'jan']) assert.equal(canTranscribe({ id }), false, id)
  for (const id of ['openai', 'groq', 'vllm', 'custom-whisper']) assert.equal(canTranscribe({ id }), true, id)
  assert.equal(isSpeechRepo({ id: 'nizom333/whisper-medium-uzbek-gguf' }), true)
  assert.equal(isSpeechRepo({ id: 'someone/voxtral-gguf', pipeline_tag: 'automatic-speech-recognition' }), true)
  assert.equal(isSpeechRepo({ id: 'unsloth/Qwen3-8B-GGUF', pipeline_tag: 'text-generation', tags: ['gguf'] }), false)
  assert.equal(isSpeechRepo({ id: 'bartowski/Mistral-Small-Instruct-GGUF' }), false)
})
