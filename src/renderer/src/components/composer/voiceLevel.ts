/**
 * Loudness for the dictation waveform: how tall a bar should be, 0..1, from a
 * frame of microphone samples. Kept apart from the canvas so it can be tested.
 */

/** Below this is room noise; above the top, everything reads as full. */
const FLOOR_DB = -58
const RANGE_DB = 46

/** RMS of a frame of float samples (-1..1), in decibels, mapped to 0..1. */
export function levelFromSamples(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / samples.length)
  if (rms <= 0) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / RANGE_DB))
}

/**
 * Smoothing between frames: a bar jumps up with the voice and falls back more
 * slowly, which reads as speech rather than flicker.
 */
export function followLevel(previous: number, next: number): number {
  const rate = next > previous ? 0.55 : 0.18
  return previous + (next - previous) * rate
}

/** "0:07", "1:42", "10:00". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
