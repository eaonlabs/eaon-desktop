import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelKind, ChannelLink } from '@shared/channels'
import type { StreamEvent, StreamRequest } from '@shared/types'
import type { WorkerDraft } from '@shared/workers'
import type { RunOptions, RunOutcome } from '../src/main/agent/loop'
import { store } from '../src/main/store'
import { ChannelsService } from '../src/main/features/channels/service'
import { TelegramConnector } from '../src/main/features/channels/telegram'
import type { Connector, ConnectorEvents, IncomingMessage } from '../src/main/features/channels/types'
import { decodeOggOpus, oggOpusToWav, parseOggOpus, VoiceNoteError, wavFromSamples, wavSeconds } from '../src/main/features/voice/oggOpus'
import { MAX_VOICE_NOTE_BYTES, NO_ENGINE, NO_MODEL, transcribeVoiceNote, type VoiceNoteDeps, type VoiceNoteResult } from '../src/main/features/voice/voiceNote'
import type { RunAgent } from '../src/main/features/workers/runner'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import type { FeatureContext } from '../src/main/features/types'

/**
 * Voice notes in chat apps: the Ogg Opus file taken apart and decoded to the
 * WAV the local speech model reads (against real files made by ffmpeg), the
 * rules for when it can't be heard (no engine, no model, too long, empty),
 * and the chat service handling the transcript as text, saying it was a
 * voice note in the reply, and telling the sender plainly when it can't be
 * heard. The speech model itself is faked; nothing here reaches the network.
 */

/** 0.5 s of a 440 Hz tone, mono and stereo, encoded by libopus through ffmpeg. */
const MONO_OGG =
  'T2dnUwACAAAAAAAAAADrcPYlAAAAADZ9+d4BE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAOtw9iUBAAAA3TUkUAE+T3B1c1RhZ3MNAAAATGF2ZjYyLjEyLjEwMQEAAAAdAAAAZW5jb2Rlcj1MYXZjNjIuMjguMTAxIGxpYm9wdXNPZ2dTAAT4XgAAAAAAAOtw9iUCAAAAywpBQRozLigtJDEyMSIyLiknLisvLSQkGxkbJxomFUiCLrdsVrf0AAFMsZmtEOzwy//kssrLH+u/teMwJT4ia8mya8edDAJqGlSo9okkLn6Mk0ikiFesmIUDXCYJ1236gS+G25FOubxNd0ZXisnfa2OAaIb3x4EgDa9Iq3VV8iBInBtST9nJoUh+n2aTarJwcSmp/erNhZ6l5jUx9vkRXvPXO6M38cr+SJwbUlbOIipE7SYf+bVvKEt8JlQMis0pK3pOFAukPlGjZhbwUmc0InMRLtgUSJwbn3Wc/EWecn+QogpDWn6z+Thw84a9/GmUY0wra2AzfefpSJwbV0vdtkUVHZxlpZzac5OeBqNYR5tNSuBFmurRGlVwuwtpEM6HvzKhNwSgNyqmgEicG1G0HL9ST+ck687BeNsVssGl2+A2nbUEKMiK+KRyYSlWY4GvzPXRAlC65zp1ufZkSJwbUlbOI4f2+HrWBGTqA4qF3Sb7dG/bHaRV15RMF5jgGQP+UeFowFiNHVWHfYXyTEicG1JWziIpfwZU2UWN3OVodzcHNFmaSU8tIElYifRj4zJInBtRtBy/or+XGbo+Dbm0JaJar/6Za7j+hW6mxMLg56jndD/ZoVZfacTY85CjX8BrYEicG1dm2lcuzwvYHK2dghrsdp1kgK+yl8BbMGgl+X2eRBUyHvOHDZyQhMfMKcBInJOSVs4f6xc0/7apg6GpdrQqabHrx9UHI3zwtHKKp8ssaCo8OJYmMEick5JWziOIbj2rlsZEDlQYPK+ayunhn/EaKQfzE3J02XEx+HcnoEick5dm2lIulTygaodf9YCDyHSYMqlunft0kQz1fU97kAgajoo8cWQEjeFzRdxInLlAVbZTK6s5wccDinbeGvrV104ICWdZt0qRrBTRRNtyLz6lk684bFZoSJ1pB0t+iUK9BOirE6u9NtAOOnWr8Z0bHWA4Eb6mdyMNsCvTVteAXqnMwYxFlLhInWj5eFyIWSrZ/BYXN1KRZTqU++16Iiey8G1UQKRMIeJmfXZDnvBj1AlNumxInWj5eFyL41shkqL5CAvzEBa/aegTrhFP0ey11H9r+6RytNBInWkHS3560Jtkq2puEB5VRmLtGFBZH7a2ObJi1bKLUGX0xsBInWj5eFyCAHS6dcuCEBp1EVj4fWhgCKX76CBInWkHS36JOpLNc68937neVwlR+QqbE0+ASJ6plIA2QztGQaWRN/HyK56T2dFzrllBpBaASKBvp//BjYFUCHgQQAcDo85pQgjZ4Wx19ynrLUL5s/gWiz6hfdyYSJ/6ktn9H1xRW0DdmgOZSyK5+nssEWN4i7xIoiZ2trjoBUsXCk0XEtOHsfBdzz7L0n12uK7hbu8+3Lt1No1AwEgGJliGUPrH3k7xO/UTkssulhOHxQ=='
