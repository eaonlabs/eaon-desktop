import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, X } from 'lucide-react'
import type { Dictation } from './useDictation'
import { followLevel, formatElapsed, levelFromSamples } from './voiceLevel'
import './voice.css'

/** Bar geometry, in CSS pixels. */
const BAR = 2.5
const GAP = 2
const PITCH = BAR + GAP
/** A new bar enters every this many ms; the strip scrolls smoothly in between. */
const STEP_MS = 55
/** The quietest bar: a dot on the centre line, so silence reads as "listening". */
const MIN_H = 2.5

/** A CSS colour from a theme token, resolved to something canvas can paint. */
function tokenColor(element: HTMLElement, token: string): string {
  const probe = document.createElement('span')
  probe.style.color = `var(${token})`
  probe.style.display = 'none'
  element.appendChild(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}

/**
 * The dictation waveform. Thin rounded bars, mirrored around a centre line,
 * scroll right to left as you speak: the newest bar at the right edge in the
 * accent, older ones fading towards the left. While transcribing, the strip
 * holds still and a soft highlight sweeps across it. With reduced motion it
 * doesn't scroll or sweep, and updates a few times a second.
 */
function VoiceWave({ analyser, transcribing }: { analyser: AnalyserNode | null; transcribing: boolean }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const history = useRef<number[]>([])
  const level = useRef(0)

  useEffect(() => {
    const node = canvas.current
    if (!node) return
    const paint = node.getContext('2d')
    if (!paint) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.dataset.reduceMotion === 'on'
    const accent = tokenColor(node, '--accent')
    const quiet = tokenColor(node, '--text-3')
    const samples = analyser ? new Float32Array(analyser.fftSize) : null
    let raf = 0
    let lastStep = performance.now()
    let lastPaint = 0

    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)
      if (reduce && now - lastPaint < 240) return
      lastPaint = now
      const ratio = window.devicePixelRatio || 1
      const width = node.clientWidth
      const height = node.clientHeight
      if (node.width !== Math.round(width * ratio) || node.height !== Math.round(height * ratio)) {
        node.width = Math.round(width * ratio)
        node.height = Math.round(height * ratio)
      }
      const count = Math.ceil(width / PITCH) + 1

      // Listening: sample the mic and push a bar every step.
      if (analyser && samples && !transcribing) {
        analyser.getFloatTimeDomainData(samples)
        level.current = followLevel(level.current, levelFromSamples(samples))
        while (now - lastStep >= STEP_MS) {
          history.current.push(level.current)
          lastStep += STEP_MS
        }
        if (history.current.length > count + 2) history.current.splice(0, history.current.length - count - 2)
      }
      // Between steps the strip slides by the fraction of a bar already elapsed.
      const slide = reduce || transcribing || !analyser ? 0 : ((now - lastStep) / STEP_MS) * PITCH

      paint.setTransform(ratio, 0, 0, ratio, 0, 0)
      paint.clearRect(0, 0, width, height)
      const mid = height / 2
      const bars = history.current
      // The sweep while transcribing: a soft band crossing the strip every 1.4s.
      const sweepAt = transcribing && !reduce ? ((now % 1400) / 1400) * (width + 120) - 60 : null
      for (let i = 0; i < count; i++) {
        const fromRight = count - 1 - i
        const value = bars[bars.length - 1 - fromRight] ?? 0
        const x = width - (fromRight + 1) * PITCH - slide + GAP
        if (x + BAR < 0) continue
        const h = Math.max(MIN_H, value * (height - 2))
        const age = i / Math.max(1, count - 1)
        let alpha = transcribing ? 0.28 + 0.3 * age : 0.22 + 0.78 * age
        if (sweepAt !== null) alpha += Math.max(0, 1 - Math.abs(x - sweepAt) / 60) * 0.55
        paint.globalAlpha = Math.min(1, alpha)
        paint.fillStyle = value > 0.04 || transcribing ? accent : quiet
        paint.beginPath()
        paint.roundRect(x, mid - h / 2, BAR, h, BAR / 2)
        paint.fill()
      }
      paint.globalAlpha = 1
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [analyser, transcribing])

  return <canvas ref={canvas} className="voice-wave" aria-hidden="true" />
}

/**
 * What the composer shows instead of the text box while dictating: the
 * waveform, the time, and buttons to throw the recording away or finish it.
 */
export function VoiceBar({ dictation }: { dictation: Dictation }): JSX.Element {
  const { state, analyser, startedAt, finish, cancel } = dictation
  const transcribing = state === 'transcribing'
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (state !== 'recording') return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [state])

  // Esc throws the recording away; Enter finishes it.
  useEffect(() => {
    if (state !== 'recording') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        finish()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, cancel, finish])

  return (
    <div className="voice-bar" data-state={state} role="group" aria-label="Dictation">
      <button className="voice-bar__btn" onClick={cancel} disabled={transcribing} aria-label="Discard recording" title="Discard (Esc)">
        <X size={15} strokeWidth={2} />
      </button>
      <VoiceWave analyser={analyser} transcribing={transcribing} />
      <span className="voice-bar__time" aria-live="polite">
        {transcribing ? (
          'Transcribing…'
        ) : state === 'starting' ? (
          'Starting…'
        ) : (
          <>
            <span className="voice-bar__dot" aria-hidden="true" />
            {formatElapsed(now - startedAt)}
          </>
        )}
      </span>
      <button
        className="voice-bar__btn voice-bar__btn--done"
        onClick={finish}
        disabled={state !== 'recording'}
        aria-label="Finish and transcribe"
        title="Finish (Enter)"
      >
        <Check size={15} strokeWidth={2.4} />
      </button>
    </div>
  )
}
