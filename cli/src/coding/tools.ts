import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { getToolSource, registerToolSource, type AgentTool, type ToolContext, type ToolQuery } from '@main/agent/tools'
import { resolveWorkPath } from '@main/localTools'
import { fileDiff, type FileDiff } from './diff'
import { diagnose, formatDiagnostics, type Diagnostic } from './lsp'
import { replaceIn } from './replace'

/**
 * The agent's coding hands in the CLI: the app's file tools, made as good
 * as opencode's where it counts.
 *
 * The app's own tools (src/main/localTools.ts) keep their safety rules —
 * credential folders are off limits, changes outside the work folder ask —
 * because each tool here keeps the original's schema flags (`mutating`,
 * `risky`, `catastrophic`) and resolves paths with the same function. What
 * changes:
 * - edit_file finds the text with opencode's chain of matchers (indentation,
 *   whitespace, escapes, anchors…), keeps the file's line endings and BOM,
 *   and can create a file when old_text is empty;
 * - edit_file and write_file (and delete/move) record a real diff of what
 *   they changed, which the transcript draws, and ask the project's language
 *   server for errors in the new text, which go back to the model;
 * - read_file reads 2,000 lines by default; grep uses ripgrep when it's
 *   installed; glob finds files by pattern.
 *
 * The diff and diagnostics of each call are kept in `toolMeta` by tool call
 * id; the chat controller copies them onto the transcript's tool part.
 */

export interface ToolMeta {
  path?: string
  diff?: FileDiff
  diagnostics?: Diagnostic[]
  /** The file's text before the call, for undo where git snapshots aren't available. Not saved. */
  before?: string | null
  absolute?: string
  /** Matches (grep) or files (glob, find). */
  count?: number
  /** read_file: the lines shown and the file's length. */
  lines?: { from: number; to: number; total: number }
  /** How edit_file found the text, when it wasn't an exact match. */
  strategy?: string
}

/**
 * By tool call id. Chat turns take their entries as results arrive; calls
 * from workers and trading sessions never pass through a chat, so the
 * oldest entries are dropped past a few hundred.
 */
class MetaMap extends Map<string, ToolMeta> {
  override set(key: string, value: ToolMeta): this {
    super.set(key, value)
    if (this.size > 300) for (const old of [...this.keys()].slice(0, this.size - 300)) this.delete(old)
    return this
  }
}

export const toolMeta: Map<string, ToolMeta> = new MetaMap()

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
const READ_LINES = 2000
const MAX_LINE = 2000
const MAX_READ_BYTES = 60_000
const MAX_RESULTS = 100

const shown = (cwd: string, path: string): string => {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel : path
}

function readTextFile(path: string): { text: string; bom: boolean } | null {
  try {
    const buffer = readFileSync(path)
    if (buffer.subarray(0, 8000).includes(0)) return null
    const text = buffer.toString('utf8')
    return text.charCodeAt(0) === 0xfeff ? { text: text.slice(1), bom: true } : { text, bom: false }
  } catch {
    return null
  }
}

/** The project root for language servers: the git top level, else the work folder. */
const rootCache = new Map<string, string>()
function projectRoot(cwd: string): string {
  let root = rootCache.get(cwd)
  if (!root) {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 3000 })
    root = result.status === 0 && result.stdout.trim() ? result.stdout.trim() : cwd
    rootCache.set(cwd, root)
  }
  return root
}

/** Diagnostics for a changed file, as the extra text the model gets and the list the screen shows. */
async function checkFile(path: string, text: string, ctx: ToolContext): Promise<{ note: string; items: Diagnostic[] }> {
  const items = (await diagnose(path, text, projectRoot(ctx.cwd))) ?? []
  const block = formatDiagnostics(shown(ctx.cwd, path), items)
  return { note: block ? `\n\nLSP errors detected in this file, please fix:\n${block}` : '', items: items.filter((d) => (d.severity ?? 1) === 1) }
}

/* ------------------------------------------------------------------ read */