const STEREO_OGG =
  'T2dnUwACAAAAAAAAAADuCAkbAAAAACra33IBE09wdXNIZWFkAQI4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAO4ICRsBAAAAq+TWJwE+T3B1c1RhZ3MNAAAATGF2ZjYyLjEyLjEwMQEAAAAdAAAAZW5jb2Rlcj1MYXZjNjIuMjguMTAxIGxpYm9wdXNPZ2dTAAT4XgAAAAAAAO4ICRsCAAAAOjVsNhpKNSovNS82MDwtKisxKCklHhgXKyIiISIiRniBp11sfkDmAAAKP2RM/ee0WTMmT1bxXb3Io+5XpWXLdWOufb7yfZ58bHIyQg0fvNU3GaiXpxgw8gW9dX0ktMgeOSbVoap1HtADeJ9nAef/g17yqhhwqlyAwCzsVumdGyyY9cnsNp3LAiZqV0vz+B5paeYT4WQuBJrfqkfQAvF4mrKSUUUAqUyLUYKB0ws94t9dGu9GlNbCrMdesLivdvxrnL6YhvsElpJ4mrKRtBy/UiiHKxEP3q4tCHCoJ1GSSqElISFPbujZjgLXZsaLtGmGFmBcpb40Iniast91nPxFnloCrGNtpuWgjmPcpSbwvNWW9UTePDU+IkAVPeSCa6BBDzxjTnltsM8COSPUeJqyl1FfJispjmGnVueWeLIc/shjWXGisZDQsQWSxZ6zg9OOT1GHGQP+G5g0EiV4mrLfdZz8SUkFWd3k8X/bxlsbgNzC5zHqkuuvaPhLNClvlYM6XGO6g9QXrl3PPumBFQKmHoJ4mrKSUUUA0NOkXQ0xM+xsrb1y19EpiyOlix+LkKIPpk0cxu6vSeqoW/+owhCSeoR4mrKRtBy/UlEEBd/rRBl/CQp78EhguSpnptbA1142ZFz5zG/oqWvp9hV1vRvG89W7C6JfFQR8YYvE5aVImjqfdZz8SQ7GkMYVE1+nqyx+yRyMY3QjkuH7XBTpbXeSRkUlToHwf4+G/IdImjpSU6pISh1kz39qr5R8/JORYqgMadJSaI9VbYVSIVo+zgix8ytYFuBImjqfdZz8SUrq6qvlRw70/ymk8fOeRYWTtdCrCECZHixVZspjgaZcmFI3SJo6UbQcv91UyzPQPsSWT9W2+sXJfx0/PBBrIVfW23rV8CCQNb0lYYF64ygZ3kkIgEiaOp91nPxF72pM3Tgd1GR8tiJ+d8vvxoYSLUy0qSTAsB5XDt4NI6xImjqfdZz8RdDFi7qI5hncde30fh7iD6Q00RA4uk+rDHYDASW3bes2UEiaOlJTqkS65vtrIn8Aqr3zAZ1ExY54kiadxL6oXfLnbns7ioBImjqfdZz8SUoiLe8YNAc8x4Qb7TJx9at/1ZkWNUBImjpXUV8mLsrHme5F6CPOmyryUDv0valImjqfdZz8SUovhETtW11DHJ2mFXgcwEiaOp91nPxF0MV7z0aZmjWqgRU8Z/+H3emy0cxhHEjzvIJWwhTrUCEewmKYrax3uY1uYLrNipC2VEv+wHzxGxwN9C0Eil9HKqPZT6HumLFymlLp8L5BoZVM77gSCAyzNeGy7+pyIdhZY3NN8/qv7piwRXBHnXigMzLfZPjrVx6prySKIXEtOMCEuJJ2UyXx7piwRX1nH4w2HOnK4rYvEUpXZALW5v6B2FphAN2lOm91b+6Yr+kgRw924t9hEaK8+fadOu02dldzQFWRIkHuQSMwBknu2LUsLeXcQ9P6n35pPrr/78kbITRvtlxz2BjvuliIwboSwONYHNPpwPUx1uouvh4stR4N702QXSUsoDuGP4LvsekU8q04rA=='

