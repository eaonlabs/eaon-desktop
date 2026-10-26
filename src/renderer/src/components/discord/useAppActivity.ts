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
 * Runs on every store update (every streamed token), so it only looks at the
 * chats with a reply running (the last message is the reply). Working when
 * any of them is running a tool or asking. Returns a string, so the selector
 * result is stable.
 */
function streamPhase(state: ReturnType<typeof useApp.getState>): 'thinking' | 'working' | null {
  const running = Object.keys(state.runs)
  if (running.length === 0) return null
  if (state.pendingApproval) return 'working'
  for (const chatId of running) {
    const chat = state.chats.find((c) => c.id === chatId)
    const message = chat?.messages[chat.messages.length - 1]
    if (message?.parts.some((p) => p.type === 'tool' && p.status === 'running')) return 'working'
  }
  return 'thinking'
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

  // A turn ending is the moment its chat leaves `runs`; the message it ran
  // says whether that ending was good news.
  useEffect(
    () =>
      useApp.subscribe((state, prev) => {
        if (state.runs === prev.runs) return
        const ended = Object.keys(prev.runs).filter((chatId) => !(chatId in state.runs)).map((chatId) => prev.runs[chatId])[0]
        if (!ended) return
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
