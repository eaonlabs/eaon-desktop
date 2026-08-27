import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { McpTool } from '@shared/types'
import { findSymbol, indexedPaths, searchIndex } from './codeIndex'

/**
 * Eaon Work's built-in coding tools — not MCP, just local capabilities scoped
 * to whatever project folder the workspace points at.
 *
 * The set mirrors what a Cursor-style agent needs to work on its own:
 * *find* (codebase_search / grep / find_file / find_symbol / list_dir),
 * *read* (read_file with line ranges), *change* (edit_file / write_file /
 * delete_file), and *verify* (run_command). Every path is resolved against the
 * project folder and rejected if it escapes; `run_command` still runs a real
 * shell, so a command that `cd`s elsewhere is not stopped, but the file tools
 * are hard-contained.
 */

export const LOCAL_TOOL_NAMES = [
  'codebase_search',
  'grep',
  'find_file',
  'find_symbol',
  'list_dir',
  'read_file',
  'edit_file',
  'write_file',
  'delete_file',
  'run_command'
] as const
export type LocalToolName = (typeof LOCAL_TOOL_NAMES)[number]

export function isLocalTool(name: string): name is LocalToolName {
  return (LOCAL_TOOL_NAMES as readonly string[]).includes(name)
}

/** Tools that change the working tree or run code, so they need approval. */
const MUTATING_TOOLS = new Set<LocalToolName>(['edit_file', 'write_file', 'delete_file', 'run_command'])

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name as LocalToolName)
}

/** Tools offered to the model once a project folder is set; empty otherwise. */
export function localToolsFor(cwd: string | null): McpTool[] {
  if (!cwd) return []
  const tool = (name: LocalToolName, description: string, properties: Record<string, unknown>, required: string[]): McpTool => ({
    name,
    description,
    serverId: 'local',
    inputSchema: { type: 'object', properties, required }
  })

  return [
    tool(
      'codebase_search',
      'Semantic search across the indexed project. Ask in natural language ("where are API keys decrypted?") to find relevant code without knowing filenames. Prefer this first when exploring unfamiliar code.',
      {
        query: { type: 'string', description: 'Natural-language description of what you are looking for' },
        limit: { type: 'number', description: 'Maximum results (default 12)' }
      },
      ['query']
    ),
    tool(
      'grep',
      'Regex search over project files. Use for exact strings and identifiers when you know what the text looks like; use codebase_search for conceptual questions.',
      {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        include: { type: 'string', description: 'Only search paths containing this substring, e.g. "src/main"' },
        case_sensitive: { type: 'boolean', description: 'Default false' }
      },
      ['pattern']
    ),
    tool(
      'find_file',
      'Fuzzy-match file paths by name. Use when you roughly know the filename but not where it lives.',
      { query: { type: 'string', description: 'Part of a filename or path' } },
      ['query']
    ),
    tool(
      'find_symbol',
      'Locate where a function, class, type or method is declared, and return its code.',
      { name: { type: 'string', description: 'Exact or partial symbol name' } },
      ['name']
    ),
    tool(
      'list_dir',
      'List the contents of a directory in the project. Good for orienting yourself before searching.',
      { path: { type: 'string', description: 'Directory relative to the project root; omit for the root' } },
      []
    ),
    tool(
      'read_file',
      'Read a text file. Pass start_line/end_line to read part of a large file; without them the first 400 lines are returned.',
      {
        path: { type: 'string', description: 'File path relative to the project root' },
        start_line: { type: 'number', description: '1-based first line to read' },
        end_line: { type: 'number', description: '1-based last line to read' }
      },
      ['path']
    ),
    tool(
      'edit_file',
      'Make a targeted edit by replacing an exact snippet. `old_text` must appear EXACTLY ONCE in the file — include a few surrounding lines to make it unique. Prefer this over write_file for existing files.',
      {
        path: { type: 'string', description: 'File path relative to the project root' },
        old_text: { type: 'string', description: 'Exact text to replace, including whitespace' },
        new_text: { type: 'string', description: 'Replacement text' }
      },
      ['path', 'old_text', 'new_text']
    ),
    tool(
      'write_file',
      'Create a new file, or completely replace an existing one. For edits to existing files prefer edit_file.',
      {
        path: { type: 'string', description: 'File path relative to the project root' },
        content: { type: 'string', description: 'Full file contents' }
      },
      ['path', 'content']
    ),
    tool(
      'delete_file',
      'Delete a file from the project.',
      { path: { type: 'string', description: 'File path relative to the project root' } },
      ['path']
    ),
    tool(
      'run_command',
      'Run a shell command in the project folder and return its exit code and output. Use this to build, test, lint, or inspect git state — verify your changes rather than assuming they work.',
      { command: { type: 'string', description: 'Shell command to run' } },
      ['command']
    )
  ]
}