const bytes = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'))

/* --------------------------------------------------------------- the Ogg file */

/** An Ogg page: `flags` 1 continues a packet, 2 starts the stream, 4 ends it. `lacing` is written as given. */
function page(serial: number, sequence: number, flags: number, lacing: number[], body: Uint8Array): Uint8Array {
  const out = new Uint8Array(27 + lacing.length + body.length)
  out.set([0x4f, 0x67, 0x67, 0x53, 0, flags])
  const view = new DataView(out.buffer)
  view.setUint32(14, serial, true)
  view.setUint32(18, sequence, true)
  out[26] = lacing.length
  out.set(lacing, 27)
  out.set(body, 27 + lacing.length)
  return out
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function opusHead(channels: number, preSkip: number, family = 0): Uint8Array {
  const head = new Uint8Array(19)
  head.set(Buffer.from('OpusHead'))
  head[8] = 1
  head[9] = channels
  new DataView(head.buffer).setUint16(10, preSkip, true)
  head[18] = family
  return head
}

const tags = new Uint8Array([...Buffer.from('OpusTags'), 0, 0, 0, 0, 0, 0, 0, 0])

test('an Ogg Opus file is taken apart into its headers and audio packets, including packets that span lacing values and pages', () => {
  const big = new Uint8Array(600).fill(7) // 255 + 255 + 90
  const small = new Uint8Array([1, 2, 3])
  const head = opusHead(1, 312)
  const file = concat(
    page(9, 0, 2, [head.length], head),
    page(9, 1, 0, [tags.length], tags),
    // The 600-byte packet, then a second packet that carries over to the next page: its first 255 bytes end the page on a 255.
    page(9, 2, 0, [255, 255, 90, 3, 255], concat(big, small, new Uint8Array(255).fill(9))),
    page(9, 3, 5, [45], new Uint8Array(45).fill(9)),
    // Another stream chained after the first is not part of this recording.
    page(77, 0, 2, [head.length], head)
  )
  const stream = parseOggOpus(file)
  assert.equal(stream.channels, 1)
  assert.equal(stream.preSkip, 312)
  assert.deepEqual(stream.packets.map((p) => p.length), [600, 3, 300])
  assert.deepEqual([...stream.packets[1]], [1, 2, 3])
  assert.ok(stream.packets[2].every((b) => b === 9), 'the packet split across two pages is whole again')
})

test('what is not an Ogg Opus voice note is refused with a reason, not decoded to noise', async () => {
  assert.throws(() => parseOggOpus(new Uint8Array(Buffer.from('ID3 this is an mp3, not an ogg file at all, padding padding'))), VoiceNoteError)
  const head = opusHead(1, 0)
  assert.throws(() => parseOggOpus(page(1, 0, 2, [head.length], head)), /isn’t an Ogg Opus/, 'one packet is a stream with no audio')
  const vorbis = new Uint8Array(19)
  vorbis.set(Buffer.from('\x01vorbis'))
  assert.throws(() => parseOggOpus(concat(page(1, 0, 2, [19], vorbis), page(1, 1, 0, [tags.length], tags))), /isn’t an Opus/)
  const surround = opusHead(6, 0, 1)
  assert.throws(() => parseOggOpus(concat(page(1, 0, 2, [19], surround), page(1, 1, 0, [tags.length], tags))), /audio layout/)
  await assert.rejects(oggOpusToWav(new Uint8Array(0)), VoiceNoteError)
  // A download cut short keeps the pages that arrived whole.
  const whole = bytes(MONO_OGG)
  const cut = parseOggOpus(whole.subarray(0, whole.length - 40))
  assert.ok(cut.packets.length < parseOggOpus(whole).packets.length)
})

/** The frequency of a tone from how often it crosses zero. */
function hertz(samples: Float32Array, rate: number): number {
  let crossings = 0
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 !== samples[i] < 0) crossings++
  return crossings / 2 / (samples.length / rate)
}