function readFileTool(base: AgentTool): AgentTool {
  return {
    ...base,
    description: `Read a text file. Lines come back numbered ("12\\tcode"); copy text after the tab when editing. Up to ${READ_LINES} lines by default: read whole files or large ranges, not small slices, and read several files at once when you know you need them.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'number', description: '1-based first line (default 1)' },
        end_line: { type: 'number', description: `1-based last line, inclusive (default start_line + ${READ_LINES - 1})` }
      },
      required: ['path']
    },
    run: async (input, ctx) => {
      const { path } = resolveWorkPath(ctx.cwd, str(input.path))
      const info = await stat(path)
      if (info.isDirectory()) return base.run(input, ctx)
      if (info.size > 20_000_000) throw new Error(`${str(input.path)} is ${Math.round(info.size / 1_048_576)} MB, too large to read. Use grep, or read a range.`)
      const file = readTextFile(path)
      if (!file) return `${str(input.path)} is a binary file (${info.size.toLocaleString()} bytes).`
      const lines = file.text.split('\n')
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
      const total = lines.length
      if (total === 0 || (total === 1 && lines[0] === '')) return `${str(input.path)} is empty.`
      const from = Math.max(1, Math.floor(Number(input.start_line) || 1))
      if (from > total) throw new Error(`start_line ${from} is past the end of the file (${total} lines).`)
      let to = Math.min(total, Math.floor(Number(input.end_line) || from + READ_LINES - 1))
      let out = ''
      let bytes = 0
      for (let n = from; n <= to; n++) {
        const line = lines[n - 1]
        const row = `${n}\t${line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… (line cut at ${MAX_LINE} characters)` : line}\n`
        if (bytes + row.length > MAX_READ_BYTES && n > from) {
          to = n - 1
          break
        }
        out += row
        bytes += row.length
      }
      out += to < total ? `\n(Showing lines ${from}-${to} of ${total}. Read from start_line ${to + 1} to continue.)` : `\n(End of file, ${total} lines.)`
      toolMeta.set(ctx.toolId, { path: shown(ctx.cwd, path), lines: { from, to, total } })
      return out
    }
  }
}

/* ------------------------------------------------------------------ edit */

function editFileTool(base: AgentTool): AgentTool {
  return {
    ...base,
    description:
      'Change a file by replacing exact text. Read the file first, then copy old_text exactly (after the line-number tab), with enough surrounding lines to match one place; replace_all changes every match (renames). An empty old_text creates a new file. Prefer this to write_file for existing files.',
    run: async (input, ctx) => {
      const { path } = resolveWorkPath(ctx.cwd, str(input.path))
      const oldText = str(input.old_text)
      const newTextRaw = str(input.new_text)
      const display = shown(ctx.cwd, path)
      if (!existsSync(path)) {
        if (oldText !== '') throw new Error(`${display} does not exist. To create it, pass an empty old_text (or use write_file).`)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, newTextRaw, 'utf8')
        const diff = fileDiff(display, null, newTextRaw)
        const check = await checkFile(path, newTextRaw, ctx)
        toolMeta.set(ctx.toolId, { path: display, absolute: path, diff, before: null, diagnostics: check.items })
        return `Created ${display} (${diff.additions} lines).${check.note}`
      }
      if (statSync(path).isDirectory()) throw new Error(`${display} is a folder, not a file.`)
      const file = readTextFile(path)
      if (!file) throw new Error(`${display} is a binary file.`)
      if (oldText === '') throw new Error(`${display} already exists, so old_text can't be empty. Give the exact text to replace, or use write_file to replace the whole file.`)
      const crlf = file.text.includes('\r\n')
      const ending = (text: string): string => (crlf ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n'))
      // read_file prefixes lines with "N<tab>"; a model that copies them along has quoted the file, not changed it.
      const numbered = /^\s*\d+\t/
      const strip = (text: string): string => (text.split('\n').every((l, i, all) => numbered.test(l) || (l === '' && i === all.length - 1)) ? text.replace(/^\s*\d+\t/gm, '') : text)
      let result
      try {
        result = replaceIn(file.text, ending(oldText), ending(newTextRaw), Boolean(input.replace_all))
      } catch (error) {
        const stripped = strip(oldText)
        if (stripped === oldText) throw new Error(`${display}: ${error instanceof Error ? error.message : String(error)}`)
        result = replaceIn(file.text, ending(stripped), ending(strip(newTextRaw)), Boolean(input.replace_all))
      }
      await writeFile(path, (file.bom ? '﻿' : '') + result.content, 'utf8')
      const diff = fileDiff(display, file.text, result.content)
      const check = await checkFile(path, result.content, ctx)
      toolMeta.set(ctx.toolId, {
        path: display,
        absolute: path,
        diff,
        before: file.text,
        diagnostics: check.items,
        ...(result.strategy !== 'exact' ? { strategy: result.strategy } : {})
      })
      const where = result.occurrences > 1 ? ` (${result.occurrences} places)` : ''
      const fuzzy = result.strategy !== 'exact' ? ` Matched by ${result.strategy}; check the diff is what you meant.` : ''
      return `Edited ${display}${where}: +${diff.additions} -${diff.deletions}.${fuzzy}${check.note}`
    }
  }
}

