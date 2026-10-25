import { useMemo, useRef, type JSX } from 'react'
import { useApp } from '../../state/store'
import { estimateContext } from '../../state/contextUse'
import { Popover, useDisclosure } from '../ui'

/**
 * A small ring by the model in a conversation's message box: about how much
 * of the model's context the chat fills. Opens to the numbers, and to when
 * Eaon starts summarizing older messages to make room. Hidden when the model
 * doesn't say how big its context is.
 */
export function ContextMeter({ contextWindow }: { contextWindow: number | undefined }): JSX.Element | null {
  const chat = useApp((s) => s.activeChat())
  const compactAt = useApp((s) => s.settings?.context?.compactAt ?? 0.7)
  const autoCompact = useApp((s) => s.settings?.context?.autoCompact !== false)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useDisclosure()
  // Estimating walks the whole chat, so only when the messages change, not on every store update.
  const messages = chat?.messages
  const summary = chat?.summary
  const used = useMemo(() => (chat ? estimateContext(chat) : 0), [messages, summary]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!chat || !contextWindow || contextWindow <= 0) return null
  const share = Math.min(1, used / contextWindow)
  const percent = share * 100
  const full = autoCompact && share >= compactAt
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const shown = percent < 10 ? percent.toFixed(1).replace(/\.0$/, '') : String(Math.round(percent))

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="context-meter"
        data-open={panel.open || undefined}
        data-full={full || undefined}
        onClick={panel.toggle}
        aria-label={`Context window about ${shown}% full`}
        title={`Context window about ${shown}% full`}
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={radius} className="context-meter__track" />
          <circle
            cx="9"
            cy="9"
            r={radius}
            className="context-meter__fill"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - share)}
          />
        </svg>
      </button>
      <Popover anchor={anchor} open={panel.open} onClose={panel.close} placement="top-end" width={250}>
        <div className="context-panel">
          <div className="context-panel__head">
            <span>Context window</span>
            <span className="context-panel__numbers">
              {shown}% · {compactTokens(used)} / {compactTokens(contextWindow)}
            </span>
          </div>
          <div
            className="context-panel__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            aria-label="Context window used"
          >
            <span style={{ width: `${percent}%` }} data-full={full || undefined} />
            {autoCompact && <i style={{ left: `${compactAt * 100}%` }} aria-hidden="true" />}
          </div>
          <p className="context-panel__note">
            {!autoCompact
              ? 'Summarizing older messages is off, so a long chat can run out of room. The count is an estimate.'
              : full
                ? 'Next turn, Eaon summarizes the older messages to make room. Nothing in the chat is removed.'
                : `At ${Math.round(compactAt * 100)}%, Eaon summarizes the older messages to make room. The count is an estimate.`}
          </p>
        </div>
      </Popover>
    </>
  )
}

/** 54,210 → "54k", 1,048,576 → "1M". */
export function compactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`
  if (count >= 1000) return `${Math.round(count / 1000)}k`
  return String(count)
}