test('a real voice note decodes to 16 kHz mono audio of the right length and pitch, mono or stereo', async () => {
  for (const [name, file] of [['mono', MONO_OGG], ['stereo', STEREO_OGG]] as const) {
    const samples = await decodeOggOpus(bytes(file))
    assert.ok(Math.abs(samples.length / 16_000 - 0.5) < 0.04, `${name}: about half a second, got ${samples.length / 16_000}`)
    const peak = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0)
    assert.ok(peak > 0.05, `${name}: audible, peak ${peak}`)
    assert.ok(Math.abs(hertz(samples, 16_000) - 440) < 25, `${name}: a 440 Hz tone, got ${hertz(samples, 16_000)}`)
  }
  const wav = await oggOpusToWav(bytes(MONO_OGG))
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString(), 'RIFF')
  assert.equal(Buffer.from(wav.subarray(8, 16)).toString(), 'WAVEfmt ')
  const view = new DataView(wav.buffer, wav.byteOffset)
  assert.deepEqual([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)], [1, 1, 16_000, 16])
  assert.equal(view.getUint32(40, true), wav.length - 44)
  assert.ok(Math.abs(wavSeconds(wav) - 0.5) < 0.04)
  assert.equal(wavSeconds(wavFromSamples(new Float32Array(32_000))), 2)
})

/* -------------------------------------------------- when it can't be heard */

const wavOf = (seconds: number): Uint8Array => wavFromSamples(new Float32Array(Math.round(seconds * 16_000)))

function deps(extra: Partial<VoiceNoteDeps> = {}) {
  const heard: { model: string; seconds: number }[] = []
  const d: VoiceNoteDeps = {
    state: async () => ({ available: true, downloaded: ['base', 'small'] }),
    preferred: () => null,
    transcribe: async (wav, model) => {
      heard.push({ model, seconds: wavSeconds(wav) })
      return 'Remind me to call the dentist at four.'
    },
    label: (id) => `Whisper ${id}`,
    decode: async () => wavOf(2),
    ...extra
  }
  return { d, heard }
}

test('a voice note is transcribed by a model downloaded here, preferring the one dictation is set to', async () => {
  const a = deps()
  assert.deepEqual(await transcribeVoiceNote(new Uint8Array(10), a.d), { ok: true, text: 'Remind me to call the dentist at four.', model: 'Whisper base' })
  assert.deepEqual(a.heard, [{ model: 'base', seconds: 2 }])
  const b = deps({ preferred: () => 'small' })
  assert.equal((await transcribeVoiceNote(new Uint8Array(10), b.d)).ok, true)
  assert.equal(b.heard[0].model, 'small')
  const c = deps({ preferred: () => 'large' })
  await transcribeVoiceNote(new Uint8Array(10), c.d)
  assert.equal(c.heard[0].model, 'base', 'a preferred model that isn’t downloaded is not used')
})

