/**
 * Voice notes as speech models on this computer take them. Telegram and
 * WhatsApp send voice notes as Ogg files holding Opus audio; whisper.cpp reads
 * only WAV. So this takes the Ogg apart (a few dozen lines: the Ogg container
 * is pages of packets), decodes the Opus packets with libopus compiled to
 * WebAssembly (`opus-decoder`, no native code and no network), and writes the
 * 16 kHz mono 16-bit WAV the speech server wants, as the renderer's
 * `toSpeechWav` does for dictation.
 */

/** What whisper.cpp wants. */
export const SPEECH_RATE = 16_000

export interface OpusStream {
  channels: number
  /** Samples at 48 kHz to drop from the start: the decoder's warm-up. */
  preSkip: number
  /** The Opus audio packets, in order, without the two header packets. */
  packets: Uint8Array[]
}

export class VoiceNoteError extends Error {}

/**
 * The first logical Ogg stream's packets, split into the Opus headers and the
 * audio. Throws `VoiceNoteError` for anything that isn't Ogg Opus (an MP3 or
 * M4A sent as audio, say) or is cut short in a way that would give garbage.
 */
export function parseOggOpus(bytes: Uint8Array): OpusStream {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const packets: Uint8Array[] = []
  let pending: Uint8Array[] = []
  let serial: number | null = null
  let offset = 0
  while (offset + 27 <= bytes.length) {
    if (bytes[offset] !== 0x4f || bytes[offset + 1] !== 0x67 || bytes[offset + 2] !== 0x67 || bytes[offset + 3] !== 0x53) {
      if (packets.length === 0 && pending.length === 0) throw new VoiceNoteError('That isn’t an Ogg audio file.')
      break // trailing bytes after the last page
    }
    const pageSerial = view.getUint32(offset + 14, true)
    const segments = bytes[offset + 26]
    const headerEnd = offset + 27 + segments
    if (headerEnd > bytes.length) break
    let size = 0
    for (let i = 0; i < segments; i++) size += bytes[offset + 27 + i]
    if (headerEnd + size > bytes.length) break // a page cut off by a short download: keep what is whole
    // Only the first stream: a chained file's later streams are another recording.
    if (serial === null) serial = pageSerial
    if (pageSerial === serial) {
      let at = headerEnd
      for (let i = 0; i < segments; i++) {
        const lace = bytes[offset + 27 + i]
        pending.push(bytes.subarray(at, at + lace))
        at += lace
        // A lacing value under 255 ends the packet; 255 means it goes on.
        if (lace < 255) {
          packets.push(join(pending))
          pending = []
        }
      }
    }
    offset = headerEnd + size
  }
  if (packets.length < 2) throw new VoiceNoteError('That isn’t an Ogg Opus voice note.')
  const head = packets[0]
  if (head.length < 19 || String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead') throw new VoiceNoteError('That isn’t an Opus voice note.')
  const channels = head[9]
  if (channels < 1 || channels > 2 || head[18] !== 0) throw new VoiceNoteError('That voice note’s audio layout isn’t one Eaon can read.')
  const preSkip = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(10, true)
  if (String.fromCharCode(...packets[1].subarray(0, 8)) !== 'OpusTags') throw new VoiceNoteError('That voice note is damaged.')
  return { channels, preSkip, packets: packets.slice(2).filter((p) => p.length > 0) }
}

function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Samples as 16-bit PCM in a mono WAV at the speech rate. */
export function wavFromSamples(samples: Float32Array, rate = SPEECH_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return bytes
}

/** Seconds of audio in a WAV made by `wavFromSamples`. */
export const wavSeconds = (wav: Uint8Array): number => Math.max(0, wav.length - 44) / 2 / SPEECH_RATE

/** A decoded voice note, as mono samples at the speech rate. */
export async function decodeOggOpus(bytes: Uint8Array): Promise<Float32Array> {
  const stream = parseOggOpus(bytes)
  // Loaded when the first voice note arrives, so launch doesn't carry the decoder.
  const { OpusDecoder } = await import('opus-decoder')
  const decoder = new OpusDecoder({ sampleRate: SPEECH_RATE, channels: stream.channels })
  try {
    await decoder.ready
    const chunks: Float32Array[] = []
    let length = 0
    for (const packet of stream.packets) {
      const decoded = decoder.decodeFrame(packet)
      if (decoded.samplesDecoded === 0) continue
      // Stereo is averaged into one channel, which is what the speech model reads.
      const mono = decoded.channelData.length === 1 ? decoded.channelData[0] : average(decoded.channelData)
      chunks.push(mono)
      length += mono.length
    }
    const all = new Float32Array(length)
    let at = 0
    for (const chunk of chunks) {
      all.set(chunk, at)
      at += chunk.length
    }
    // The header counts its pre-skip at 48 kHz.
    return all.subarray(Math.min(all.length, Math.round((stream.preSkip * SPEECH_RATE) / 48_000)))
  } finally {
    decoder.free()
  }
}

function average(channels: Float32Array[]): Float32Array {
  const out = new Float32Array(channels[0].length)
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    for (const channel of channels) sum += channel[i]
    out[i] = sum / channels.length
  }
  return out
}

/** A voice note (Ogg Opus) as the WAV the local speech server takes. Throws `VoiceNoteError` for a file that isn't one. */
export async function oggOpusToWav(bytes: Uint8Array): Promise<Uint8Array> {
  return wavFromSamples(await decodeOggOpus(bytes))
}
