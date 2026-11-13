import { useEffect, useLayoutEffect, useState } from 'react'
import { useApp } from '../state/store'

/** Not before this, so a quick start doesn't flash the mark at the user. */
const MIN_MS = 500
/** Ready or not, it goes by then: it covers the start, it never makes anyone wait. */
const MAX_MS = 3000
/** How long it takes to fade (splash.css). */
const LEAVE_MS = 420

/**
 * The window's opening: Eaon's mark over the whole app, which starts up
 * blurred underneath. It goes once the saved data is in and the first screen
 * has painted, or after three seconds from the page loading, whichever comes
 * first. Clicks and keys go straight through to the app.
 */
export function Splash(): JSX.Element | null {
  // Failing to load ends it too: the error page under it has a button to press.
  const started = useApp((s) => s.ready || Boolean(s.initError))
  const [phase, setPhase] = useState<'shown' | 'leaving' | 'gone'>('shown')

  // Timed from the page loading (performance.now), not from this mounting.
  useEffect(() => {
    const timer = setTimeout(() => setPhase((p) => (p === 'shown' ? 'leaving' : p)), Math.max(0, MAX_MS - performance.now()))
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!started) return
    let cancelled = false
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    // The type has loaded and the app has painted at least once beneath it.
    void document.fonts.ready.then(() => {
      if (cancelled) return
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          timer = setTimeout(() => setPhase((p) => (p === 'shown' ? 'leaving' : p)), Math.max(0, MIN_MS - performance.now()))
        })
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [started])

  // What blurs the app under it (splash.css), set before the first paint.
  useLayoutEffect(() => {
    const root = document.documentElement
    if (phase === 'gone') delete root.dataset.splash
    else root.dataset.splash = phase
    return () => void delete root.dataset.splash
  }, [phase])

  useEffect(() => {
    if (phase !== 'leaving') return
    const timer = setTimeout(() => setPhase('gone'), LEAVE_MS)
    return () => clearTimeout(timer)
  }, [phase])

  if (phase === 'gone') return null
  return (
    <div className="splash" data-leaving={phase === 'leaving' || undefined} aria-hidden="true">
      <svg className="splash__mark" viewBox="0 0 200 200">
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M186.6 50A100 100 0 1 0 186.6 150H103A15 15 0 0 1 103 120H197.98A100 100 0 0 0 197.98 80H103A15 15 0 0 1 103 50Z"
        />
      </svg>
    </div>
  )
}
