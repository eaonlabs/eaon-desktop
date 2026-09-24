import { useState, type JSX } from 'react'
import {
  Ban,
  ChevronRight,
  FilePenLine,
  FilePlus2,
  FolderTree,
  Globe,
  Search,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  FileText,
  Check
} from 'lucide-react'
import type { ChatToolPart } from '@shared/types'
import { ThinkingOrb } from '../ThinkingOrb'
import { FileDiff } from './FileDiff'
import { SwarmCard, ToolImages } from './WorkBits'

/**
 * One tool call in the transcript.
 *
 * Collapsed by default and summarised down to the one argument that says what
 * the call actually did — the path, the command, the query. A coding turn makes
 * dozens of these, and a list that shows every argument and every result in
 * full buries the reply they were in service of. The orb spins only while the
 * call is in flight, so the row that is still working is the one that moves.
 */

const ICONS: Record<string, typeof Search> = {
  read_file: FileText,
  list_dir: FolderTree,
  grep: Search,
  codebase_search: Search,
  find_file: Search,
  find_symbol: Search,
  edit_file: FilePenLine,
  write_file: FilePlus2,
  delete_file: Trash2,
  run_command: SquareTerminal,
  web_search: Globe,
  web_fetch: Globe
}

/** The single argument worth putting next to the tool's name. */
function summarise(name: string, input: Record<string, unknown>): string {
  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = input[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return ''
  }
  if (name === 'run_command') return first('command')
  if (name === 'spawn_agents') return Array.isArray(input.agents) ? `${input.agents.length} agents` : ''
  if (name === 'move_file') return [first('from'), first('to')].filter(Boolean).join(' → ')
  return first('path', 'query', 'pattern', 'name', 'url', 'action', 'title')
}

const LABELS: Record<string, string> = {
  read_file: 'Read',
  list_dir: 'List',
  grep: 'Search',
  codebase_search: 'Search',
  find_file: 'Find',
  find_symbol: 'Find symbol',
  edit_file: 'Edit',
  write_file: 'Write',
  delete_file: 'Delete',
  run_command: 'Run',
  web_search: 'Web search',
  web_fetch: 'Read page',
  move_file: 'Move',
  update_plan: 'Update plan',
  present_plan: 'Present plan',
  spawn_agents: 'Swarm',
  goal_complete: 'Goal complete',
  goal_blocked: 'Goal blocked',
  plugin_tools: 'Plugin tools',
  use_plugin_tool: 'Plugin'
}

export function ToolCall({ part }: { part: ChatToolPart }): JSX.Element {
  // A command still running opens itself so its live output is visible.
  const [open, setOpen] = useState(false)
  const showProgress = part.status === 'running' && Boolean(part.progress)

  const Icon = ICONS[part.name] ?? SquareTerminal
  const label = LABELS[part.name] ?? part.name
  const detail = summarise(part.name, part.input)
  const running = part.status === 'running'

  const before = typeof part.input.old_text === 'string' ? part.input.old_text : null
  const after =
    typeof part.input.new_text === 'string'
      ? part.input.new_text
      : typeof part.input.content === 'string'
        ? part.input.content
        : null
  // A diff is the honest rendering of a change; the tool's own one-line output
  // is what the model reads, not what the user needs to review.
  const diff = after !== null ? { file: String(part.input.path ?? 'file'), before: before ?? '', after } : null

  return (
    <div className="tool" data-status={part.status} data-open={open || showProgress || undefined}>
      <button className="tool__head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool__glyph">
          {running ? (
            <ThinkingOrb size={14} state="searching" />
          ) : part.status === 'denied' ? (
            <Ban size={14} strokeWidth={2} />
          ) : part.status === 'error' ? (
            <TriangleAlert size={14} strokeWidth={2} />
          ) : (
            <Icon size={14} strokeWidth={1.9} />
          )}
        </span>
        <span className="tool__label">{label}</span>
        {detail && <span className="tool__detail">{detail}</span>}
        <span className="tool__spacer" />
        {part.status === 'done' && !open && <Check size={13} strokeWidth={2} className="tool__done" />}
        <ChevronRight size={14} strokeWidth={2} className="tool__chevron" />
      </button>

      {part.agents && part.agents.length > 0 && <SwarmCard agents={part.agents} />}
      {part.images && part.images.length > 0 && <ToolImages images={part.images} />}

      {showProgress && !open && (
        <div className="tool__panel">
          <pre className="tool__output tool__output--live scroll">{part.progress}</pre>
        </div>
      )}

      {open && (
        <div className="tool__panel">
          {diff && <FileDiff file={diff.file} before={diff.before} after={diff.after} />}
          {part.output !== null && part.output.length > 0 && (
            <pre className="tool__output scroll">{part.output}</pre>
          )}
          {running && part.progress && <pre className="tool__output tool__output--live scroll">{part.progress}</pre>}
          {running && !part.progress && <div className="tool__waiting shimmer">Running…</div>}
        </div>
      )}
    </div>
  )
}
