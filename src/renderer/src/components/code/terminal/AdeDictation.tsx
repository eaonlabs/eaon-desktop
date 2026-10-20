import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import { Mic, X } from 'lucide-react'
import { useApp } from '../../../state/store'
import { useDictation } from '../../composer/useDictation'
import { VoiceWave } from '../../composer/VoiceBar'
import { formatElapsed } from '../../composer/voiceLevel'
import { isMac } from '../../../lib/platform'
import { DEFAULT_HOLD_KEY, HOLD_DELAY_MS, holdKeyLabel, isModifierCode } from '@shared/holdKey'
import type { SpeechPick } from '@shared/speech'
import { terminals } from './registry'
import './adeDictation.css'

/** Each word of the transcript lands this long after the one before it. */
const WORD_STAGGER_MS = 45
/** However long the transcript, the words have all landed by then. */
const REVEAL_CAP_MS = 700
/** How long the transcript stays up once it has gone into the terminal. */
const LINGER_MS = 1600

/** Where a key event came from: typing in a text field outside the terminals isn't dictation. */
function typingElsewhere(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el.classList.contains('xterm-helper-textarea')) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

const reduceMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.dataset.reduceMotion === 'on'

/**
 * Hold-to-talk for the ADE's terminals. Holding the key from Settings → ADE
 * (Right Option on a Mac, Right Alt elsewhere) opens the microphone; letting
 * go transcribes what was said, with the model picked there (online, or one
 * that runs on this computer), and pastes it into the terminal last typed
 * in. Nothing is sent: the text waits at the prompt for Enter. Escape while
 * holding throws the recording away, and pressing any other key with it
 * makes a shortcut instead.
 *
 * While it listens, a pill at the foot of the workspace shows the live
 * waveform; then the words arrive one by one before they go in.
 */
export function AdeDictation(): JSX.Element | null {
  const config = useApp((s) => s.settings?.ade?.dictation)
  const enabled = config?.enabled ?? true
  const key = config?.key || DEFAULT_HOLD_KEY
  const pick = useRef<SpeechPick | null>(null)
  pick.current = config?.speechProviderId ? { providerId: config.speechProviderId, modelId: config.speechModelId ?? null } : null

  const [spoken, setSpoken] = useState<{ id: number; words: string[] } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const target = useRef<string | null>(null)
  const timers = useRef<number[]>([])
  const later = (fn: () => void, ms: number): void => {
    timers.current.push(window.setTimeout(fn, ms))
  }

  const onText = useCallback((text: string): void => {
    const words = text.trim().split(/\s+/).filter(Boolean)
    const id = Date.now()
    setSpoken({ id, words })
    // In once the words have landed, so what you watched arrive is what goes in.
    const reveal = reduceMotion() ? 0 : Math.min(REVEAL_CAP_MS, words.length * WORD_STAGGER_MS)
    later(() => {
      const pane = target.current && terminals.paste(target.current, text) ? target.current : null
      if (!pane) {
        const fallback = terminals.lastFocused()
        if (!fallback || !terminals.paste(fallback, text)) setNotice('Click into a terminal, then hold the key again.')
      }
      later(() => setSpoken((current) => (current?.id === id ? null : current)), LINGER_MS)
    }, reveal + 120)
  }, [])

  const dictation = useDictation(onText, {
    pick: () => pick.current,
    missing: (local) =>
      local ? 'Download the speech model first, in Settings → ADE → Speech to text.' : 'Pick a speech-to-text model in Settings → ADE → Speech to text, or add an OpenAI or Groq key.'
  })
  const { state, error, startedAt, analyser, start, finish, cancel, dismissError } = dictation

  // The key's life: down, held long enough on its own, up. Kept in a ref so
  // the listeners, added once, always see the latest.
  const hold = useRef({ down: false, combo: false, started: false, timer: 0 })
  const live = useRef({ state, start, finish, cancel })
  live.current = { state, start, finish, cancel }

  useEffect(() => {
    if (!enabled) return
    const modifier = isModifierCode(key)
    const release = (): void => {
      const h = hold.current
      window.clearTimeout(h.timer)
      const wasStarted = h.started
      h.down = false
      h.started = false
      if (wasStarted) live.current.finish()
    }
    const onDown = (e: KeyboardEvent): void => {
      const h = hold.current
      if (e.code === key) {
        // A key of its own (F13, Pause…) never reaches the terminal; a modifier
        // passes through, since it types nothing until another key joins it.
        if (!modifier) {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
        if (e.repeat || h.down || typingElsewhere()) return
        h.down = true
        h.combo = false
        h.timer = window.setTimeout(() => {
          if (!h.down || h.combo) return
          h.started = true
          target.current = terminals.lastFocused()
          setNotice(null)
          void live.current.start()
        }, HOLD_DELAY_MS)
        return
      }
      if (!h.down) return
      if (e.key === 'Escape' && h.started) {
        e.preventDefault()
        e.stopImmediatePropagation()
        window.clearTimeout(h.timer)
        h.down = false
        h.started = false
        live.current.cancel()
        return
      }
      // Another key with it: a shortcut, not dictation.
      h.combo = true
      window.clearTimeout(h.timer)
      if (h.started) {
        h.started = false
        live.current.cancel()
      }
    }
    const onUp = (e: KeyboardEvent): void => {
      if (e.code !== key) return
      if (!modifier) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      release()
    }
    // Switching away mid-hold never delivers the key's release: finish then.
    const onBlur = (): void => {
      if (hold.current.down) release()
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', onBlur)
      const h = hold.current
      window.clearTimeout(h.timer)
      h.down = false
      h.started = false
    }
  }, [enabled, key])

  // Let go while the microphone was still opening: finish as soon as it is.
  useEffect(() => {
    if (state === 'recording' && !hold.current.started) finish()
  }, [state, finish])

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])

  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (state !== 'recording') return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [state])

  const message = error ?? notice
  const phase = state === 'recording' || state === 'starting' ? 'listening' : state === 'transcribing' ? 'transcribing' : spoken ? 'spoken' : message ? 'error' : null
  if (!enabled || !phase) return null
  const keyName = holdKeyLabel(key, isMac)

  return (
    <div className="ade-dictation" data-phase={phase} role="status" aria-live="polite">
      {phase === 'listening' && (
        <>
          <span className="ade-dictation__rec" aria-hidden="true">
            <Mic size={14} strokeWidth={2.2} />
          </span>
          <VoiceWave analyser={analyser} transcribing={false} />
          <span className="ade-dictation__time">{state === 'recording' ? formatElapsed(now - startedAt) : '0:00'}</span>
          <span className="ade-dictation__hint">Release {keyName} to insert · Esc cancels</span>
        </>
      )}
      {phase === 'transcribing' && (
        <>
          <VoiceWave analyser={null} transcribing />
          <span className="ade-dictation__working">Transcribing</span>
        </>
      )}
      {phase === 'spoken' && spoken && (
        <p className="ade-dictation__words" key={spoken.id} aria-label={spoken.words.join(' ')}>
          {spoken.words.map((word, i) => (
            <span key={i} className="ade-dictation__word" style={{ '--i': Math.min(i, REVEAL_CAP_MS / WORD_STAGGER_MS) } as CSSProperties}>
              {word}
            </span>
          ))}
        </p>
      )}
      {phase === 'error' && (
        <>
          <span className="ade-dictation__error">{message}</span>
          <button
            type="button"
            className="ade-dictation__close"
            aria-label="Dismiss"
            onClick={() => {
              dismissError()
              setNotice(null)
            }}
          >
            <X size={13} strokeWidth={2.2} />
          </button>
        </>
      )}
    </div>
  )
}
