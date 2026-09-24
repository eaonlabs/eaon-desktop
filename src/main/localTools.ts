import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import type { Settings } from '@shared/types'
import { findSymbol, indexedPaths, searchIndex } from './codeIndex'
import { isReadOnlyCommand, isRiskyCommand } from './agent/approvals'
import { capOutput, registerToolSource, type AgentTool, type ToolContext } from './agent/tools'

/**
 * Work mode's own hands: find, read, change and run, on the user's computer.
 *
 * The set mirrors what a capable agent needs to work on its own — *find*
 * (codebase_search / grep / find_file / find_symbol / list_dir), *read*
 * (read_file with line ranges), *change* (edit_file / write_file /
 * delete_file) and *verify* (run_command).
 *
 * Paths resolve against the Work folder. Anything else in the user's home
 * folder is reachable too — Work is a general agent ("tidy my Downloads"),
 * not only a coding one — but changing a file outside the Work folder always
 * asks first unless Full access is on, and a short list of credential folders
 * is off limits entirely.
 */

const MAX_OUTPUT = 16_000
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const MAX_COMMAND_TIMEOUT_MS = 600_000
const DEFAULT_READ_LINES = 300
const MAX_GREP_MATCHES = 60
const MAX_LIST_ENTRIES = 200

const HOME = homedir()

/** Folders whose contents are credentials; never read or written by the agent. */
const FORBIDDEN = ['.ssh', '.aws', '.gnupg', '.config/gh', '.docker/config.json', 'Library/Keychains', 'Library/Cookies', '.netrc'].map(
  (p) => join(HOME, p)
)

function allowedRoots(): string[] {
  const roots = [HOME, tmpdir(), '/tmp', '/private/tmp']
  if (process.platform === 'darwin') roots.push('/Volumes')
  return roots
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

interface ResolvedPath {
  path: string
  /** Inside the Work folder. */
  inside: boolean
}

export function resolveWorkPath(cwd: string, target: string): ResolvedPath {
  const root = resolve(cwd)
  const expanded = target === '~' ? HOME : target.startsWith('~/') ? join(HOME, target.slice(2)) : target
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded || '.')
  if (FORBIDDEN.some((f) => within(path, f))) {
    throw new Error(`"${target}" holds credentials, which the agent is not allowed to touch.`)
  }
  const inside = within(path, root)
  if (!inside && !allowedRoots().some((r) => within(path, r))) {
    throw new Error(`"${target}" is outside your home folder, which the agent is not allowed to access.`)
  }
  return { path, inside }
}

const display = (cwd: string, path: string): string => {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel : path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path
}

/* ------------------------------------------------------------------ shell */

const background = new Map<number, { command: string; log: string }>()

/**
 * Runs a command in the Work folder, streaming output into the transcript as
 * it arrives. Killed on timeout and when the turn is stopped — the whole
 * process group, so a `npm run dev` does not outlive the Stop button.
 */
function runCommand(command: string, ctx: ToolContext, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      shell: process.platform === 'win32' ? true : process.env.SHELL || '/bin/bash',
      cwd: ctx.cwd,
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' }
    })
    let output = ''
    let lastProgress = 0
    const kill = (): void => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      output += `\n[killed after ${Math.round(timeoutMs / 1000)}s — pass a longer timeout_seconds, or background: true for servers]`
      kill()
    }, timeoutMs)
    const onAbort = (): void => kill()
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      if (output.length > 400_000) output = output.slice(-200_000)
      const now = Date.now()
      if (now - lastProgress > 250) {
        lastProgress = now
        ctx.progress(output.slice(-4000))
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      const status = signal ? `terminated (${signal})` : `exit code ${code}`
      resolvePromise(`${status}\n${capOutput(output.trim() || '(no output)', MAX_OUTPUT)}`)
    })
  })
}