/* ----------------------------------------------------------------- limits */

const MAX_OUTPUT = 20_000
const COMMAND_TIMEOUT_MS = 120_000
const DEFAULT_READ_LINES = 400
const MAX_GREP_MATCHES = 50
const MAX_LIST_ENTRIES = 200

function truncate(text: string, limit = MAX_OUTPUT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…(truncated)` : text
}

/** Resolves `target` against `cwd`, refusing anything that escapes it. */
function resolveInProject(cwd: string, target: string): string {
  const root = resolve(cwd)
  const resolved = resolve(root, target)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Refusing to access "${target}" — it is outside the project folder (${root}).`)
  }
  return resolved
}

function runCommand(command: string, cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { shell: true, cwd, timeout: COMMAND_TIMEOUT_MS })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      const status = signal ? `killed (${signal}, likely timed out)` : `exit code ${code}`
      resolvePromise(`${status}\n${truncate(output)}`)
    })
  })
}

/** Render search hits the way the model reads them best: path, lines, code. */
function renderHits(hits: { path: string; startLine: number; endLine: number; symbols: string[]; text: string }[]): string {
  if (hits.length === 0) return 'No matches.'
  return hits
    .map((hit) => {
      const symbols = hit.symbols.length > 0 ? ` (${hit.symbols.slice(0, 6).join(', ')})` : ''
      return `${hit.path}:${hit.startLine}-${hit.endLine}${symbols}\n${hit.text}`
    })
    .join('\n\n---\n\n')
}

async function grepProject(
  cwd: string,
  pattern: string,
  include: string | undefined,
  caseSensitive: boolean
): Promise<string> {
  let regex: RegExp
  try {
    regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi')
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Search the indexed file list when there is one; it already excludes
  // node_modules, build output and anything .gitignore rules out.
  let paths = indexedPaths(cwd)
  if (paths.length === 0) paths = await shallowWalk(cwd)
  if (include) paths = paths.filter((path) => path.includes(include))

  const lines: string[] = []
  let matches = 0
  for (const path of paths) {
    if (matches >= MAX_GREP_MATCHES) break
    let content: string
    try {
      content = await readFile(join(cwd, path), 'utf8')
    } catch {
      continue
    }
    const fileLines = content.split('\n')
    for (let i = 0; i < fileLines.length && matches < MAX_GREP_MATCHES; i++) {
      regex.lastIndex = 0
      if (regex.test(fileLines[i])) {
        lines.push(`${path}:${i + 1}: ${fileLines[i].trim().slice(0, 300)}`)
        matches++
      }
    }
  }

  if (lines.length === 0) return 'No matches.'
  const capped = matches >= MAX_GREP_MATCHES ? `\n…stopped at ${MAX_GREP_MATCHES} matches; narrow the pattern.` : ''
  return truncate(lines.join('\n') + capped)
}

/**
 * Fallback file list for grep/find_file before the project has been indexed.
 * Deliberately shallow-ish and hard-capped so an un-indexed monorepo cannot
 * stall a tool call.
 */
async function shallowWalk(cwd: string, limit = 4000): Promise<string[]> {
  const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'target', '.next', 'venv', '.venv', '__pycache__'])
  const found: string[] = []
  const queue: string[] = [cwd]
  while (queue.length > 0 && found.length < limit) {
    const dir = queue.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.isFile()) found.push(relative(cwd, full).split(sep).join('/'))
    }
  }
  return found
}

/** Ranks fuzzy filename matches: exact basename first, then path substring. */
async function findFile(cwd: string, query: string): Promise<string> {
  let paths = indexedPaths(cwd)
  if (paths.length === 0) paths = await shallowWalk(cwd)
  const needle = query.toLowerCase()

  const scored = paths
    .map((path) => {
      const lower = path.toLowerCase()
      const base = lower.slice(lower.lastIndexOf('/') + 1)
      if (base === needle) return { path, score: 3 }
      if (base.includes(needle)) return { path, score: 2 }
      if (lower.includes(needle)) return { path, score: 1 }
      return { path, score: 0 }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, 20)

  return scored.length === 0 ? 'No matching files.' : scored.map((entry) => entry.path).join('\n')
}

async function listDir(cwd: string, path: string): Promise<string> {
  const target = resolveInProject(cwd, path || '.')
  const entries = await readdir(target, { withFileTypes: true })
  const rows: string[] = []
  for (const entry of entries.slice(0, MAX_LIST_ENTRIES)) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      rows.push(`${entry.name}/  (skipped)`)
      continue
    }
    if (entry.isDirectory()) {
      rows.push(`${entry.name}/`)
    } else {
      let size = ''
      try {
        size = ` (${(await stat(join(target, entry.name))).size} bytes)`
      } catch {
        /* ignore */
      }
      rows.push(`${entry.name}${size}`)
    }
  }
  const more = entries.length > MAX_LIST_ENTRIES ? `\n…and ${entries.length - MAX_LIST_ENTRIES} more` : ''
  return rows.length === 0 ? '(empty directory)' : rows.sort().join('\n') + more
}