test('without a speech engine or model, it says so plainly and transcribes nothing', async () => {
  const noEngine = deps({ state: async () => ({ available: false, downloaded: ['base'] }) })
  assert.deepEqual(await transcribeVoiceNote(new Uint8Array(10), noEngine.d), { ok: false, reason: 'no-engine', message: NO_ENGINE })
  const noModel = deps({ state: async () => ({ available: true, downloaded: [] }) })
  assert.deepEqual(await transcribeVoiceNote(new Uint8Array(10), noModel.d), { ok: false, reason: 'no-model', message: NO_MODEL })
  assert.match(NO_MODEL, /No speech model is installed/)
  assert.equal(noEngine.heard.length + noModel.heard.length, 0)
})

test('too long, unreadable, silent and failed voice notes each get their own reason', async () => {
  const big = await transcribeVoiceNote(new Uint8Array(MAX_VOICE_NOTE_BYTES + 1), deps().d)
  assert.equal(big.ok === false && big.reason, 'too-long')
  const long = await transcribeVoiceNote(new Uint8Array(10), deps({ decode: async () => wavOf(601) }).d)
  assert.equal(long.ok === false && long.reason, 'too-long')
  const tap = await transcribeVoiceNote(new Uint8Array(10), deps({ decode: async () => wavOf(0.1) }).d)
  assert.equal(tap.ok === false && tap.reason, 'empty')
  const mp3 = await transcribeVoiceNote(new Uint8Array(10), deps({ decode: oggOpusToWav }).d)
  assert.equal(mp3.ok === false && mp3.reason, 'unreadable')
  assert.match((mp3 as { message: string }).message, /couldn’t open that voice note/)
  const noise = await transcribeVoiceNote(new Uint8Array(10), deps({ transcribe: async () => ' [BLANK_AUDIO] (music) ' }).d)
  assert.equal(noise.ok === false && noise.reason, 'empty')
  const broken = await transcribeVoiceNote(new Uint8Array(10), deps({ transcribe: async () => { throw new Error('whisper-server exited') } }).d)
  assert.equal(broken.ok === false && broken.reason, 'failed')
  assert.match((broken as { message: string }).message, /whisper-server exited/)
})

test('a voice note never goes to the network: only the injected local model is called', async () => {
  const real = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    throw new Error('network is off')
  }) as typeof fetch
  try {
    const result = await transcribeVoiceNote(bytes(MONO_OGG), { ...deps().d, decode: oggOpusToWav, transcribe: async () => 'hello there' })
    assert.equal(result.ok, true)
  } finally {
    globalThis.fetch = real
  }
  assert.equal(calls, 0)
})

/* ------------------------------------------------------------- Telegram */

