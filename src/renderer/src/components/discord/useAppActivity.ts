import { useEffect, useRef, useState } from 'react'
import { useApp } from '../../state/store'

/** What the app is doing, as far as the main window can tell. */
export type AppActivity = 'idle' | 'thinking' | 'working' | 'happy' | 'concerned' | 'asleep'

/** How long without any input or reply before the app counts as asleep. */
const SLEEP_AFTER_MS = 2 * 60_000
const HAPPY_MS = 2600
const CONCERNED_MS = 7000

/**
 * What the streaming reply is doing right now: 'working' while any tool call
 * in it is still running, 'thinking' otherwise, null when nothing streams.
 *
 * Runs on every store update (every streamed token), so it looks in the active
 * chat first — where the reply almost always is — and only walks the rest if
 * it has to. Returns a string, so the selector result is stable.
 */
function streamPhase(state: ReturnType<typeof useApp.getState>): 'thinking' | 'working' | null {
  const id = state.streamingMessageId
  if (!id) return null
  if (state.pendingApproval) return 'working'
  const active = state.chats.find((c) => c.id === state.activeChatId)
  let message = active?.messages[active.messages.length - 1]
  if (message?.id !== id) {
    message = undefined
    for (const chat of state.chats) {
      message = chat.messages.find((m) => m.id === id)
      if (message) break
    }
  }
  const running = message?.parts.some((p) => p.type === 'tool' && p.status === 'running')
  return running ? 'working' : 'thinking'
}

/**
 * The main window's reading of the app: thinking while a reply streams,
 * working while tools run, briefly happy when a turn lands, concerned for a
 * while after an error, and asleep after two quiet minutes. Discord Rich
 * Presence reports this; only the main window can see it.
 */
export function useAppActivity(): AppActivity {
  const phase = useApp(streamPhase)
  const [after, setAfter] = useState<{ kind: 'happy' | 'concerned'; until: number } | null>(null)
  const [asleep, setAsleep] = useState(false)
  const lastInput = useRef(Date.now())

  // A turn ending is the moment streamingMessageId goes back to null; the
  // message it pointed at says whether that ending was good news.
  useEffect(
    () =>
      useApp.subscribe((state, prev) => {
        const ended = prev.streamingMessageId
        if (!ended || state.streamingMessageId) return
        let failed = false
        for (const chat of state.chats) {
          const message = chat.messages.find((m) => m.id === ended)
          if (message) {
            failed = Boolean(message.error)
            break
          }
        }
        const kind = failed ? 'concerned' : 'happy'
        setAfter({ kind, until: Date.now() + (failed ? CONCERNED_MS : HAPPY_MS) })
        lastInput.current = Date.now()
      }),
    []
  )

  useEffect(() => {
    if (!after) return
    const timer = window.setTimeout(() => setAfter(null), Math.max(0, after.until - Date.now()))
    return () => window.clearTimeout(timer)
  }, [after])

  // Any input in the window counts as activity; the check itself runs on a
  // slow interval so a moving mouse costs one timestamp write, not a render.
  useEffect(() => {
    const touch = (): void => {
      lastInput.current = Date.now()
    }
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }))
    const timer = window.setInterval(() => {
      setAsleep(Date.now() - lastInput.current > SLEEP_AFTER_MS)
    }, 5000)
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch))
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (phase) {
      lastInput.current = Date.now()
      setAsleep(false)
    }
  }, [phase])

  return phase ?? after?.kind ?? (asleep ? 'asleep' : 'idle')
}
