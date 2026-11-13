import type { AgentTool, ToolContext } from './agent/tools'
import { BINARY_EXTENSIONS, HeadAndTail, MAX_GREP_MATCHES, MAX_LIST_ENTRIES, MAX_OUTPUT, applyEdit, includeFilter, listRow, rankFiles, renderRead } from './agent/fileText'
import {
  RemoteError,
  openRemote,
  remoteBackground,
  remoteFiles,
  remoteGrep,
  remoteList,
  remoteMove,
  remotePlace,
  remoteRead,
  remoteRun,
  remoteTrash,
  remoteWrite
} from './remoteWork'
import { remoteLocation } from '@shared/adeRemote'

/**
 * Work mode's file and shell tools for a project on another machine
 * (shared/adeRemote.ts). They are the same tools localTools.ts offers, with
 * the same names, approval rules and command lists, and only what they do
 * changes: each one runs over SSH on the host (remoteWork.ts), inside the
 * project's folder. Nothing here touches this computer's disk.
 *
 * What is different, and said to the model in each description: the folder is
 * a boundary (no ~ and no paths elsewhere on the host), delete moves into
 * ~/.eaon-trash on the host, grep uses the host's ripgrep, git grep or grep,
 * and commands run in the host user's bash (a login shell) so its PATH
 * applies.
 */

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const MAX_COMMAND_TIMEOUT_MS = 600_000
/** A file read over SSH is capped well below what a local read allows. */
const READ_LIMIT = 5_000_000
/** Past this, a replaced file's old text isn't kept for its diff: the transcript would carry it. */
const KEEP_REPLACED_BYTES = 256 * 1024
const MAX_SEARCH_FILES = 20_000

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))

/** An optional 1-based line bound; models fill an unset number with null or 0. */
function lineNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? n : undefined
}

async function listDir(ctx: ToolContext, target: string): Promise<string> {
  const { path, root } = remotePlace(ctx.cwd, target || '.')
  const project = await openRemote(ctx.cwd)
  const { entries, total } = await remoteList({ ...project, root }, path, MAX_LIST_ENTRIES, ctx.signal)
  const rows = entries.map((entry) => listRow(entry.name, entry.directory, entry.directory ? null : entry.size))
  const more = total > entries.length ? `\n…and ${total - entries.length} more` : ''
  return rows.length === 0 ? '(empty directory)' : rows.sort().join('\n') + more
}

async function readFile(ctx: ToolContext, target: string, startLine?: number, endLine?: number): Promise<string> {
  const { path, root } = remotePlace(ctx.cwd, target)
  const project = await openRemote(ctx.cwd)
  try {
    const file = await remoteRead({ ...project, root }, path, READ_LIMIT, ctx.signal)
    if (file.size > READ_LIMIT) throw new Error(`${target} is ${Math.round(file.size / 1_048_576)}MB — too large to read over SSH. Use grep or run_command (head/tail) instead.`)
    return renderRead(file.bytes, file.size, target, startLine, endLine)
  } catch (error) {
    // A folder is listed, as read_file does on this computer.
    if (error instanceof RemoteError && /is a folder/.test(error.message)) return listDir(ctx, target)
    throw error
  }
}