/** Starts a long-lived process (a dev server) and returns once it has had a moment to print. */
async function runBackground(command: string, cwd: string): Promise<string> {
  const log = join(tmpdir(), `eaon-bg-${Date.now()}.log`)
  const out = createWriteStream(log)
  const child = spawn(command, {
    shell: process.platform === 'win32' ? true : process.env.SHELL || '/bin/bash',
    cwd,
    detached: true,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
  })
  child.stdout?.pipe(out)
  child.stderr?.pipe(out)
  child.unref()
  if (child.pid) background.set(child.pid, { command, log })
  await new Promise((r) => setTimeout(r, 4000))
  const early = existsSync(log) ? await readFile(log, 'utf8').catch(() => '') : ''
  const exited = child.exitCode !== null
  return [
    exited ? `Process exited early with code ${child.exitCode}.` : `Started in the background, pid ${child.pid}.`,
    `Output is being written to ${log} — read it with read_file or run \`tail -n 50 ${log}\`.`,
    exited ? '' : `Stop it with \`kill ${child.pid}\` when you are done.`,
    early ? `\nFirst output:\n${capOutput(early, 4000)}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** Background processes started this session, killed when the app quits. */
export function killBackgroundProcesses(): void {
  for (const pid of background.keys()) {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      /* already exited */
    }
  }
  background.clear()
}

/* ------------------------------------------------------------- searching */

function renderHits(hits: { path: string; startLine: number; endLine: number; symbols: string[]; text: string }[]): string {
  if (hits.length === 0) return 'No matches.'
  return hits
    .map((hit) => {
      const symbols = hit.symbols.length > 0 ? ` (${hit.symbols.slice(0, 6).join(', ')})` : ''
      return `${hit.path}:${hit.startLine}-${hit.endLine}${symbols}\n${hit.text}`
    })
    .join('\n\n---\n\n')
}

/**
 * Fallback file list for grep/find_file before the folder has been indexed.
 * Hard-capped so an un-indexed home folder cannot stall a tool call.
 */
async function shallowWalk(cwd: string, limit = 4000): Promise<string[]> {
  const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'target', '.next', 'venv', '.venv', '__pycache__', 'Library'])
  const found: string[] = []
  const queue: string[] = [cwd]
  while (queue.length > 0 && found.length < limit) {
    const dir = queue.shift()!
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

async function projectFiles(cwd: string): Promise<string[]> {
  const indexed = indexedPaths(cwd)
  return indexed.length > 0 ? indexed : shallowWalk(cwd)
}

async function grepProject(cwd: string, pattern: string, include: string | undefined, caseSensitive: boolean): Promise<string> {
  let regex: RegExp
  try {
    regex = new RegExp(pattern, caseSensitive ? '' : 'i')
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
  let paths = await projectFiles(cwd)
  if (include) paths = paths.filter((path) => path.includes(include))

  const lines: string[] = []
  for (const path of paths) {
    if (lines.length >= MAX_GREP_MATCHES) break
    let content: string
    try {
      const full = join(cwd, path)
      if ((await stat(full)).size > 2_000_000) continue
      content = await readFile(full, 'utf8')
    } catch {
      continue
    }
    if (!regex.test(content)) continue
    const fileLines = content.split('\n')
    for (let i = 0; i < fileLines.length && lines.length < MAX_GREP_MATCHES; i++) {
      if (regex.test(fileLines[i])) lines.push(`${path}:${i + 1}: ${fileLines[i].trim().slice(0, 240)}`)
    }
  }
  if (lines.length === 0) return 'No matches.'
  const capped = lines.length >= MAX_GREP_MATCHES ? `\n…stopped at ${MAX_GREP_MATCHES} matches; narrow the pattern or use include.` : ''
  return capOutput(lines.join('\n') + capped, MAX_OUTPUT)
}

async function findFile(cwd: string, query: string): Promise<string> {
  const needle = query.toLowerCase()
  const scored = (await projectFiles(cwd))
    .map((path) => {
      const lower = path.toLowerCase()
      const base = lower.slice(lower.lastIndexOf('/') + 1)
      const score = base === needle ? 3 : base.includes(needle) ? 2 : lower.includes(needle) ? 1 : 0
      return { path, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, 20)
  return scored.length === 0 ? 'No matching files.' : scored.map((entry) => entry.path).join('\n')
}

async function listDir(cwd: string, target: string): Promise<string> {
  const { path } = resolveWorkPath(cwd, target || '.')
  const entries = await readdir(path, { withFileTypes: true })
  const rows: string[] = []
  for (const entry of entries.slice(0, MAX_LIST_ENTRIES)) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      rows.push(`${entry.name}/  (skipped)`)
      continue
    }
    if (entry.isDirectory()) {
      rows.push(`${entry.name}/`)
      continue
    }
    let size = ''
    try {
      const bytes = (await stat(join(path, entry.name))).size
      size = bytes < 1024 ? ` ${bytes}B` : bytes < 1_048_576 ? ` ${Math.round(bytes / 1024)}KB` : ` ${(bytes / 1_048_576).toFixed(1)}MB`
    } catch {
      /* unreadable entry; list it without a size */
    }
    rows.push(`${entry.name}${size}`)
  }
  const more = entries.length > MAX_LIST_ENTRIES ? `\n…and ${entries.length - MAX_LIST_ENTRIES} more` : ''
  return rows.length === 0 ? '(empty directory)' : rows.sort().join('\n') + more
}

async function readFileRange(cwd: string, target: string, startLine?: number, endLine?: number): Promise<string> {
  const { path } = resolveWorkPath(cwd, target)
  const info = await stat(path)
  if (info.isDirectory()) return listDir(cwd, target)
  if (info.size > 20_000_000) throw new Error(`${target} is ${Math.round(info.size / 1_048_576)}MB — too large to read. Use grep or run_command (head/tail) instead.`)
  const buffer = await readFile(path)
  if (buffer.subarray(0, 8000).includes(0)) return `${target} is a binary file (${info.size.toLocaleString()} bytes).`
  const lines = buffer.toString('utf8').split('\n')

  const from = Math.max(1, Math.floor(startLine ?? 1))
  const to = Math.min(lines.length, Math.floor(endLine ?? from + DEFAULT_READ_LINES - 1))
  if (from > lines.length) return `File has only ${lines.length} lines.`
  const body = lines
    .slice(from - 1, to)
    .map((line, i) => `${from + i}\t${line.length > 2000 ? `${line.slice(0, 2000)}…` : line}`)
    .join('\n')
  const footer = to < lines.length ? `\n…(${lines.length - to} more lines; read from ${to + 1} to continue)` : ''
  return capOutput(body + footer, MAX_OUTPUT)
}

/**
 * Exact-snippet replacement. Refusing on 0 or 2+ occurrences is the whole
 * point — a silent wrong-match edit is far worse than an error the model can
 * recover from by including more context. `replace_all` is the explicit
 * opt-out for renames.
 */
/**
 * read_file prefixes every line with its number and a tab, and smaller models
 * routinely copy those prefixes into old_text. When every line of a snippet
 * carries one, they are clearly not part of the file.
 */
const LINE_NUMBER_PREFIX = /^\s*\d+\t/
function stripLineNumbers(text: string): string | null {
  const lines = text.split('\n').filter((line, i, all) => line !== '' || i < all.length - 1)
  if (lines.length === 0 || !lines.every((line) => LINE_NUMBER_PREFIX.test(line))) return null
  return text
    .split('\n')
    .map((line) => line.replace(LINE_NUMBER_PREFIX, ''))
    .join('\n')
}

async function editFile(cwd: string, target: string, oldTextIn: string, newTextIn: string, replaceAll: boolean): Promise<string> {
  const { path } = resolveWorkPath(cwd, target)
  const content = await readFile(path, 'utf8')
  if (!oldTextIn) throw new Error('old_text is empty. Use write_file to create a file.')
  let oldText = oldTextIn
  let newText = newTextIn
  if (!content.includes(oldText)) {
    const stripped = stripLineNumbers(oldText)
    if (stripped && content.includes(stripped)) {
      oldText = stripped
      newText = stripLineNumbers(newText) ?? newText
    }
  }
  const occurrences = content.split(oldText).length - 1
  if (occurrences === 0) {
    // The single most common miss is indentation; say so when that is it.
    const loose = content.replace(/[ \t]+/g, ' ').includes(oldText.replace(/[ \t]+/g, ' '))
    throw new Error(
      `old_text was not found in ${target}.${loose ? ' It matches if whitespace is ignored — copy the indentation exactly.' : ' Read the file again and copy the exact text.'}`
    )
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(`old_text appears ${occurrences} times in ${target}. Include more surrounding lines so it matches once, or pass replace_all.`)
  }
  const next = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText)
  await writeFile(path, next, 'utf8')
  const delta = newText.split('\n').length - oldText.split('\n').length
  return `Edited ${target}${replaceAll && occurrences > 1 ? ` (${occurrences} places)` : ''} (${delta >= 0 ? '+' : ''}${delta} lines).`
}

/* ------------------------------------------------------------ the tools */

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))

function outsideWorkFolder(input: Record<string, unknown>, ctx: ToolContext): boolean {
  try {
    return !resolveWorkPath(ctx.cwd, str(input.path)).inside
  } catch {
    return true
  }
}

/** Changing a file outside the Work folder always asks, unless Full access is on. */
function riskyPath(settings: Settings): (input: Record<string, unknown>, ctx: ToolContext) => boolean {
  return (input, ctx) => !settings.general.fullAccess && outsideWorkFolder(input, ctx)
}

function fileTools(settings: Settings, indexed: boolean): AgentTool[] {
  const tool = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    run: AgentTool['run'],
    extra: Partial<AgentTool> = {}
  ): AgentTool => ({
    name,
    description,
    inputSchema: { type: 'object', properties, required },
    mutating: false,
    run,
    ...extra
  })

  const tools: AgentTool[] = [
    tool(
      'list_dir',
      'List a directory. Paths are relative to the Work folder; ~/ and absolute paths inside the home folder also work.',
      { path: { type: 'string', description: 'Directory; omit for the Work folder' } },
      [],
      (input, ctx) => listDir(ctx.cwd, str(input.path)),
      { describe: (input) => str(input.path) || '.' }
    ),
    tool(
      'read_file',
      `Read a text file with line numbers. Without start_line/end_line the first ${DEFAULT_READ_LINES} lines are returned.`,
      {
        path: { type: 'string' },
        start_line: { type: 'number', description: '1-based' },
        end_line: { type: 'number', description: '1-based, inclusive' }
      },
      ['path'],
      (input, ctx) =>
        readFileRange(
          ctx.cwd,
          str(input.path),
          input.start_line === undefined ? undefined : Number(input.start_line),
          input.end_line === undefined ? undefined : Number(input.end_line)
        ),
      { describe: (input) => str(input.path) }
    ),
    tool(
      'grep',
      'Regex search across files in the Work folder. For exact identifiers and strings.',
      {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        include: { type: 'string', description: 'Only paths containing this substring, e.g. "src/"' },
        case_sensitive: { type: 'boolean' }
      },
      ['pattern'],
      (input, ctx) => grepProject(ctx.cwd, str(input.pattern), input.include ? str(input.include) : undefined, Boolean(input.case_sensitive)),
      { describe: (input) => str(input.pattern) }
    ),
    tool(
      'find_file',
      'Find files in the Work folder by (part of) their name.',
      { query: { type: 'string' } },
      ['query'],
      (input, ctx) => findFile(ctx.cwd, str(input.query)),
      { describe: (input) => str(input.query) }
    ),
    tool(
      'edit_file',
      'Replace an exact snippet in a file. old_text must match exactly once (include surrounding lines to make it unique) unless replace_all is true. Prefer this over write_file for existing files.',
      {
        path: { type: 'string' },
        old_text: { type: 'string', description: 'Exact text to replace, including indentation' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence' }
      },
      ['path', 'old_text', 'new_text'],
      (input, ctx) => editFile(ctx.cwd, str(input.path), str(input.old_text), str(input.new_text), Boolean(input.replace_all)),
      { mutating: true, risky: riskyPath(settings), describe: (input) => `Edit ${str(input.path)}` }
    ),
    tool(
      'write_file',
      'Create a file, or replace one entirely. Creates parent folders.',
      { path: { type: 'string' }, content: { type: 'string' } },
      ['path', 'content'],
      async (input, ctx) => {
        const { path } = resolveWorkPath(ctx.cwd, str(input.path))
        const content = str(input.content)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content, 'utf8')
        return `Wrote ${content.split('\n').length} lines to ${display(ctx.cwd, path)}.`
      },
      { mutating: true, risky: riskyPath(settings), describe: (input) => `Write ${str(input.path)}` }
    ),
    tool(
      'delete_file',
      'Move a file or folder to the Trash (recoverable).',
      { path: { type: 'string' } },
      ['path'],
      async (input, ctx) => {
        const { path } = resolveWorkPath(ctx.cwd, str(input.path))
        if (path === resolve(ctx.cwd) || path === HOME) throw new Error('Refusing to delete the Work folder or the home folder itself.')
        await shell.trashItem(path)
        return `Moved ${display(ctx.cwd, path)} to the Trash.`
      },
      {
        mutating: true,
        // Recoverable from the Trash, so only a delete outside the Work folder asks in auto mode.
        risky: riskyPath(settings),
        describe: (input) => `Delete ${str(input.path)}`
      }
    ),
    tool(
      'move_file',
      'Move or rename a file or folder. Creates the destination folder if needed; will not overwrite.',
      { from: { type: 'string' }, to: { type: 'string' } },
      ['from', 'to'],
      async (input, ctx) => {
        const from = resolveWorkPath(ctx.cwd, str(input.from)).path
        const to = resolveWorkPath(ctx.cwd, str(input.to)).path
        if (existsSync(to)) throw new Error(`${str(input.to)} already exists.`)
        await mkdir(dirname(to), { recursive: true })
        const { rename } = await import('node:fs/promises')
        await rename(from, to)
        return `Moved ${display(ctx.cwd, from)} → ${display(ctx.cwd, to)}.`
      },
      {
        mutating: true,
        risky: (input, ctx) =>
          !settings.general.fullAccess && (outsideWorkFolder({ path: input.from }, ctx) || outsideWorkFolder({ path: input.to }, ctx)),
        describe: (input) => `Move ${str(input.from)} → ${str(input.to)}`
      }
    ),
    tool(
      'run_command',
      'Run a shell command in the Work folder and return its exit code and output. Use it to build, test, run scripts, use git, and inspect the system. For servers and watchers pass background: true.',
      {
        command: { type: 'string' },
        timeout_seconds: { type: 'number', description: `Default ${DEFAULT_COMMAND_TIMEOUT_MS / 1000}, max ${MAX_COMMAND_TIMEOUT_MS / 1000}` },
        background: { type: 'boolean', description: 'Start a long-running process and return immediately' }
      },
      ['command'],
      (input, ctx) => {
        const command = str(input.command)
        if (!command.trim()) throw new Error('command is empty.')
        if (input.background) return runBackground(command, ctx.cwd)
        const timeout = Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1000, Number(input.timeout_seconds) * 1000 || DEFAULT_COMMAND_TIMEOUT_MS))
        return runCommand(command, ctx, timeout)
      },
      {
        // Looking (ls, git status, grep) is not changing anything, so it
        // neither asks for approval nor is blocked in plan mode.
        mutating: (input) => Boolean(input.background) || !isReadOnlyCommand(str(input.command)),
        risky: (input) => isRiskyCommand(str(input.command)),
        describe: (input) => str(input.command)
      }
    )
  ]

  if (indexed) {
    tools.push(
      tool(
        'codebase_search',
        'Semantic search over the indexed Work folder ("where are API keys decrypted?"). Best first step in unfamiliar code.',
        { query: { type: 'string' }, limit: { type: 'number', description: 'Default 10' } },
        ['query'],
        async (input, ctx) => {
          const limit = Number(input.limit) > 0 ? Math.min(Number(input.limit), 25) : 10
          return capOutput(renderHits(await searchIndex(ctx.cwd, str(input.query), limit)), MAX_OUTPUT)
        },
        { describe: (input) => str(input.query) }
      ),
      tool(
        'find_symbol',
        'Find where a function, class, type or method is declared, with its code.',
        { name: { type: 'string' } },
        ['name'],
        async (input, ctx) => {
          const hits = findSymbol(ctx.cwd, str(input.name))
          return hits.length === 0 ? `No symbol matching "${str(input.name)}". Try grep.` : capOutput(renderHits(hits), MAX_OUTPUT)
        },
        { describe: (input) => str(input.name) }
      )
    )
  }
  return tools
}

registerToolSource({
  id: 'files',
  tools: (query) => (query.mode === 'work' && query.cwd ? fileTools(query.settings, indexedPaths(query.cwd).length > 0) : []),
  guidance: () =>
    [
      'Files and shell: relative paths resolve against the Work folder. Read before you edit; prefer edit_file for small changes. After changing code, run the project\'s own build/test command to verify.',
      'Python: create a venv (python3 -m venv .venv && .venv/bin/pip install …) rather than installing packages system-wide.'
    ].join('\n')
})

/** One-line summary of a tool call, for traces. */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const first = ['command', 'path', 'query', 'pattern', 'name', 'url'].map((k) => args[k]).find((v) => typeof v === 'string' && v)
  return typeof first === 'string' ? first : name
}
