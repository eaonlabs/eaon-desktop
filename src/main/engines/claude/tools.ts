/**
 * Claude's tools (Claude Code's, through the Agent SDK) as Eaon's own tool
 * names, so the work rows read "Read 2 files and ran a command" as they do
 * for Eaon's loop, Codex and the ACP engines.
 */

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)

/** Tools that change something outside the conversation when they run. */
const MUTATING = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'KillShell', 'KillBash'])

export interface EaonTool {
  name: string
  input: Record<string, unknown>
  mutating: boolean
  /** One line for an approval: the command, or the file. */
  summary: string
}

export function toolOf(name: string, raw: Record<string, unknown>): EaonTool {
  const path = text(raw.file_path) ?? text(raw.notebook_path) ?? text(raw.path)
  // An MCP server's tool may do anything its server does: it's asked about like one that changes something.
  const mutating = MUTATING.has(name) || name.startsWith('mcp__')
  switch (name) {
    case 'Bash': {
      const command = text(raw.command) ?? ''
      return { name: 'run_command', input: { command, ...(text(raw.description) ? { description: raw.description } : {}) }, mutating, summary: command }
    }
    case 'Read':
      return { name: 'read_file', input: path ? { path } : {}, mutating, summary: path ?? 'Read a file' }
    case 'Write':
      return { name: 'write_file', input: { path: path ?? '', content: text(raw.content) ?? '' }, mutating, summary: path ?? 'Write a file' }
    case 'Edit':
      return { name: 'edit_file', input: { path: path ?? '', old_text: raw.old_string ?? '', new_text: raw.new_string ?? '' }, mutating, summary: path ?? 'Edit a file' }
    case 'MultiEdit':
      return { name: 'edit_file', input: { path: path ?? '', edits: Array.isArray(raw.edits) ? raw.edits : [] }, mutating, summary: path ?? 'Edit a file' }
    case 'NotebookEdit':
      return { name: 'edit_file', input: { path: path ?? '' }, mutating, summary: path ?? 'Edit a notebook' }
    case 'Grep':
      return { name: 'grep', input: { pattern: text(raw.pattern) ?? '', ...(path ? { path } : {}) }, mutating, summary: text(raw.pattern) ?? 'Search' }
    case 'Glob':
      return { name: 'find_file', input: { pattern: text(raw.pattern) ?? '', ...(path ? { path } : {}) }, mutating, summary: text(raw.pattern) ?? 'Find files' }
    case 'LS':
      return { name: 'list_dir', input: path ? { path } : {}, mutating, summary: path ?? 'List a folder' }
    case 'WebSearch':
      return { name: 'web_search', input: { query: text(raw.query) ?? '' }, mutating, summary: text(raw.query) ?? 'Search the web' }
    case 'WebFetch':
      return { name: 'web_fetch', input: { url: text(raw.url) ?? '' }, mutating, summary: text(raw.url) ?? 'Fetch a page' }
    case 'Task':
    case 'Agent':
      return {
        name: 'subagent',
        input: { task: text(raw.description) ?? text(raw.prompt) ?? '', ...(text(raw.subagent_type) ? { role: raw.subagent_type } : {}) },
        mutating,
        summary: text(raw.description) ?? 'Start a subagent'
      }
    case 'Skill':
      return { name: 'load_skill', input: { name: text(raw.skill) ?? text(raw.name) ?? '' }, mutating, summary: text(raw.skill) ?? 'Use a skill' }
    default: {
      // An MCP server's tool reads as the tool's own name ("mcp__eaon-app__chats" → "chats").
      const short = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name
      return { name: short, input: raw, mutating, summary: short }
    }
  }
}

/** Claude's todo list (its TodoWrite tool) as Eaon's. */
export function todosOf(raw: Record<string, unknown>): { text: string; status: 'pending' | 'in_progress' | 'done' }[] | null {
  if (!Array.isArray(raw.todos)) return null
  return raw.todos.flatMap((item) => {
    const todo = item as { content?: unknown; status?: unknown }
    if (typeof todo.content !== 'string') return []
    const status = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'in_progress' : 'pending'
    return [{ text: todo.content, status } as const]
  })
}
