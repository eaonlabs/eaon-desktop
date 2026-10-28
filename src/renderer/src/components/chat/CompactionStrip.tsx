import { useEffect, useState, type JSX } from 'react'
import { Check, CircleAlert, FoldVertical } from 'lucide-react'
import { useApp, type ChatCompaction } from '../../state/store'

/**
 * Above a chat's message box while Eaon summarises the chat's older messages
 * to make room in the model's context window: how far the summary has got,
 * as a percentage and a bar. Then it says it's done (or that it couldn't, and
 * the conversation went as it was) for a moment, and goes.
 */
export function CompactionStrip({ chatId }: { chatId: string }): JSX.Element | null {
  const live = useApp((s) => s.compactions[chatId] ?? null)
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
    const timer = setTimeout(() => setShown(null), 180)
    return () => clearTimeout(timer)
  }, [live])

  if (!shown) return null
  const { state, covered } = shown
  const percent = state === 'done' ? 100 : Math.round(shown.progress * 100)
  const earlier = `${covered} earlier message${covered === 1 ? '' : 's'}`
  const words =
    state === 'running'
      ? { title: 'Auto-compacting', detail: `Summarizing ${earlier} to make room` }
      : state === 'done'
        ? { title: 'Compacted', detail: `${earlier} summarized. Nothing in the chat was removed.` }
        : { title: 'Couldn’t compact', detail: 'The conversation was sent as it was.' }
  const Glyph = state === 'done' ? Check : state === 'failed' ? CircleAlert : FoldVertical

  return (
    <section className="compaction" data-state={state} data-leaving={leaving || undefined} aria-label="Auto-compact">
      <div className="compaction__line">
        <span className="compaction__icon" aria-hidden="true">
          <Glyph key={state} size={14} strokeWidth={2} />
        </span>
        <div className="compaction__words" role="status">
          <span className="compaction__title">{words.title}</span>
          <span className="compaction__detail">{words.detail}</span>
        </div>
        {state !== 'failed' && <span className="compaction__percent">{percent}%</span>}
      </div>
      <div
        className="compaction__bar"
        role="progressbar"
        aria-label="Summary written"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ transform: `scaleX(${state === 'failed' ? 0 : percent / 100})` }} />
      </div>
    </section>
  )
}
