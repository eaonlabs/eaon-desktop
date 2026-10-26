import { useEffect, useRef } from 'react'
import { DEFAULT_HOLD_KEY, HOLD_DELAY_MS, isModifierCode } from '@shared/holdKey'
import { useApp } from '../../state/store'
import type { Dictation } from './useDictation'

/**
 * Hold to talk: hold the key from Settings (Right Option on a Mac, Right Alt
 * elsewhere) and speak; let go and what was said goes where this place puts
 * it (Chat's or a worker's message box, the ADE's terminal). A quick tap or
 * the key pressed with another one (a shortcut) never records, Esc while
 * holding throws the recording away, and switching away mid-hold finishes it.
 *
 * Several places can be mounted at once: the key goes to the one mounted
 * last of those whose `ready` says they can take the words now.
 */

/** The places listening, last mounted last. */
const claims: { ready: () => boolean }[] = []

export interface HoldToTalk {
  /** Whether hold-to-talk is on, and the key, as Settings has them. */
  enabled: boolean
  key: string
}

/** The app-wide hold-to-talk setting. Stored with the ADE's, where it began (Settings → General or ADE). */
export function useHoldSetting(): HoldToTalk {
  const config = useApp((s) => s.settings?.ade?.dictation)
  return { enabled: config?.enabled ?? true, key: config?.key || DEFAULT_HOLD_KEY }
}

export function useHoldToTalk(
  dictation: Pick<Dictation, 'state' | 'start' | 'finish' | 'cancel'>,
  {
    ready,
    onStart
  }: {
    /** Whether the words can go here now: this place is on screen, and nobody is typing in another field. */
    ready: () => boolean
    /** Called as the microphone opens: where the words should go is decided now. */
    onStart?: () => void
  }
): HoldToTalk {
  const setting = useHoldSetting()
  const { enabled, key } = setting
  const hold = useRef({ down: false, combo: false, started: false, endOnRecord: false, timer: 0 })
  const live = useRef({ dictation, ready, onStart })
  live.current = { dictation, ready, onStart }

  useEffect(() => {
    if (!enabled) return
    const claim = { ready: () => live.current.ready() }
    claims.push(claim)
    const mine = (): boolean => {
      for (let i = claims.length - 1; i >= 0; i--) if (claims[i].ready()) return claims[i] === claim
      return false
    }
    const modifier = isModifierCode(key)
    const release = (): void => {
      const h = hold.current
      window.clearTimeout(h.timer)
      const wasStarted = h.started
      h.down = false
      h.started = false
      if (!wasStarted) return
      // Let go while the microphone was still opening: it finishes as soon as it is open.
      if (live.current.dictation.state === 'recording') live.current.dictation.finish()
      else h.endOnRecord = true
    }
    const onDown = (e: KeyboardEvent): void => {
      const h = hold.current
      // Mid-hold, the place that started it hears the rest; a new hold goes to whoever can take it.
      if (!h.down && !mine()) return
      if (e.code === key) {
        // A key of its own (F13, Pause…) is kept from what has focus; a
        // modifier passes through, since it types nothing until another joins it.
        if (!modifier) {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
        if (e.repeat || h.down || live.current.dictation.state !== 'idle') return
        h.down = true
        h.combo = false
        h.timer = window.setTimeout(() => {
          if (!h.down || h.combo) return
          h.started = true
          h.endOnRecord = false
          live.current.onStart?.()
          void live.current.dictation.start()
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
        h.endOnRecord = false
        live.current.dictation.cancel()
        return
      }
      // Another key with it: a shortcut, not dictation.
      h.combo = true
      window.clearTimeout(h.timer)
      if (h.started) {
        h.started = false
        h.endOnRecord = false
        live.current.dictation.cancel()
      }
    }
    const onUp = (e: KeyboardEvent): void => {
      if (e.code !== key || !hold.current.down) return
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
      claims.splice(claims.indexOf(claim), 1)
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', onBlur)
      const h = hold.current
      window.clearTimeout(h.timer)
      h.down = false
      h.started = false
      h.endOnRecord = false
    }
  }, [enabled, key])

  // Let go before the microphone opened: finish once it has, rather than leave it recording.
  const { state, finish } = dictation
  useEffect(() => {
    const h = hold.current
    if (state === 'recording' && h.endOnRecord) {
      h.endOnRecord = false
      finish()
    } else if (state === 'idle') h.endOnRecord = false
  }, [state, finish])

  return setting
}

/** Whether focus is in a text field other than `own`: typing there isn't dictation. */
export function typingElsewhere(own: Element | null): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === own || el.classList.contains('xterm-helper-textarea')) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}
