import { useEffect, useRef, useState } from 'react'
import { Gift, X } from 'lucide-react'
import { FREE_DAYS, FREE_LIMITS, formatAllowance, formatEndDay, OFFER_AFTER_MS } from '@shared/freeCredits'
import { useApp } from '../state/store'
import { StarCard } from './StarPrompt'
import { onboardingShowing } from './onboarding/onboardingStore'

/** How often time in front of the app is counted. */
const TICK_MS = 15_000
/** The pause between the star popup closing and the offer coming up. */
const NEXT_CARD_MS = 1_200

/** One line for the allowance, as the card and Settings say it. */
export const FREE_ALLOWANCE = `${FREE_LIMITS.requestsPerDay} requests and ${formatAllowance(FREE_LIMITS.tokensPerDay)} tokens a day`

/**
 * "Free AI credits": a card in the corner after the app has been on screen
 * for half a minute, offering a free week of Eaon Free (shared/freeCredits.ts). Main
 * decides whether it may show (at most three times, days apart, never once
 * claimed), and whether the star popup comes up first, as it does on a fresh
 * install (and alone, when the credits were claimed from Settings first).
 *
 * The offer follows the star popup whatever its answer: GitHub forbids
 * rewarding stars with credits, so neither card mentions the other.
 */
export function FreeCreditsOffer(): JSX.Element | null {
  const refreshProviders = useApp((s) => s.refreshProviders)
  const [card, setCard] = useState<'none' | 'star' | 'offer' | 'claimed'>('none')
  const [busy, setBusy] = useState(false)
  const [endsAt, setEndsAt] = useState<number | null>(null)
  const next = useRef<number | null>(null)
  /** Whether the offer follows the star popup; not when the credits were claimed already. */
  const offerNext = useRef(false)

  useEffect(() => {
    let used = 0
    let last = Date.now()
    const timer = window.setInterval(() => {
      const now = Date.now()
      const step = now - last
      last = now
      // Time with the window on screen counts, focused or not (a minimised or
      // covered window is hidden); a long gap is the computer asleep, not use.
      // Time in the first-run setup or the tour doesn't.
      if (document.visibilityState === 'visible' && step < 3 * TICK_MS && !onboardingShowing()) used += step
      if (used < OFFER_AFTER_MS) return
      window.clearInterval(timer)
      void window.api.freeCredits
        .shouldOffer()
        .then((plan) => {
          offerNext.current = plan.offer
          setCard(plan.starFirst ? 'star' : plan.offer ? 'offer' : 'none')
        })
        .catch(() => undefined)
    }, TICK_MS)
    return () => {
      window.clearInterval(timer)
      if (next.current) window.clearTimeout(next.current)
    }
  }, [])

  if (card === 'none') return null
  if (card === 'star') {
    const closed = (): void => {
      if (!offerNext.current) return setCard('none')
      next.current = window.setTimeout(() => setCard('offer'), NEXT_CARD_MS)
    }
    return <StarCard intro onClosed={closed} />
  }

  const close = (): void => setCard('none')

  const claim = (): void => {
    setBusy(true)
    void window.api.freeCredits
      .claim()
      .then(async (status) => {
        setEndsAt(status.endsAt)
        await refreshProviders()
        setCard('claimed')
      })
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }

  const title = card === 'offer' ? 'Free AI credits' : 'Your free week has started'
  const text =
    card === 'offer'
      ? `Try Claude Haiku 5.5 in Eaon free for ${FREE_DAYS} days, with no API key or account: ${FREE_ALLOWANCE}.`
      : `Eaon Free is in your model picker${endsAt ? ` until ${formatEndDay(endsAt)}` : ''}. Settings → Model providers shows what’s left today.`

  return (
    <div className="star-card free-card" role="dialog" aria-labelledby="free-card-title">
      <div className="star-card__head">
        <Gift className="free-card__icon" size={16} strokeWidth={2} aria-hidden />
        <span id="free-card-title" className="star-card__title">
          {title}
        </span>
        <button type="button" className="star-card__close" aria-label="Close" onClick={close}>
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <p className="star-card__text">{text}</p>
      <div className="star-card__actions">
        {card === 'offer' ? (
          <>
            <button type="button" className="star-card__btn free-card__btn--claim" disabled={busy} onClick={claim}>
              <Gift size={14} strokeWidth={2} />
              {busy ? 'Setting up…' : 'Get free credits'}
            </button>
            <button type="button" className="star-card__btn" disabled={busy} onClick={close}>
              Not now
            </button>
          </>
        ) : (
          <button type="button" className="star-card__btn" onClick={close}>
            Done
          </button>
        )}
      </div>
    </div>
  )
}
