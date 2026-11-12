import { useEffect, type JSX } from 'react'
import { CornerDownLeft, X } from 'lucide-react'
import { answerAsQuote } from '@shared/sideQuestion'
import { useApp } from '../../state/store'
import { useSideQuestion } from '../../state/sideQuestion'
import { Markdown } from '../agent/Markdown'
import { notify } from '../Notice'
import './side-question.css'

/**
 * The card over Chat's message box that answers a "/btw" question. It says
 * what it is (not part of the chat, nothing saved), shows the answer as it is
 * written, and offers to put the answer into the message box as a quote when
 * it is worth keeping. Esc or the close button puts it away.
 */
export function SideQuestion(): JSX.Element | null {
  const card = useSideQuestion((s) => s.card)
  const close = useSideQuestion((s) => s.close)
  const open = card !== null

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      // Not while a menu or dialog has the key, nor when something else already took it.
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('.menu, [role="dialog"]')) return
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!card) return null
  const addToChat = (): void => {
    useApp.getState().appendToComposer({ text: answerAsQuote(card.question, card.answer), attachments: [] })
    close()
  }
  return (
    <section className="side-card" role="region" aria-label="Side question" aria-busy={card.status === 'asking'}>
      <header className="side-card__head">
        <span className="side-card__kind">Side question</span>
        <span className="side-card__note">Not part of this chat and not saved</span>
        <button type="button" className="side-card__close" onClick={close} aria-label="Close the side question" title="Close (Esc)">
          <X size={14} strokeWidth={2} />
        </button>
      </header>
      <p className="side-card__question">{card.question}</p>
      <div className="side-card__answer" aria-live="polite">
        {card.status === 'error' ? (
          <p className="side-card__error" role="alert">
            {card.error}
          </p>
        ) : card.answer ? (
          <Markdown text={card.answer} />
        ) : (
          <p className="side-card__wait">Thinking…</p>
        )}
      </div>
      {card.status === 'done' && (
        <footer className="side-card__foot">
          <button type="button" className="btn btn--sm" onClick={addToChat} title="Put the question and answer in your message box as a quote">
            <CornerDownLeft size={13} strokeWidth={1.9} />
            Add to message
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void navigator.clipboard.writeText(card.answer).then(() => notify('Copied the answer'), () => notify('Couldn’t copy the answer', 'error'))}
          >
            Copy
          </button>
        </footer>
      )}
    </section>
  )
}
