import type { ModNote, ModSoundEvent } from '@shared/mods'
import { soundFor } from '../state/mods'

/**
 * Sounds from mods, played with Web Audio from the notes a mod lists
 * (shared/mods.ts `ModNote`), so no mod ships an audio file. Nothing plays
 * unless an enabled mod has notes for the event.
 */

let context: AudioContext | null = null

/** Plays `notes` one after another, each with a short fade in and out so it doesn't click. */
export function playNotes(notes: ModNote[]): void {
  if (typeof AudioContext === 'undefined' || notes.length === 0) return
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    let at = context.currentTime + 0.02
    for (const note of notes) {
      const length = note.ms / 1000
      const osc = context.createOscillator()
      const gain = context.createGain()
      osc.type = note.wave ?? 'sine'
      osc.frequency.value = note.freq
      const peak = Math.min(1, Math.max(0, note.gain ?? 0.18)) * 0.5
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(peak, at + Math.min(0.015, length / 4))
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length)
      osc.connect(gain).connect(context.destination)
      osc.start(at)
      osc.stop(at + length + 0.02)
      at += length
    }
  } catch (error) {
    console.warn('[mods] could not play a sound:', error)
  }
}

export function playModSound(event: ModSoundEvent): void {
  const notes = soundFor(event)
  if (notes) playNotes(notes)
}