test('Telegram hands a voice note on to be heard, with its length, and downloads it only when asked', async () => {
  const calls: string[] = []
  let polled = 0
  const server = createServer((req, res) => {
    calls.push(req.url!)
    const ok = (result: unknown): void => void res.end(JSON.stringify({ ok: true, result }))
    if (req.url!.endsWith('/getMe')) return ok({ id: 42, is_bot: true, first_name: 'Nova', username: 'NovaBot' })
    if (req.url!.endsWith('/setMyCommands') || req.url!.endsWith('/sendChatAction')) return ok(true)
    if (req.url!.endsWith('/getUpdates')) {
      polled++
      if (polled > 1) return void setTimeout(() => ok([]), 2000)
      return ok([{ update_id: 1, message: { message_id: 5, date: 0, from: { id: 6, is_bot: false, first_name: 'Cal' }, chat: { id: 6, type: 'private' }, voice: { file_id: 'F1', duration: 7, file_size: 1222, mime_type: 'audio/ogg' } } }])
    }
    if (req.url!.endsWith('/getFile')) return ok({ file_path: 'voice/file_0.oga' })
    if (req.url!.includes('/file/bot')) return void res.end(Buffer.from(MONO_OGG, 'base64'))
    res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const received: IncomingMessage[] = []
  const connector = new TelegramConnector('123:abc', { message: (m) => received.push(m), status: () => {}, account: () => {} }, `http://127.0.0.1:${port}`)
  connector.start()
  try {
    const started = Date.now()
    while (received.length === 0) {
      if (Date.now() - started > 5000) throw new Error('timed out waiting')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const message = received[0]
    assert.equal(message.unsupported, undefined)
    assert.equal(message.text, '')
    assert.deepEqual([message.voice?.seconds, message.voice?.size], [7, 1222])
    assert.ok(!calls.some((c) => c.includes('/file/bot')), 'nothing is downloaded until someone asks')
    const audio = await message.voice!.download()
    assert.deepEqual(new Uint8Array(audio), bytes(MONO_OGG))
  } finally {
    await connector.stop()
    server.close()
  }
})

/* -------------------------------------------------- the chat service itself */

const MODEL = { providerId: 'ollama', modelId: 'fake-model' }
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }

let workers: WorkersService | null = null
let channels: ChannelsService | null = null

beforeEach(() => {
  store.setJson('workers.json', [])
  const root = mkdtempSync(join(tmpdir(), 'eaon-voice-notes-'))
  const settings = store.getSettings()
  store.patchSettings({ work: { ...settings.work, defaultFolder: root } })
})

afterEach(async () => {
  await channels?.stop()
  channels = null
  workers?.stop()
  await workers?.engine.whenIdle()
  workers = null
  await store.flushWrites()
})

async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const fakeContext = (): FeatureContext => ({ ipcMain: { handle: () => {} }, getWindow: () => null, send: () => {}, emitStream: () => {} }) as unknown as FeatureContext

class FakeConnector implements Connector {
  readonly typingEveryMs = 60_000
  sent: { chatId: string; text: string }[] = []
  constructor(
    readonly kind: ChannelKind,
    readonly events: ConnectorEvents
  ) {}
  start(): void {
    this.events.status({ state: 'connected' })
  }
  async stop(): Promise<void> {}
  async send(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text })
  }
  async sendFile(): Promise<void> {}
  async typing(): Promise<void> {}
  async directChat(userId: string): Promise<string> {
    return `dm-${userId}`
  }
  said = (): string[] => this.sent.map((s) => s.text)
}

function setup(transcribeVoice: ((audio: Uint8Array) => Promise<VoiceNoteResult>) | undefined) {
  const requests: StreamRequest[] = []
  const options: RunOptions[] = []
  const runAgent: RunAgent = async (request, emit: (e: StreamEvent) => void, opts): Promise<RunOutcome> => {
    requests.push(structuredClone(request))
    options.push(opts)
    emit({ type: 'delta', messageId: request.messageId, text: 'Done, it is in your calendar.' })
    emit({ type: 'done', messageId: request.messageId })
    return { text: 'Done, it is in your calendar.', usage }
  }
  workers = createWorkersService(fakeContext(), { runAgent, startDelayMs: 60_000 })
  workers.start()
  workers.engine.start()
  const connectors = new Map<string, FakeConnector>()
  let saved: ChannelLink[] = []
  channels = new ChannelsService({
    engine: workers.engine,
    loadLinks: () => saved,
    saveLinks: (links) => (saved = structuredClone(links)),
    getToken: () => 'token',
    setToken: () => {},
    verifyToken: async () => ({ account: '@NovaBot', id: 'app-1' }),
    createConnector: (link, _token, events) => {
      const connector = new FakeConnector(link.kind, events)
      connectors.set(link.id, connector)
      return connector
    },
    transcribeVoice
  })
  channels.load()
  channels.start()
  return { engine: workers.engine, channels, connectors, requests, options }
}

let nextId = 1
function incoming(extra: Partial<IncomingMessage>): IncomingMessage {
  return { chatId: 'owner-chat', chatName: 'Direct message', isGroup: false, senderId: 'owner', senderName: 'Sam', messageId: `m${nextId++}`, text: '', mentioned: false, files: [], ...extra }
}