async function grep(ctx: ToolContext, pattern: string, include: string | undefined, caseSensitive: boolean): Promise<string> {
  try {
    new RegExp(pattern)
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
  const project = await openRemote(ctx.cwd)
  const wanted = include ? includeFilter(include) : null
  // Asked for more than will be shown: the include filter and binary files drop some.
  const found = await remoteGrep(project, pattern, caseSensitive, MAX_GREP_MATCHES * 50, ctx.signal)
  const lines: string[] = []
  for (const raw of found) {
    const m = /^(.*?):(\d+):(.*)$/.exec(raw)
    if (!m || BINARY_EXTENSIONS.test(m[1]) || (wanted && !wanted(m[1]))) continue
    lines.push(`${m[1]}:${m[2]}: ${m[3].trim().slice(0, 240)}`)
    if (lines.length >= MAX_GREP_MATCHES) break
  }
  if (lines.length === 0) return 'No matches.'
  const capped = lines.length >= MAX_GREP_MATCHES ? `\n…stopped at ${MAX_GREP_MATCHES} matches; narrow the pattern or use include.` : ''
  return lines.join('\n') + capped
}

async function findFile(ctx: ToolContext, query: string): Promise<string> {
  const project = await openRemote(ctx.cwd)
  const listing = await remoteFiles(project, MAX_SEARCH_FILES, ctx.signal)
  const found = rankFiles(listing.paths, query)
  const partial = listing.truncated ? `\n(Looked through the first ${MAX_SEARCH_FILES.toLocaleString()} files only.)` : ''
  return (found.length === 0 ? 'No matching files.' : found.join('\n')) + partial
}

async function editFile(ctx: ToolContext, target: string, oldText: string, newText: string, replaceAll: boolean): Promise<string> {
  const { path, root } = remotePlace(ctx.cwd, target)
  const project = { ...(await openRemote(ctx.cwd)), root }
  const file = await remoteRead(project, path, READ_LIMIT, ctx.signal)
  if (file.size > READ_LIMIT) throw new Error(`${target} is too large to edit over SSH.`)
  if (file.bytes.subarray(0, 8000).includes(0)) throw new Error(`${target} is a binary file.`)
  const { next, summary } = applyEdit(file.bytes.toString('utf8'), target, oldText, newText, replaceAll)
  await remoteWrite(project, path, Buffer.from(next, 'utf8'), ctx.signal)
  return summary
}

/** A file's text before a write replaces it: null when there is none, undefined when it's too big, not text, or unreadable. */
async function textBefore(cwd: string, target: string): Promise<string | null | undefined> {
  try {
    const { path, root } = remotePlace(cwd, target)
    const file = await remoteRead({ ...(await openRemote(cwd)), root }, path, KEEP_REPLACED_BYTES + 1)
    if (file.size > KEEP_REPLACED_BYTES || file.bytes.includes(0)) return undefined
    return file.bytes.toString('utf8')
  } catch (error) {
    return error instanceof RemoteError && /doesn’t exist/.test(error.message) ? null : undefined
  }
}

async function runCommand(ctx: ToolContext, command: string, timeoutMs: number): Promise<string> {
  const project = await openRemote(ctx.cwd)
  const seconds = Math.round(timeoutMs / 1000)
  const output = new HeadAndTail(MAX_OUTPUT)
  let lastProgress = 0
  const { code, timedOut } = await remoteRun(project, command, seconds, {
    signal: ctx.signal,
    onData: (text) => {
      output.push(text)
      const now = Date.now()
      if (now - lastProgress > 250) {
        lastProgress = now
        ctx.progress(output.recent(4000))
      }
    }
  })
  const status = timedOut ? 'terminated (timeout)' : code === null ? 'terminated' : `exit code ${code}`
  const note = timedOut ? `\n[killed after ${seconds}s — pass a longer timeout_seconds, or background: true for servers]` : ''
  return `${status}\n${output.text() || '(no output)'}${note}`
}

async function runBackground(ctx: ToolContext, command: string): Promise<string> {
  const started = await remoteBackground(await openRemote(ctx.cwd), command)
  return [
    started.alive ? `Started in the background on the host, pid ${started.pid}.` : 'Process exited early.',
    `Output is being written to ${started.log} on the host — read it with run_command \`tail -n 50 ${started.log}\`.`,
    started.alive ? `Stop it with run_command \`pkill -P ${started.pid}; kill ${started.pid}\` when you are done.` : '',
    started.early ? `\nFirst output:\n${started.early.slice(0, 4000)}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** What each tool is when the project is on another machine; the rest of the tool (its approval rules, its lists) is the one on this computer. */
const OVERRIDES: Record<string, (tool: AgentTool) => Partial<AgentTool>> = {
  list_dir: () => ({
    description: 'List a directory in the project on the remote machine. Paths are relative to the project folder.',
    run: (input, ctx) => listDir(ctx, str(input.path))
  }),
  read_file: () => ({
    description: `Read a text file in the project on the remote machine, with line numbers. Without start_line/end_line the first 300 lines are returned.`,
    run: (input, ctx) => readFile(ctx, str(input.path), lineNumber(input.start_line), lineNumber(input.end_line))
  }),
  grep: () => ({
    description: 'Regex search across the project on the remote machine (the host’s ripgrep, git grep or grep). For exact identifiers and strings.',
    run: (input, ctx) => grep(ctx, str(input.pattern), input.include ? str(input.include) : undefined, Boolean(input.case_sensitive))
  }),
  find_file: () => ({
    description: 'Find files in the project on the remote machine by (part of) their name.',
    run: (input, ctx) => findFile(ctx, str(input.query))
  }),
  edit_file: () => ({
    run: (input, ctx) => editFile(ctx, str(input.path), str(input.old_text), str(input.new_text), Boolean(input.replace_all))
  }),
  write_file: () => ({
    run: async (input, ctx) => {
      const target = str(input.path)
      const content = str(input.content)
      const before = await textBefore(ctx.cwd, target)
      const { path, root } = remotePlace(ctx.cwd, target)
      await remoteWrite({ ...(await openRemote(ctx.cwd)), root }, path, Buffer.from(content, 'utf8'), ctx.signal)
      // A final newline ends the last line; it does not start another.
      const lines = content === '' ? 0 : content.replace(/\n$/, '').split('\n').length
      return {
        text: before === null ? `Wrote ${lines} lines to ${target}.` : `Replaced ${target} with ${lines} lines.`,
        ...(before !== undefined ? { before } : {})
      }
    },
    replaces: (input, ctx) => textBefore(ctx.cwd, str(input.path))
  }),
  delete_file: () => ({
    description: 'Move a file or folder in the project on the remote machine to ~/.eaon-trash there (recoverable).',
    run: async (input, ctx) => {
      const target = str(input.path)
      const { path, root } = remotePlace(ctx.cwd, target)
      const trashed = await remoteTrash({ ...(await openRemote(ctx.cwd)), root }, path)
      return `Moved ${target} to ${trashed} on the host.`
    }
  }),
  move_file: () => ({
    run: async (input, ctx) => {
      const from = remotePlace(ctx.cwd, str(input.from))
      const to = remotePlace(ctx.cwd, str(input.to))
      await remoteMove({ ...(await openRemote(ctx.cwd)), root: from.root }, from.path, to.path)
      return `Moved ${str(input.from)} → ${str(input.to)}.`
    }
  }),
  run_command: () => ({
    description:
      'Run a shell command in the project folder on the remote machine and return its exit code and output. It runs in the host user’s bash, so what is installed there is what you have. Use it to build, test, run scripts and use git. For servers and watchers pass background: true.',
    run: (input, ctx) => {
      const command = str(input.command)
      if (!command.trim()) throw new Error('command is empty.')
      if (input.background) return runBackground(ctx, command)
      const timeout = Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1000, Number(input.timeout_seconds) * 1000 || DEFAULT_COMMAND_TIMEOUT_MS))
      return runCommand(ctx, command, timeout)
    }
  })
}

/** The file and shell tools of a project on another machine: `local` is the set localTools.ts offers, each with its run swapped for the SSH one. */
export function remoteFileTools(local: AgentTool[]): AgentTool[] {
  return local.flatMap((tool) => {
    const override = OVERRIDES[tool.name]
    // Anything else (the code index) reads this computer's disk.
    return override ? [{ ...tool, ...override(tool) }] : []
  })
}

/** What the model is told about a project on another machine. */
export function remoteGuidance(cwd: string): string | null {
  const place = remoteLocation(cwd)
  return place
    ? `This project is on another machine over SSH, in ${place.path} there. Every file and command tool works on that machine, inside that folder: use paths relative to it, not ~ or paths elsewhere on the host. Its tools and versions are the host's, not this computer's. Read before you edit; prefer edit_file for small changes. After changing code, run the project's own build/test command to verify.`
    : null
}
