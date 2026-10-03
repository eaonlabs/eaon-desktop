import type { ChatMessage, ChatToolPart } from '@shared/types'

/**
 * A reply as it reads, in the order it happened: its sentences, and between
 * them each run of what the agent did — thinking and tool calls, interleaved.
 *
 * The parts arrive in that order already (a reasoning part is closed by the
 * tool call after it), but the transcript used to join every reasoning part
 * into one "Thinking" block at the top and fold the tools separately below,
 * so a turn that thought, read, thought again and wrote read as all thinking
 * first and all doing after.
 */

/** One thing the agent did inside a run. */
export type TurnStep = { kind: 'thought'; key: string; text: string } | { kind: 'tool'; key: string; part: ChatToolPart }

export type TurnItem = { kind: 'text'; key: string; text: string } | { kind: 'steps'; key: string; steps: TurnStep[] }

/**
 * Calls another part of the screen already shows: the Plan panel above the
 * composer and the plan card. Listing them in the run only repeated them.
 */
const SHOWN_ELSEWHERE = new Set(['update_plan', 'present_plan'])

/**
 * Calls that keep a card of their own rather than folding into a run, because
 * what they show is the point: a swarm's live sub-agents, a generated image,
 * an edit's diff and a command's output. A run of reads and searches folds to
 * one line between them, the way a coding agent's transcript reads.
 */
const OWN_ROW = new Set(['spawn_agents', 'generate_image', 'edit_file', 'write_file', 'run_command'])

const ownsRow = (item: TurnItem): boolean =>
  item.kind === 'steps' && item.steps.length === 1 && item.steps[0].kind === 'tool' && OWN_ROW.has(item.steps[0].part.name)

/**
 * Whitespace between two steps does not split a run. Keys are the first
 * step's, so a run keeps its identity (and its open/closed state) as it grows.
 */
export function turnItems(parts: ChatMessage['parts']): TurnItem[] {
  const items: TurnItem[] = []
  const runFor = (key: string): TurnStep[] => {
    const last = items[items.length - 1]
    if (last?.kind === 'steps' && !ownsRow(last)) return last.steps
    const steps: TurnStep[] = []
    items.push({ kind: 'steps', key, steps })
    return steps
  }
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      if (part.text.trim()) items.push({ kind: 'text', key: `t${index}`, text: part.text })
      return
    }
    if (part.type === 'reasoning') {
      if (part.text.trim()) runFor(`r${index}`).push({ kind: 'thought', key: `r${index}`, text: part.text })
      return
    }
    if (part.type !== 'tool' || SHOWN_ELSEWHERE.has(part.name)) return
    if (OWN_ROW.has(part.name)) {
      items.push({ kind: 'steps', key: part.id, steps: [{ kind: 'tool', key: part.id, part }] })
      return
    }
    runFor(part.id).push({ kind: 'tool', key: part.id, part })
  })
  return items
}

/** `**Checking disk usage**` on a line of its own: how reasoning summaries title each thought. */
const HEADING = /^[ \t]*\*\*(.+?)\*\*[ \t]*$/gm

/**
 * What a thought is about, for its folded row. Reasoning summaries come as
 * `**Title**` lines, each followed by a paragraph or by nothing: the latest
 * one is what the model is on while it streams, and the first one names the
 * thought once it is done. Plain reasoning gets its first line.
 */
export function thoughtTitle(text: string, live = false): string {
  const headings = [...text.matchAll(HEADING)].map((match) => match[1].trim()).filter(Boolean)
  if (headings.length > 0) return live ? headings[headings.length - 1] : headings[0]
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line.replace(/^\s*(#+|[-*>])\s*/, '').replace(/[*_`]/g, '').trim().slice(0, 200)
}

/**
 * The thought as its open row shows it: without a leading `**Title**` that
 * the row's head already says.
 */
export function thoughtBody(text: string, title: string): string {
  const match = /^\s*\*\*(.+?)\*\*[ \t]*(\n|$)/.exec(text)
  return match && match[1].trim() === title ? text.slice(match[0].length) : text
}

/**
 * Whether a thought holds more than its title: only then does opening it show
 * anything new. Several titles count, since the folded row shows just one.
 */
export function thoughtHasBody(text: string): boolean {
  const headings = [...text.matchAll(HEADING)].length
  if (headings > 1) return true
  if (headings === 1) return text.replace(HEADING, '').trim().length > 0
  return text.trim() !== thoughtTitle(text)
}
