import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_AUDIO_BYTES, NO_KEY_MESSAGE, pickTranscriber, transcribe } from '../src/main/features/voice/transcribe'
import { followLevel, formatElapsed, levelFromSamples } from '../src/renderer/src/components/composer/voiceLevel'
import { joinTranscript } from '../src/renderer/src/components/composer/useDictation'

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