/* ---------------------------------------------------------------- write */

function writeFileTool(base: AgentTool): AgentTool {
  return {
    ...base,
    description: 'Create a file, or replace one entirely (creates folders). For changes to an existing file use edit_file. Don\'t create documentation files unless asked.',
    run: async (input, ctx) => {
      const { path } = resolveWorkPath(ctx.cwd, str(input.path))
      const display = shown(ctx.cwd, path)
      const before = existsSync(path) ? (readTextFile(path)?.text ?? null) : null
      const result = await base.run(input, ctx)
      const after = readTextFile(path)?.text ?? str(input.content)
      const diff = fileDiff(display, before, after)
      const check = await checkFile(path, after, ctx)
      toolMeta.set(ctx.toolId, { path: display, absolute: path, diff, before, diagnostics: check.items })
      const text = typeof result === 'string' ? result : result.text
      return `${text}${before !== null ? ` (+${diff.additions} -${diff.deletions})` : ''}${check.note}`
    }
  }
}

function deleteFileTool(base: AgentTool): AgentTool {
  return {
    ...base,
    run: async (input, ctx) => {
      const { path } = resolveWorkPath(ctx.cwd, str(input.path))
      const display = shown(ctx.cwd, path)
      const isFile = existsSync(path) && statSync(path).isFile()
      const before = isFile ? (readTextFile(path)?.text ?? null) : null
      const result = await base.run(input, ctx)
      if (isFile) toolMeta.set(ctx.toolId, { path: display, absolute: path, diff: before !== null ? fileDiff(display, before, null) : undefined, before })
      return result
    }
  }
}

function moveFileTool(base: AgentTool): AgentTool {
  return {
    ...base,
    run: async (input, ctx) => {
      const from = resolveWorkPath(ctx.cwd, str(input.from)).path
      const to = resolveWorkPath(ctx.cwd, str(input.to)).path
      const result = await base.run(input, ctx)
      toolMeta.set(ctx.toolId, {
        path: shown(ctx.cwd, to),
        absolute: to,
        diff: { path: shown(ctx.cwd, to), oldPath: shown(ctx.cwd, from), status: 'renamed', additions: 0, deletions: 0, hunks: [] }
      })
      return result
    }
  }
}

/* ------------------------------------------------------- search: ripgrep */

let rgPath: string | null | undefined
function ripgrep(): string | null {
  if (rgPath !== undefined) return rgPath
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['rg'], { encoding: 'utf8' })
  rgPath = found.status === 0 ? found.stdout.split('\n')[0].trim() || null : null
  return rgPath
}

function run(command: string, args: string[], cwd: string, signal: AbortSignal, maxBytes = 2_000_000): Promise<{ code: number; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const abort = (): void => {
      child.kill()
    }
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => {
      if (out.length < maxBytes) out += chunk
      else child.kill()
    })
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', fail)
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (code === 2 && !out) fail(new Error(err.trim().split('\n')[0] || 'search failed'))
      else done({ code: code ?? 0, out })
    })
  })
}

