import { memo, useState, type JSX } from 'react'
import {
  Ban,
  Bot,
  Check,
  ChevronRight,
  FilePenLine,
  FilePlus2,
  FileText,
  FolderTree,
  GitPullRequest,
  Globe,
  ListTodo,
  Network,
  Search,
  SquareTerminal,
  TriangleAlert,
  Wrench
} from 'lucide-react'
import { ThinkingOrb } from '../ThinkingOrb'
import { FileDiff } from '../agent/FileDiff'
import { useCode } from './codeStore'
import { peekArgument, type ToolState } from './transcript'

/**
 * One Eaon Code tool call. Built on the Work transcript's `.tool` styles so a
 * coding turn reads the same in both tabs, but knows Eaon Code's own tools:
 * `edit` carries a list of replacements, `bash` streams cumulative output,
 * `subagent` reports per-agent results in its details.
 */

const ICONS: Record<string, typeof Search> = {
  read: FileText,
  bash: SquareTerminal,
  powershell: SquareTerminal,
  edit: FilePenLine,
  write: FilePlus2,
  grep: Search,
  find: Search,
  ls: FolderTree,
  subagent: Network,
  agent: Bot,
  Agent: Bot,
  todo: ListTodo,
  pr_review: GitPullRequest,
  web_search: Globe,
  web_fetch: Globe
}

const LABELS: Record<string, string> = {
  read: 'Read',
  bash: 'Run',
  powershell: 'Run',
  edit: 'Edit',
  write: 'Write',
  grep: 'Search',
  find: 'Find',
  ls: 'List',
  subagent: 'Swarm',
  agent: 'Agent',
  Agent: 'Agent',
  todo: 'Tasks',
  pr_review: 'Review PR',
  claude_code: 'Claude Code'
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The argument that says what the call did. */
function summarise(tool: ToolState): string {
  const args = tool.args
  if (Object.keys(args).length === 0) return peekArgument(tool.argsText)
  if (tool.name === 'bash' || tool.name === 'powershell') return str(args.command)
  if (tool.name === 'subagent') {
    const agents = Array.isArray(args.agents) ? (args.agents as { role?: string }[]) : []
    return agents.length ? `${agents.length} agents · ${agents.map((a) => a.role ?? 'agent').join(', ')}` : ''
  }
  if (tool.name === 'grep' || tool.name === 'find') {
    const where = str(args.path)
    return [str(args.pattern), where && where !== '.' ? `in ${where}` : ''].filter(Boolean).join(' ')
  }
  if (tool.name === 'read') {
    const range = typeof args.offset === 'number' ? ` :${args.offset}${typeof args.limit === 'number' ? `+${args.limit}` : ''}` : ''
    return str(args.path) + range
  }
  for (const key of ['path', 'file_path', 'description', 'query', 'url', 'pattern', 'title']) {
    if (str(args[key])) return str(args[key])
  }
  return ''
}

interface Change {
  file: string
  before: string
  after: string
}

/** The edits an `edit` or `write` call makes, as before/after pairs for FileDiff. */
function changesOf(tool: ToolState): Change[] {
  const args = tool.args
  const file = str(args.path) || str(args.file_path) || 'file'
  if (tool.name === 'write' && typeof args.content === 'string') return [{ file, before: '', after: args.content }]
  if (tool.name !== 'edit') return []
  const edits = Array.isArray(args.edits)
    ? (args.edits as { oldText?: unknown; newText?: unknown }[])
    : typeof args.oldText === 'string'
      ? [{ oldText: args.oldText, newText: args.newText }]
      : []
  return edits
    .filter((edit) => typeof edit.oldText === 'string' && typeof edit.newText === 'string')
    .map((edit) => ({ file, before: edit.oldText as string, after: edit.newText as string }))
}

interface SubagentSummary {
  role: string
  isError: boolean
  turns?: number
  filesChanged?: string[]
}

export const ToolRow = memo(function ToolRow({ id }: { id: string }): JSX.Element | null {
  const tool = useCode((s) => s.transcript.tools[id])
  const changes = tool ? changesOf(tool) : []
  // Edits are what a coding turn is for, so small ones show their diff
  // without a click; a whole-file write stays folded behind its line count.
  const small = changes.length > 0 && changes.every((c) => c.after.split('\n').length + c.before.split('\n').length <= 60)
  const [open, setOpen] = useState<boolean | null>(null)
  if (!tool) return null

  const running = tool.status === 'running'
  const preparing = tool.status === 'preparing'
  const isShell = tool.name === 'bash' || tool.name === 'powershell'
  const expanded = open ?? ((small && tool.status === 'done') || (running && isShell && Boolean(tool.partial)))
  const Icon = ICONS[tool.name] ?? Wrench
  const label = LABELS[tool.name] ?? tool.name
  const detail = summarise(tool)
  const agents = ((tool.details as { agents?: SubagentSummary[] } | undefined)?.agents ?? []).filter(Boolean)
  const added = changes.reduce((n, c) => n + (c.after ? c.after.split('\n').length : 0), 0)
  const removed = changes.reduce((n, c) => n + (c.before ? c.before.split('\n').length : 0), 0)

  return (
    <div className="tool code-tool" data-status={tool.status === 'error' ? 'error' : tool.status} data-open={expanded || undefined}>
      <button className="tool__head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <span className="tool__glyph">
          {running || preparing ? (
            <ThinkingOrb size={14} state={preparing ? 'working' : 'searching'} />
          ) : tool.status === 'error' ? (
            /blocked|disabled|Plan mode is on/i.test(tool.output) ? <Ban size={14} strokeWidth={2} /> : <TriangleAlert size={14} strokeWidth={2} />
          ) : (
            <Icon size={14} strokeWidth={1.9} />
          )}
        </span>
        <span className="tool__label">{label}</span>
        {detail && <span className="tool__detail">{detail}</span>}
        <span className="tool__spacer" />
        {changes.length > 0 && tool.status !== 'error' && (
          <span className="code-tool__stat">
            {added > 0 && <span className="diff__stat-add">+{added}</span>}
            {removed > 0 && <span className="diff__stat-del">−{removed}</span>}
          </span>
        )}
        {preparing && <span className="code-tool__hint shimmer">Writing call…</span>}
        {tool.status === 'done' && !expanded && changes.length === 0 && <Check size={13} strokeWidth={2} className="tool__done" />}
        <ChevronRight size={14} strokeWidth={2} className="tool__chevron" />
      </button>

      {agents.length > 0 && (
        <div className="code-tool__agents">
          {agents.map((agent, index) => (
            <span key={index} className="code-tool__agent" data-error={agent.isError || undefined}>
              {agent.isError ? <TriangleAlert size={12} strokeWidth={2} /> : <Check size={12} strokeWidth={2.2} />}
              {agent.role}
              {agent.filesChanged && agent.filesChanged.length > 0 && (
                <span className="code-tool__agent-files">{agent.filesChanged.length} files</span>
              )}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="tool__panel">
          {changes.map((change, index) => (
            <FileDiff key={index} file={change.file} before={change.before} after={change.after} />
          ))}
          {running && tool.partial && <pre className="tool__output tool__output--live scroll">{tool.partial}</pre>}
          {running && !tool.partial && <div className="tool__waiting shimmer">Running…</div>}
          {!running && tool.output && (changes.length === 0 || tool.status === 'error') && (
            <pre className="tool__output scroll" data-error={tool.status === 'error' || undefined}>
              {tool.output}
            </pre>
          )}
          {preparing && tool.argsText && <div className="tool__waiting">{tool.argsText.length.toLocaleString()} characters so far</div>}
        </div>
      )}
    </div>
  )
})