const voiceNote = (seconds: number | null = 5) => ({ download: async () => Buffer.from(MONO_OGG, 'base64'), seconds, size: 1222 })

async function pairedTelegram(env: ReturnType<typeof setup>) {
  const draft: WorkerDraft = { name: 'Nova', color: '#3E86C6', personality: '', purpose: 'Helps', model: MODEL }
  const nova = env.engine.save(draft)
  const link = env.channels.create('telegram', nova.id)
  await env.channels.setToken(link.id, '123:token')
  const connector = env.connectors.get(link.id)!
  await env.channels.handle(link.id, incoming({ text: `/pair ${env.channels.list()[0].pairCode}` }))
  return { nova, link: env.channels.list()[0], connector }
}

const lastText = (request: StreamRequest): string => request.history[request.history.length - 1].parts.map((p) => (p.type === 'text' ? p.text : '')).join('')

test('a voice note from the owner is handled as the text it says, and the reply says it was a voice note', async () => {
  const heard: number[] = []
  const env = setup(async (audio) => {
    heard.push(audio.byteLength)
    return { ok: true, text: 'Put the dentist in my calendar for four.', model: 'Whisper Base' }
  })
  const { link, connector } = await pairedTelegram(env)
  await env.channels.handle(link.id, incoming({ voice: voiceNote(), messageId: 'v1' }))
  await until(() => env.requests.length === 1)
  await env.engine.whenIdle()
  await until(() => connector.said().length >= 2)

  assert.deepEqual(heard, [bytes(MONO_OGG).length], 'the audio went to the local transcriber')
  const text = lastText(env.requests[0])
  assert.match(text, /\[From the user, in a direct message on Telegram\] \[Voice note, transcribed on this computer, so a word may be wrong\] Put the dentist in my calendar for four\./)
  assert.equal(env.options[0].unattended, 'autonomous', 'the owner’s voice runs with the worker’s own access, like their typing')
  assert.equal(connector.said().at(-1), '(Voice note, heard as “Put the dentist in my calendar for four.”)\n\nDone, it is in your calendar.')
})

test('a caption is kept beside the transcript, and a long transcript is trimmed in the reply but not for the worker', async () => {
  const long = `${'word '.repeat(100)}end`
  const env = setup(async () => ({ ok: true, text: long, model: 'Whisper Base' }))
  const { link, connector } = await pairedTelegram(env)
  await env.channels.handle(link.id, incoming({ voice: voiceNote(), text: 'about tomorrow' }))
  await until(() => env.requests.length === 1)
  await env.engine.whenIdle()
  await until(() => connector.said().length >= 2)
  assert.match(lastText(env.requests[0]), /about tomorrow\n\[Voice note, transcribed on this computer, so a word may be wrong\] word word/)
  assert.ok(lastText(env.requests[0]).includes(long), 'the worker gets all of it')
  const reply = connector.said().at(-1)!
  assert.match(reply, /^\(Voice note, heard as “word word.*…”\)\n\nDone/)
  assert.ok(reply.length < long.length)
})

test('with no speech model installed the owner is told so and where to fix it, and the worker is not woken', async () => {
  const env = setup(async () => ({ ok: false, reason: 'no-model', message: NO_MODEL }))
  const { link, connector } = await pairedTelegram(env)
  const before = connector.said().length
  await env.channels.handle(link.id, incoming({ voice: voiceNote() }))
  assert.equal(connector.said().length, before + 1)
  assert.match(connector.said().at(-1)!, /^No speech model is installed, so Eaon can’t listen to voice notes yet\. Download one in Eaon → Settings → Model providers → Speech to text/)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(env.requests.length, 0, 'nothing to act on, so no model call')
})

