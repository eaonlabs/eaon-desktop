import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { ActivityGroup } from './Activity'
import { PixelGrid } from './Loaders'
import { Markdown } from './Markdown'
import { describeToolPart, ToolCall } from './ToolCall'
import { thoughtBody, thoughtHasBody, thoughtTitle, type TurnStep } from './turnItems'

/**
 * One thought, as a row among the turn's tool calls: folded to its title,
 * opening into the reasoning itself, rendered as Markdown (summaries arrive
 * as `**Title**` paragraphs, which read as literal asterisks otherwise).
 *
 * The thought being written now is open, so it can be read as it arrives,
 * and folds to its title once the agent moves on, unless the user opened or
 * closed it themselves. Its body is a short window that follows the newest
 * line while it streams. Memoised on its text: earlier thoughts do not change
 * while a later step streams.
 */
export const ThoughtRow = memo(function ThoughtRow({ text, live }: { text: string; live: boolean }): JSX.Element {
  const [chosen, setChosen] = useState<boolean | null>(null)
  const hasBody = thoughtHasBody(text)
  const open = hasBody && (chosen ?? live)
  const title = thoughtTitle(text, live)
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (live && open && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [text, live, open])
  return (
    <div className="tool thought" data-open={open || undefined} data-live={live || undefined}>
      <button
        className="tool__head"
        onClick={() => hasBody && setChosen(!open)}
        aria-expanded={hasBody ? open : undefined}
        data-static={!hasBody || undefined}
      >
        <span className="tool__glyph">
          <span className="tool__icon">{live ? <PixelGrid cell={3} /> : <Brain size={13} strokeWidth={1.9} />}</span>
          {hasBody && <ChevronRight size={13} strokeWidth={2.2} className="tool__chevron" />}
        </span>
        <span className={`tool__label${live ? ' step-shimmer' : ''}`}>{live ? 'Thinking' : 'Thought'}</span>
        {title && <span className="thought__title">{title}</span>}
      </button>
      {open && (
        <div className="tool__panel">
          <div>
            <div className="thought__body scroll" ref={body}>
              <Markdown text={thoughtBody(text, title)} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

function Step({ step, live }: { step: TurnStep; live: boolean }): JSX.Element {
  return step.kind === 'thought' ? <ThoughtRow text={step.text} live={live} /> : <ToolCall part={step.part} />
}

/** Rows of a run opened after the fact come in one after another, up to this many. */
const STAGGERED = 10

/**
 * A run of steps between two sentences of the reply. One step is its own
 * row; two or more fold into one line ("Thought, read 3 files and ran a
 * command") that stays open while the run is live, listing every thought and
 * call in the order they happened.
 */
export function StepRun({ steps, active }: { steps: TurnStep[]; active: boolean }): JSX.Element {
  const last = steps[steps.length - 1]
  // Only the newest thought of a live run is still being written.
  const liveThought = active && last.kind === 'thought'
  if (steps.length === 1) return <Step step={last} live={liveThought} />

  const tools = steps.flatMap((step) => (step.kind === 'tool' ? [step.part] : []))
  const running = tools.find((part) => part.status === 'running' && part.progress)
  return (
    <ActivityGroup
      calls={tools.map(describeToolPart)}
      thoughts={steps.length - tools.length}
      active={active}
      thinking={liveThought}
      live={running && <pre className="tool__output tool__output--live activity__live scroll">{running.progress}</pre>}
    >
      {steps.map((step, index) => (
        // A live run's rows arrive one at a time already; a finished one opened
        // later lays its rows in with a short stagger.
        <div key={step.key} className="step" style={{ '--i': active ? 0 : Math.min(index, STAGGERED) } as CSSProperties}>
          <Step step={step} live={liveThought && step === last} />
        </div>
      ))}
    </ActivityGroup>
  )
}
