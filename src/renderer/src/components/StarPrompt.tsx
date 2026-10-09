import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Star, X } from 'lucide-react'
import { askAfterMs, type StarResult } from '@shared/star'

/** How often time in front of the app is counted. */
const TICK_MS = 15_000
/** How long the thank-you stays before the card goes. */
const THANKS_MS = 5_000

/**
 * "Enjoying Eaon?" — a small card in the corner after 10 to 20 minutes of
 * using the app in a session (only time with the window in front counts).
 * Main decides whether it may ask at all (main/starPrompt.ts): never once the
 * person's GitHub account has starred the repository or they went to it from
 * here, and rarely otherwise. Open GitHub stars it through the GitHub CLI
 * when that is signed in, and opens the repository either way.
 */
export function StarPrompt(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<StarResult | null>(null)
  const closing = useRef<number | null>(null)

  useEffect(() => {
    const target = askAfterMs(Math.random())
    let used = 0
    let last = Date.now()
    const timer = window.setInterval(() => {
      const now = Date.now()
      const step = now - last
      last = now
      // A long gap is the computer asleep, not use.
      if (document.visibilityState === 'visible' && document.hasFocus() && step < 3 * TICK_MS) used += step
      if (used < target) return
      window.clearInterval(timer)
      void window.api.star
        .shouldAsk()
        .then((ask) => setOpen(ask))
        .catch(() => undefined)
    }, TICK_MS)
    return () => {
      window.clearInterval(timer)
      if (closing.current) window.clearTimeout(closing.current)
    }
  }, [])

  if (!open) return null

  const later = (): void => {
    if (!result) void window.api.star.answer('later')
    setOpen(false)
  }

  const openGitHub = (): void => {
    setBusy(true)
    void window.api.star
      .answer('star')
      .then((outcome) => setResult(outcome ?? { starred: false, reason: 'failed' }))
      .catch(() => setResult({ starred: false, reason: 'failed' }))
      .finally(() => {
        setBusy(false)
        closing.current = window.setTimeout(() => setOpen(false), THANKS_MS)
      })
  }

  return (
    <div className="star-card" role="dialog" aria-labelledby="star-card-title">
      <div className="star-card__head">
        <Star className="star-card__icon" size={16} strokeWidth={2} fill="currentColor" aria-hidden />
        <span id="star-card-title" className="star-card__title">
          {result ? (result.starred ? 'Starred. Thank you!' : 'Thanks for stopping by') : 'Enjoying Eaon?'}
        </span>
        <button type="button" className="star-card__close" aria-label="Close" onClick={later}>
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <p className="star-card__text">
        {result
          ? result.starred
            ? 'Your star is on the repository. It helps other developers find Eaon.'
            : 'The repository is open in your browser. Press ★ there to star it.'
          : 'Eaon is open source. If it helped today, a GitHub star helps other developers find it.'}
      </p>
      {!result && (
        <div className="star-card__actions">
          <button type="button" className="star-card__btn star-card__btn--github" disabled={busy} onClick={openGitHub}>
            <ExternalLink size={14} strokeWidth={2} />
            {busy ? 'Opening…' : 'Open GitHub'}
          </button>
          <button type="button" className="star-card__btn" disabled={busy} onClick={later}>
            Later
          </button>
        </div>
      )}
    </div>
  )
}