test('without any transcriber (a computer with no speech engine) the answer is the same plain one, and a caption still goes through', async () => {
  const env = setup(undefined)
  const { link, connector } = await pairedTelegram(env)
  await env.channels.handle(link.id, incoming({ voice: voiceNote(), text: 'what is on today?' }))
  assert.equal(connector.said().at(-1), NO_ENGINE)
  await until(() => env.requests.length === 1)
  assert.match(lastText(env.requests[0]), /what is on today\?\n\(Also sent a voice note, which couldn’t be heard\.\)/)
  await env.engine.whenIdle()
})

test('a voice note too long to bother transcribing is turned away without downloading it', async () => {
  let downloaded = 0
  let transcribed = 0
  const env = setup(async () => {
    transcribed++
    return { ok: true, text: 'x', model: 'm' }
  })
  const { link, connector } = await pairedTelegram(env)
  await env.channels.handle(link.id, incoming({ voice: { download: async () => (downloaded++, Buffer.alloc(1)), seconds: 3600, size: 1000 } }))
  assert.match(connector.said().at(-1)!, /too long/)
  assert.deepEqual([downloaded, transcribed], [0, 0])
})

test('a download that fails is reported, not swallowed', async () => {
  const env = setup(async () => ({ ok: true, text: 'x', model: 'm' }))
  const { link, connector } = await pairedTelegram(env)
  await env.channels.handle(link.id, incoming({ voice: { download: async () => { throw new Error('Telegram only lets bots download files up to 20 MB.') }, seconds: 5, size: null } }))
  assert.match(connector.said().at(-1)!, /couldn’t get that voice note: Telegram only lets bots download files up to 20 MB/)
})

/** Lets a friend in the way the owner does: the friend asks, the owner allows. */
async function letIn(env: ReturnType<typeof setup>, linkId: string): Promise<void> {
  await env.channels.handle(linkId, incoming({ senderId: 'friend', chatId: 'friend-chat', senderName: 'Cal', text: 'hi' }))
  env.channels.allow(linkId, env.channels.list()[0].requests[0].code)
  env.channels.update(linkId, { guestAccess: 'talk' })
}

test('a guest’s voice note is heard like their typing: held to the guest’s cap, and answered in their own chat', async () => {
  const env = setup(async () => ({ ok: true, text: 'what is the weather', model: 'Whisper Base' }))
  const { link, connector } = await pairedTelegram(env)
  await letIn(env, link.id)
  await env.engine.whenIdle()
  const asked = env.requests.length
  await env.channels.handle(link.id, incoming({ senderId: 'friend', chatId: 'friend-chat', senderName: 'Cal', voice: voiceNote() }))
  await until(() => env.requests.length === asked + 1)
  await env.engine.whenIdle()
  assert.match(lastText(env.requests[asked]), /\[From Cal, in a direct message on Telegram — a guest, not the user\] \[Voice note, transcribed on this computer/)
  assert.equal(env.options[asked].unattended, 'read-only', 'a talk-only guest’s turn is held to read-only and gated')
  assert.ok(env.options[asked].toolGate)
  await until(() => connector.sent.some((s) => s.chatId === 'friend-chat' && s.text.startsWith('(Voice note, heard as')))
})

test('a guest whose voice notes can’t be heard is told once, without being sent to the owner’s settings', async () => {
  const env = setup(async () => ({ ok: false, reason: 'no-model', message: NO_MODEL }))
  const { link, connector } = await pairedTelegram(env)
  await letIn(env, link.id)
  await env.engine.whenIdle()
  const before = connector.sent.filter((s) => s.chatId === 'friend-chat').length
  const asked = env.requests.length
  await env.channels.handle(link.id, incoming({ senderId: 'friend', chatId: 'friend-chat', senderName: 'Cal', voice: voiceNote() }))
  await env.channels.handle(link.id, incoming({ senderId: 'friend', chatId: 'friend-chat', senderName: 'Cal', voice: voiceNote() }))
  const said = connector.sent.filter((s) => s.chatId === 'friend-chat').slice(before)
  assert.equal(said.length, 1, 'told once, not every time')
  assert.equal(said[0].text, NO_MODEL)
  assert.equal(env.requests.length, asked)
})
