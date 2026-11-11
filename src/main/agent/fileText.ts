import { capOutput } from './tools'

/**
 * The text side of Work mode's file tools, with no file system in it: how a
 * snippet is replaced, how a file is shown with line numbers, how a glob or a
 * name query is read, how a command's output is shortened. The tools on this
 * computer (localTools.ts) and the ones over SSH (remoteTools.ts) hand it
 * what they read and show what it returns, so the model sees the same thing
 * from both.
 */

export const MAX_OUTPUT = 16_000
export const DEFAULT_READ_LINES = 300
export const MAX_GREP_MATCHES = 60
export const MAX_LIST_ENTRIES = 200

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

/**
 * Exact-snippet replacement. Refusing on 0 or 2+ occurrences is the whole
 * point — a silent wrong-match edit is far worse than an error the model can
 * recover from by including more context. `replace_all` is the explicit
 * opt-out for renames.
 */
export function applyEdit(content: string, target: string, oldTextIn: string, newTextIn: string, replaceAll: boolean): { next: string; summary: string } {
  if (!oldTextIn) throw new Error('old_text is empty. Use write_file to create a file.')
  // Readings of the snippet, most literal first: as sent; without read_file's
  // line-number prefixes; and in a CRLF file, with its line endings — models
  // always send \n, so no multi-line snippet matched a Windows-style file.
  const readings: [string, string][] = [[oldTextIn, newTextIn]]
  const stripped = stripLineNumbers(oldTextIn)
  if (stripped !== null) readings.push([stripped, stripLineNumbers(newTextIn) ?? newTextIn])
  if (content.includes('\r\n')) {
    const crlf = (text: string): string => text.replace(/\r?\n/g, '\r\n')
    for (const [o, n] of [...readings]) if (o.includes('\n') && !o.includes('\r')) readings.push([crlf(o), crlf(n)])
  }
  const [oldText, found] = readings.find(([o]) => content.includes(o)) ?? readings[0]
  // A file that is CRLF throughout stays so, whatever the new text arrived with.
  const newText = content.includes('\r\n') && !/(^|[^\r])\n/.test(content) ? found.replace(/\r?\n/g, '\r\n') : found
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
  const delta = newText.split('\n').length - oldText.split('\n').length
  return { next, summary: `Edited ${target}${replaceAll && occurrences > 1 ? ` (${occurrences} places)` : ''} (${delta >= 0 ? '+' : ''}${delta} lines).` }
}

/** A file's text for read_file: numbered lines from `startLine`, or why there is nothing to show. */
export function renderRead(buffer: Buffer, size: number, target: string, startLine?: number, endLine?: number): string {
  if (buffer.subarray(0, 8000).includes(0)) return `${target} is a binary file (${size.toLocaleString()} bytes).`
  const lines = buffer.toString('utf8').split('\n')
  // A final newline ends the last line; it does not start another.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 1 && lines[0] === '') return `${target} is empty.`

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
 * grep's `include` as models write it: a glob (`*.ts`, `*.{ts,tsx}`, or
 * with `**` for any depth) or a plain path fragment (`src/`). Treating a glob as a
 * fragment matched nothing and reported "No matches." for code that exists.
 * A glob without a slash matches the file name, as in ripgrep and .gitignore.
 * Listed paths always use `/`, so a Windows-style `src\**\*.ts` is read as one.
 */
export function includeFilter(include: string): (path: string) => boolean {
  const pattern = include.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
  if (!/[*?{]/.test(pattern)) return (path) => path.includes(pattern)
  let source = ''
  let braces = 0
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      i++
      if (pattern[i + 1] === '/') {
        i++
        source += '(?:.*/)?'
      } else source += '.*'
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '{') {
      braces++
      source += '(?:'
    } else if (char === '}' && braces > 0) {
      braces--
      source += ')'
    } else if (char === ',' && braces > 0) source += '|'
    else source += char.replace(/[.+^$()|[\]\\{}]/g, '\\$&')
  }
  let regex: RegExp
  try {
    regex = new RegExp(`^${source}$`)
  } catch {
    return (path) => path.includes(pattern)
  }
  return pattern.includes('/') ? (path) => regex.test(path) : (path) => regex.test(path.slice(path.lastIndexOf('/') + 1))
}

/** Never text, so never worth reading for a grep. */
export const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|icns|bmp|tiff?|heic|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|o|a|so|dylib|dll|exe|bin|wasm|woff2?|ttf|otf|eot|mp[34]|m4a|mov|avi|mkv|wav|flac|ogg|webm|sqlite3?|db|pyc|node)$/i

/** The best twenty paths for a find_file query: the name itself, then a name that has it, then a folder that does. */
export function rankFiles(paths: string[], query: string): string[] {
  const needle = query.toLowerCase()
  return paths
    .map((path) => {
      const lower = path.toLowerCase()
      const base = lower.slice(lower.lastIndexOf('/') + 1)
      const score = base === needle ? 3 : base.includes(needle) ? 2 : lower.includes(needle) ? 1 : 0
      return { path, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, 20)
    .map((entry) => entry.path)
}

/** One list_dir row: a folder with its slash, a file with its size. */
export function listRow(name: string, directory: boolean, bytes: number | null): string {
  if (name === '.git' || name === 'node_modules') return `${name}/  (skipped)`
  if (directory) return `${name}/`
  if (bytes === null) return name
  return `${name} ${bytes < 1024 ? `${bytes}B` : bytes < 1_048_576 ? `${Math.round(bytes / 1024)}KB` : `${(bytes / 1_048_576).toFixed(1)}MB`}`
}

/**
 * A command's output as its first and last `limit` characters, with a count
 * of what lies between. A chatty build can print hundreds of megabytes; the
 * first error and the summary are at the two ends.
 */
export class HeadAndTail {
  private head = ''
  private tail = ''
  private total = 0
  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    this.total += chunk.length
    if (this.head.length < this.limit) {
      const room = this.limit - this.head.length
      this.head += chunk.slice(0, room)
      chunk = chunk.slice(room)
    }
    if (!chunk) return
    this.tail += chunk
    if (this.tail.length > 2 * this.limit) this.tail = this.tail.slice(-this.limit)
  }

  /** The newest `n` characters, for live progress. */
  recent(n: number): string {
    return (this.tail.length >= n ? this.tail : this.head + this.tail).slice(-n)
  }

  text(): string {
    if (this.head.length + this.tail.length === this.total) return capOutput((this.head + this.tail).trim(), this.limit)
    const head = Math.floor(this.limit * 0.7)
    const tail = this.limit - head
    return `${this.head.slice(0, head).trimStart()}\n\n…[${(this.total - head - tail).toLocaleString()} characters omitted]…\n\n${this.tail.slice(-tail).trimEnd()}`
  }
}
