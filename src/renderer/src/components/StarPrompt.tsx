import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Star, X } from 'lucide-react'
import { askAfterMs, type StarResult } from '@shared/star'
import { onboardingShowing, useOnboardingShowing } from './onboarding/onboardingStore'

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
  const aside = useOnboardingShowing()

  useEffect(() => {
    const target = askAfterMs(Math.random())
    let used = 0
    let last = Date.now()
    let wasShowing = true
    const timer = window.setInterval(() => {
      const now = Date.now()
      const step = now - last
      last = now
      // A long gap is the computer asleep, not use. A stretch the setup or a tour
      // was up for, at either end, isn't counted: time in them isn't time in the app.
      const showing = onboardingShowing()
      if (document.visibilityState === 'visible' && document.hasFocus() && step < 3 * TICK_MS && !showing && !wasShowing) used += step
      wasShowing = showing
      if (used < target) return
      window.clearInterval(timer)
      void window.api.star
        .shouldAsk()
        .then((ask) => setOpen(ask))
        .catch(() => undefined)
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  return open && !aside ? <StarCard onClosed={() => setOpen(false)} /> : null
}

/** The corner cards' width and inset (settings.css .star-card). */
const CARD_W = 360
const CARD_INSET = 20

/**
 * Lifts the corner cards (this one, the Eaon Free offer) above the message
 * box while they would sit on it: in an ordinary window the box's model
 * chip, mic and send button were under the card. What stacks above the box
 * counts too (an unavailable model's notice and its buttons, queued
 * messages, the pinned goal and plan). Elsewhere they stay in the corner.
 * The card reads `--corner-card-bottom`.
 */
export function useCornerClear(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const root = document.documentElement
    const place = (): void => {
      let bottom = CARD_INSET
      const cardLeft = window.innerWidth - CARD_INSET - Math.min(CARD_W, window.innerWidth - 2 * CARD_INSET)
      const parts = [...document.querySelectorAll<HTMLElement>('.composer-stack, .composer-dock__pinned')].filter(
        (el) => el.getClientRects().length > 0 && !el.closest('.onboarding')
      )
      for (const part of parts) {
        const rect = part.getBoundingClientRect()
        if (rect.height === 0 || rect.right <= cardLeft || rect.bottom < window.innerHeight - 320) continue
        bottom = Math.max(bottom, window.innerHeight - rect.top + 12)
      }
      root.style.setProperty('--corner-card-bottom', `${Math.round(bottom)}px`)
    }
    place()
    // The box grows as text is typed, and comes and goes with the page.
    const timer = window.setInterval(place, 800)
    window.addEventListener('resize', place)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', place)
      root.style.removeProperty('--corner-card-bottom')
    }
  }, [active])
}

/**
 * The card itself, once main has said it may ask. The Eaon Free offer shows
 * it too, just before its own card (FreeCreditsOffer.tsx), with `intro` for a
 * first launch: "If it helped today" says nothing to someone who just started.
 */
export function StarCard({ intro = false, onClosed }: { intro?: boolean; onClosed: () => void }): JSX.Element {
  useCornerClear(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<StarResult | null>(null)
  const closing = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (closing.current) window.clearTimeout(closing.current)
    },
    []
  )

  const later = (): void => {
    if (closing.current) window.clearTimeout(closing.current)
    if (!result) void window.api.star.answer('later')
    onClosed()
  }

  const openGitHub = (): void => {
    setBusy(true)
    void window.api.star
      .answer('star')
      .then((outcome) => setResult(outcome ?? { starred: false, reason: 'failed' }))
      .catch(() => setResult({ starred: false, reason: 'failed' }))
      .finally(() => {
        setBusy(false)
        closing.current = window.setTimeout(onClosed, THANKS_MS)
      })
  }

  return (
    <div className="star-card" role="dialog" aria-labelledby="star-card-title">
      <div className="star-card__head">
        <Star className="star-card__icon" size={16} strokeWidth={2} fill="currentColor" aria-hidden />
        <span id="star-card-title" className="star-card__title">
          {result ? (result.starred ? 'Starred. Thank you!' : 'Thanks for stopping by') : intro ? 'Welcome to Eaon' : 'Enjoying Eaon?'}
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
          : intro
            ? 'Eaon is free and open source. If you can, star it on GitHub; it helps other developers find it.'
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
