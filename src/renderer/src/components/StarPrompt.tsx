import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import type { StarResult } from '@shared/star'
import { Modal } from './ui'

/** How long into a session before it asks: after they have started something, not on launch. */
const ASK_AFTER_MS = 45_000

/**
 * "Star Eaon on GitHub". It asks rarely (main/starPrompt.ts decides when) and
 * does nothing until the button is pressed. Star on GitHub opens the
 * repository and, when the GitHub CLI is signed in on this computer, stars it
 * for them.
 */
export function StarPrompt(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<StarResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      void window.api.star
        .shouldAsk()
        .then((ask) => setOpen(ask))
        .catch(() => undefined)
    }, ASK_AFTER_MS)
    return () => clearTimeout(timer)
  }, [])

  const close = (): void => {
    // Closing without choosing is "later".
    if (!result) void window.api.star.answer('later')
    setOpen(false)
  }

  const star = (): void => {
    setBusy(true)
    void window.api.star
      .answer('star')
      .then((outcome) => setResult(outcome ?? { starred: false, reason: 'failed' }))
      .finally(() => setBusy(false))
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={result ? (result.starred ? 'Starred. Thank you!' : 'Thanks for stopping by') : 'Star Eaon on GitHub'}
      width={430}
      actions={
        result ? (
          <button className="btn btn--primary" onClick={close}>
            Done
          </button>
        ) : (
          <>
            <button className="btn btn--ghost" disabled={busy} onClick={() => void window.api.star.answer('never').then(() => setOpen(false))}>
              No thanks
            </button>
            <button className="btn" disabled={busy} onClick={close}>
              Maybe later
            </button>
            <button className="btn btn--accent star-prompt__star" disabled={busy} onClick={star}>
              <Star size={14} strokeWidth={2} fill="currentColor" />
              {busy ? 'Opening…' : 'Star on GitHub'}
            </button>
          </>
        )
      }
    >
      {result ? (
        <p className="star-prompt__text">
          {result.starred
            ? 'The repository is open, with its star filled in.'
            : result.reason === 'not-signed-in'
              ? 'The repository is open. Press its ★ there. Sign in with “gh auth login” and next time Eaon can do it for you.'
              : 'The repository is open. Press its ★ there to star it.'}
        </p>
      ) : (
        <>
          <p className="star-prompt__text">Eaon is free and open source. A star helps other people find it, and it tells us the work is worth doing.</p>
          <p className="star-prompt__fine">
            Star on GitHub opens the repository and, if the GitHub CLI is signed in on this computer, stars it for you. Nothing happens until you press it.
          </p>
        </>
      )}
    </Modal>
  )
}