async function readFileRange(cwd: string, path: string, startLine?: number, endLine?: number): Promise<string> {
  const target = resolveInProject(cwd, path)
  const content = await readFile(target, 'utf8')
  const lines = content.split('\n')

  const from = Math.max(1, Math.floor(startLine ?? 1))
  const to = Math.min(lines.length, Math.floor(endLine ?? from + DEFAULT_READ_LINES - 1))
  if (from > lines.length) return `File has only ${lines.length} lines.`

  const body = lines
    .slice(from - 1, to)
    .map((line, i) => `${from + i}\t${line}`)
    .join('\n')
  const footer = to < lines.length ? `\n…(${lines.length - to} more lines; read from ${to + 1} to continue)` : ''
  return truncate(body + footer)
}

/**
 * Exact-snippet replacement. Refusing on 0 or 2+ occurrences is the whole
 * point — a silent wrong-match edit is far worse than an error the model can
 * recover from by including more context.
 */
async function editFile(cwd: string, path: string, oldText: string, newText: string): Promise<string> {
  const target = resolveInProject(cwd, path)
  const content = await readFile(target, 'utf8')

  const occurrences = content.split(oldText).length - 1
  if (occurrences === 0) {
    throw new Error(
      `old_text was not found in ${path}. Read the file again and copy the exact text, including indentation.`
    )
  }
  if (occurrences > 1) {
    throw new Error(
      `old_text appears ${occurrences} times in ${path}. Include more surrounding lines so it matches exactly once.`
    )
  }

  await writeFile(target, content.replace(oldText, newText), 'utf8')
  const delta = newText.split('\n').length - oldText.split('\n').length
  return `Edited ${path} (${delta >= 0 ? '+' : ''}${delta} lines).`
}

export async function runLocalTool(name: LocalToolName, args: Record<string, unknown>, cwd: string): Promise<string> {
  switch (name) {
    case 'codebase_search': {
      const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 25) : 12
      return truncate(renderHits(await searchIndex(cwd, String(args.query ?? ''), limit)))
    }
    case 'grep':
      return grepProject(cwd, String(args.pattern ?? ''), args.include ? String(args.include) : undefined, Boolean(args.case_sensitive))
    case 'find_file':
      return findFile(cwd, String(args.query ?? ''))
    case 'find_symbol': {
      const hits = findSymbol(cwd, String(args.name ?? ''))
      return hits.length === 0
        ? `No symbol matching "${String(args.name ?? '')}" in the index. Try grep, or ask the user to index the project.`
        : truncate(renderHits(hits))
    }
    case 'list_dir':
      return listDir(cwd, String(args.path ?? ''))
    case 'read_file':
      return readFileRange(
        cwd,
        String(args.path ?? ''),
        args.start_line === undefined ? undefined : Number(args.start_line),
        args.end_line === undefined ? undefined : Number(args.end_line)
      )
    case 'edit_file':
      return editFile(cwd, String(args.path ?? ''), String(args.old_text ?? ''), String(args.new_text ?? ''))
    case 'write_file': {
      const target = resolveInProject(cwd, String(args.path ?? ''))
      const content = String(args.content ?? '')
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      return `Wrote ${content.split('\n').length} lines to ${String(args.path ?? '')}.`
    }
    case 'delete_file': {
      const target = resolveInProject(cwd, String(args.path ?? ''))
      await unlink(target)
      return `Deleted ${String(args.path ?? '')}.`
    }
    case 'run_command':
      return runCommand(String(args.command ?? ''), cwd)
  }
}

/**
 * One-line summary of a tool call — used both by the approval dialog and by
 * the thinking trace, so the user sees "Edit src/main/store.ts" rather than a
 * bare tool name repeated ten times.
 */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'run_command':
      return String(args.command ?? '')
    case 'edit_file':
      return `Edit ${String(args.path ?? '')}`
    case 'write_file':
      return `Write ${String(args.path ?? '')}`
    case 'delete_file':
      return `Delete ${String(args.path ?? '')}`
    case 'codebase_search':
      return String(args.query ?? '')
    case 'grep':
      return String(args.pattern ?? '')
    case 'find_file':
      return String(args.query ?? '')
    case 'find_symbol':
      return String(args.name ?? '')
    case 'list_dir':
      return String(args.path ?? '.')
    case 'read_file':
      return String(args.path ?? '')
    default:
      return name
  }
}