function grepTool(base: AgentTool): AgentTool {
  return {
    ...base,
    description:
      'Search file contents with a regular expression (ripgrep syntax when available), skipping .gitignore\'d files. Returns path:line: text, at most 100 matches. Use include to narrow to files ("*.ts", "src/**/*.tsx").',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression' },
        include: { type: 'string', description: 'Glob of files to search ("*.ts", "src/**/*.tsx")' },
        path: { type: 'string', description: 'Folder to search in; default the work folder' },
        case_sensitive: { type: 'boolean' }
      },
      required: ['pattern']
    },
    run: async (input, ctx) => {
      const rg = ripgrep()
      if (!rg) {
        const result = await base.run(input, ctx)
        const text = typeof result === 'string' ? result : result.text
        toolMeta.set(ctx.toolId, { count: text.startsWith('No matches') ? 0 : text.split('\n').filter((l) => /:\d+:/.test(l)).length })
        return result
      }
      const dir = input.path ? resolveWorkPath(ctx.cwd, str(input.path)).path : ctx.cwd
      const args = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '300', '--max-columns-preview', '--hidden', '-g', '!.git']
      if (!input.case_sensitive) args.push('--smart-case')
      if (input.include) args.push('-g', str(input.include))
      args.push('-e', str(input.pattern), '--', '.')
      const { out } = await run(rg, args, dir, ctx.signal)
      const lines = out.split('\n').filter(Boolean)
      toolMeta.set(ctx.toolId, { count: lines.length })
      if (lines.length === 0) return 'No matches.'
      const prefix = dir === ctx.cwd ? '' : `${shown(ctx.cwd, dir)}${sep}`
      const body = lines.slice(0, MAX_RESULTS).map((l) => prefix + l.replace(/^\.\//, ''))
      return body.join('\n') + (lines.length > MAX_RESULTS ? `\n… ${lines.length - MAX_RESULTS} more matches; narrow the pattern or use include.` : '')
    }
  }
}

/** A glob as a regular expression over paths with forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  let braces = 0
  const pattern = glob.replace(/^\.\//, '')
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      i++
      if (pattern[i + 1] === '/') {
        i++
        source += '(?:.*/)?'
      } else source += '.*'
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else if (c === '{') {
      braces++
      source += '(?:'
    } else if (c === '}' && braces > 0) {
      braces--
      source += ')'
    } else if (c === ',' && braces > 0) source += '|'
    else source += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(pattern.includes('/') ? `^${source}$` : `(?:^|/)${source}$`)
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', '.venv', 'venv', '__pycache__', 'target', '.cache'])

async function walk(root: string, match: RegExp, limit: number, signal: AbortSignal): Promise<string[]> {
  const found: { path: string; mtime: number }[] = []
  const queue = ['']
  let seen = 0
  while (queue.length && found.length < limit * 5 && seen < 50_000) {
    if (signal.aborted) break
    const rel = queue.shift()!
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen++
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(path)
      } else if (match.test(path)) {
        let mtime = 0
        try {
          mtime = (await stat(join(root, path))).mtimeMs
        } catch {
          /* gone already */
        }
        found.push({ path, mtime })
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.path)
}

function globTool(): AgentTool {
  return {
    name: 'glob',
    description: 'Find files by name pattern ("**/*.test.ts", "src/**/*.{css,scss}"), newest first, skipping .gitignore\'d files. At most 100.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Folder to search in; default the work folder' } },
      required: ['pattern']
    },
    mutating: false,
    describe: (input) => str(input.pattern),
    run: async (input, ctx) => {
      const dir = input.path ? resolveWorkPath(ctx.cwd, str(input.path)).path : ctx.cwd
      const pattern = str(input.pattern)
      let files: string[]
      const rg = ripgrep()
      if (rg) {
        const { out } = await run(rg, ['--files', '--hidden', '-g', '!.git', '-g', pattern, '--sortr', 'modified'], dir, ctx.signal)
        files = out.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''))
      } else files = await walk(dir, globToRegExp(pattern), MAX_RESULTS, ctx.signal)
      toolMeta.set(ctx.toolId, { count: files.length })
      if (files.length === 0) return 'No files found.'
      const prefix = dir === ctx.cwd ? '' : `${shown(ctx.cwd, dir)}/`
      return files.slice(0, MAX_RESULTS).map((f) => prefix + f).join('\n') + (files.length > MAX_RESULTS ? `\n… ${files.length - MAX_RESULTS} more; use a narrower pattern.` : '')
    }
  }
}

