import { useEffect, useRef, useState, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { ThinkingOrb } from './ThinkingOrb'

/**
 * A live view of what the model is doing while it works.
 *
 * The steps are parsed out of the real reasoning stream rather than invented:
 * the provider layer emits a `↳ toolName` marker whenever it dispatches an MCP
 * tool call, so the prose between markers is that step's reasoning. Motion here
 * is informational — the shimmer marks which step is running right now, and the
 * cascade shows the order things happened in.
 */

const TOOL_MARKER = /\n↳ (.+?)\n/g

export interface ThinkingStep {
  id: string
  label: string
  detail: string
  /** A tool step names an MCP tool; a thought step is plain reasoning. */
  kind: 'thought' | 'tool'
}

export function parseThinkingSteps(reasoning: string): ThinkingStep[] {
  if (!reasoning.trim()) return []

  const steps: ThinkingStep[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  TOOL_MARKER.lastIndex = 0

  while ((match = TOOL_MARKER.exec(reasoning)) !== null) {
    const before = reasoning.slice(lastIndex, match.index).trim()
    if (before) {
      steps.push({ id: `t${steps.length}`, label: 'Thinking', detail: before, kind: 'thought' })
    }
    steps.push({ id: `x${steps.length}`, label: match[1].trim(), detail: '', kind: 'tool' })
    lastIndex = match.index + match[0].length
  }

  const tail = reasoning.slice(lastIndex).trim()
  if (tail) {
    // Attach trailing prose to the tool step it follows, so a tool call and its
    // result read as one step instead of two.
    const previous = steps[steps.length - 1]
    if (previous && previous.kind === 'tool') previous.detail = tail
    else steps.push({ id: `t${steps.length}`, label: 'Thinking', detail: tail, kind: 'thought' })
  }

  return steps
}

export function ThinkingSteps({
  reasoning,
  streaming
}: {
  reasoning: string
  streaming: boolean
}): JSX.Element | null {
  // Re-parsed only when the reasoning text actually changes, not on every
  // unrelated re-render of the surrounding thread.
  const steps = useMemo(() => parseThinkingSteps(reasoning), [reasoning])
  const [open, setOpen] = useState(false)
  // Collapsed by default once finished; auto-expanded while work is in flight so
  // the user can watch it happen without clicking.
  const expanded = streaming || open

  if (steps.length === 0) return null

  const toolCount = steps.filter((s) => s.kind === 'tool').length
  // The orb switches to its scanning form while a tool is actually running.
  const activeKind = steps[steps.length - 1]?.kind ?? 'thought'
  const summary = streaming
    ? 'Working'
    : toolCount > 0
      ? `Thought and used ${toolCount} tool${toolCount === 1 ? '' : 's'}`
      : 'Thought about this'

  return (
    <div className="thinking">
      <button
        className="thinking__summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expanded}
      >
        {streaming ? (
          <ThinkingOrb size={20} state={activeKind === 'tool' ? 'searching' : 'working'} />
        ) : (
          <span className="thinking__dot" />
        )}
        <span className={streaming ? 'shimmer' : undefined}>{summary}</span>
        <ChevronRight
          size={13}
          strokeWidth={2}
          className="thinking__chevron"
          data-open={expanded || undefined}
        />
      </button>

      <div className="thinking__body" data-open={expanded || undefined}>
        <ol className="thinking__list">
          {steps.map((step, index) => {
            const isLast = index === steps.length - 1
            const active = streaming && isLast
            return (
              <li
                key={step.id}
                className="thinking__step"
                data-active={active || undefined}
                data-last={isLast || undefined}
                style={{ ['--i' as string]: index }}
              >
                <span className="thinking__marker">
                  <span className="thinking__bullet" />
                  {!isLast && <span className="thinking__connector" />}
                </span>
                <span className="thinking__content">
                  <span className={`thinking__label ${active ? 'shimmer' : ''}`}>
                    {step.kind === 'tool' ? <code>{step.label}</code> : step.label}
                  </span>
                  {step.detail && <span className="thinking__detail">{step.detail}</span>}
                </span>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

/** Auto-scrolls its container as content streams in, unless the user scrolled away. */
export function useStickToBottom(deps: unknown[]): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 160
    if (nearBottom) node.scrollTop = node.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return ref
}
