import type { JSX } from 'react'
import { CornerDownRight, Paperclip, PencilLine, Play, X } from 'lucide-react'
import { useApp } from '../../state/store'
import { resumeQueue, sendQueuedNow, unqueue, useQueue, useQueued } from '../../state/queue'

/**
 * Messages waiting to go after the reply that's being written (state/queue.ts),
 * stacked over the message box. Each can be sent now, which stops the reply,
 * taken back into the box to change, or removed. After Stop or a failed
 * reply the queue waits, and says so, with a Resume.
 */
export function QueuedMessages({ chatId, onEdit }: { chatId: string; onEdit: (text: string, attachments: string[]) => void }): JSX.Element | null {
  const queued = useQueued(chatId)
  const held = useQueue((s) => Boolean(s.held[chatId]))
  const replying = useApp((s) => chatId in s.runs)
  if (queued.length === 0) return null

  return (
    <div className="queued" role="region" aria-label="Queued messages">
      <div className="queued__head">
        <span>
          {queued.length === 1 ? '1 message' : `${queued.length} messages`}{' '}
          {held ? 'waiting for you' : replying ? 'queued — sent when Eaon finishes' : 'queued'}
        </span>
        {held && !replying && (
          <button type="button" className="queued__resume" onClick={() => resumeQueue(chatId)}>
            <Play size={11} strokeWidth={2.2} />
            Resume
          </button>
        )}
      </div>
      <ol className="queued__list">
        {queued.map((message) => (
          <li key={message.id} className="queued__row">
            <CornerDownRight size={13} strokeWidth={2} className="queued__icon" aria-hidden="true" />
            <span className="queued__text" title={message.text}>
              {message.text || message.attachments.map((path) => path.split(/[\\/]/).pop()).join(', ')}
            </span>
            {message.attachments.length > 0 && message.text && (
              <span className="queued__files" title={message.attachments.join('\n')}>
                <Paperclip size={11} strokeWidth={2} />
                {message.attachments.length}
              </span>
            )}
            <span className="queued__actions">
              <button
                type="button"
                className="queued__btn"
                onClick={() => sendQueuedNow(chatId, message.id)}
                aria-label="Send now"
                title={replying ? 'Send now — stops the reply' : 'Send now'}
              >
                <Play size={12} strokeWidth={2.1} />
              </button>
              <button
                type="button"
                className="queued__btn"
                onClick={() => {
                  const taken = unqueue(chatId, message.id)
                  if (taken) onEdit(taken.text, taken.attachments)
                }}
                aria-label="Edit"
                title="Edit — back into the message box"
              >
                <PencilLine size={12} strokeWidth={2} />
              </button>
              <button type="button" className="queued__btn" onClick={() => unqueue(chatId, message.id)} aria-label="Remove" title="Remove">
                <X size={12} strokeWidth={2.2} />
              </button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