/* --------------------------------------------------------------- the set */

const CODING_GUIDANCE = [
  'Coding (you are in a terminal; the user sees every tool call, diff and command output):',
  '- Keep replies short and direct; use GitHub-flavored markdown and reference code as path:line.',
  '- Find before you change: grep and glob to locate code, read_file on whole files or large ranges (call several at once when they are independent).',
  '- Change existing files with edit_file, copying old_text exactly with enough context to match once; write_file only for new files or full rewrites. Never create documentation files unless asked. No emojis unless asked.',
  '- Follow the codebase: match its style, imports and libraries; check package.json, pyproject.toml or similar before adding a dependency.',
  '- An edit result may list LSP errors: fix them before moving on.',
  "- Verify with the project's own commands (tests, typecheck, build, lint) through run_command, and report failures honestly. Don't commit or push unless asked.",
  '- For work with three or more steps, keep a checklist with update_plan and mark items done as you go.'
].join('\n')

/**
 * Replaces the app's `files` tool source with the enhanced one. Called once
 * at boot; the original source keeps producing the tools, this wraps them.
 */
export function installCodingTools(): void {
  const base = getToolSource('files')
  if (!base || base.id === 'files' && (base as { cli?: boolean }).cli) return
  const enhance = (tools: AgentTool[]): AgentTool[] => {
    const out = tools.map((tool) => {
      switch (tool.name) {
        case 'read_file':
          return readFileTool(tool)
        case 'edit_file':
          return editFileTool(tool)
        case 'write_file':
          return writeFileTool(tool)
        case 'delete_file':
          return deleteFileTool(tool)
        case 'move_file':
          return moveFileTool(tool)
        case 'grep':
          return grepTool(tool)
        default:
          return tool
      }
    })
    if (out.length) {
      const at = out.findIndex((t) => t.name === 'find_file')
      out.splice(at === -1 ? out.length : at, 0, globTool())
    }
    return out
  }
  registerToolSource({
    id: 'files',
    cli: true,
    tools: (query: ToolQuery) => enhance(base.tools(query)),
    guidance: (query: ToolQuery) => {
      const tools = base.tools(query)
      if (tools.length === 0) return null
      return [base.guidance?.(query), CODING_GUIDANCE].filter(Boolean).join('\n')
    }
  } as Parameters<typeof registerToolSource>[0])
}

/**
 * What an edit or write would change, without changing anything: for the
 * approval card, so the user approves a diff, not a description.
 */
export function previewChange(tool: string, input: Record<string, unknown>, cwd: string): { diff?: FileDiff; error?: string } | null {
  try {
    if (tool === 'edit_file') {
      const { path } = resolveWorkPath(cwd, str(input.path))
      const display = shown(cwd, path)
      if (!existsSync(path)) return str(input.old_text) === '' ? { diff: fileDiff(display, null, str(input.new_text)) } : { error: `${display} does not exist.` }
      const file = readTextFile(path)
      if (!file) return null
      const result = replaceIn(file.text, str(input.old_text), str(input.new_text), Boolean(input.replace_all))
      return { diff: fileDiff(display, file.text, result.content) }
    }
    if (tool === 'write_file') {
      const { path } = resolveWorkPath(cwd, str(input.path))
      const display = shown(cwd, path)
      const before = existsSync(path) ? (readTextFile(path)?.text ?? null) : null
      return { diff: fileDiff(display, before, str(input.content)) }
    }
    if (tool === 'delete_file') {
      const { path } = resolveWorkPath(cwd, str(input.path))
      if (!existsSync(path) || !statSync(path).isFile()) return null
      const before = readTextFile(path)?.text
      return before === undefined ? null : { diff: fileDiff(shown(cwd, path), before, null) }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  return null
}
