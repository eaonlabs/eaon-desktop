import { useEffect, useId, useState, type JSX } from 'react'
import { ChevronDown } from 'lucide-react'
import { useApp, type ChatCompaction } from '../../state/store'

/**
 * In the conversation, where the reply is about to appear, while Eaon
 * summarises the chat's older messages to make room in the model's context:
 * one line saying so, with how far the summary has got under it as a thin
 * bar and a percentage. When it's done it says so for a moment, then makes
 * way for the reply.
 */
export function CompactionNotice({ chatId, messageId }: { chatId: string; messageId: string }): JSX.Element | null {
  const live = useApp((s) => {
    const entry = s.compactions[chatId]
    return entry?.messageId === messageId ? entry : null
  })
  // The last one stays through its exit, after the store has let it go.
  const [shown, setShown] = useState<ChatCompaction | null>(live)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (live) {
      setShown(live)
      setLeaving(false)
      return
    }
    setLeaving(true)
    const timer = setTimeout(() => setShown(null), 200)
    return () => clearTimeout(timer)
  }, [live])

  if (!shown) return null
  const { state, covered } = shown
  const percent = state === 'done' ? 100 : Math.round(shown.progress * 100)
  const earlier = `${covered} earlier message${covered === 1 ? '' : 's'}`
  const label =
    state === 'running' ? 'Compacting the conversation to make room…' : state === 'done' ? 'Conversation compacted' : 'Couldn’t compact the conversation'
  const detail =
    state === 'failed'
      ? 'It was sent as it was.'
      : `${state === 'running' ? 'Summarizing' : 'Summarized'} ${earlier} so the model has room to keep going. Nothing in the chat is removed.`

  return (
    <div className="compaction" data-state={state} data-leaving={leaving || undefined} title={detail}>
      <div className="compaction__line">
        <span className={`compaction__label${state === 'running' ? ' step-shimmer' : ''}`} role="status" aria-label={`${label} ${detail}`}>
          {label}
        </span>
        {state !== 'failed' && (
          <span className="compaction__percent" aria-hidden="true">
            {percent}%
          </span>
        )}
      </div>
      {state !== 'failed' ? (
        <div className="compaction__bar" role="progressbar" aria-label="Summary written" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <span style={{ transform: `scaleX(${percent / 100})` }} />
        </div>
      ) : (
        <p className="compaction__detail">{detail}</p>
      )}
    </div>
  )
}

/**
 * Where the chat was last compacted: a rule saying so, which opens to the
 * summary the model now works from in place of the messages above it.
 */
export function CompactedDivider({ summary }: { summary: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="thread-compacted" data-open={open || undefined}>
      <div className="thread-compacted__rule">
        <button type="button" className="thread-compacted__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          Conversation compacted
          <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div id={id} className="thread-compacted__summary">
          <div className="thread-compacted__caption">What the model works from in place of the messages above. They’re all still here.</div>
          {summary}
        </div>
      )}
    </div>
  )
}
