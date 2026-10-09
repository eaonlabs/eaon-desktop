import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { app } from 'electron'
import type { IndexStatus, SearchHit } from '@shared/types'
import { dot, embedAll, embedQuery, getEmbeddingConfig, isEmbeddingConfigured } from './embeddings'

/**
 * Local codebase index — the thing that lets Eaon Work answer "where is the
 * auth flow?" instead of grepping blindly.
 *
 * Deliberately different from Cursor's design in one way that matters: Cursor
 * embeds locally then ships vectors to a remote store (Turbopuffer) keyed by
 * obfuscated paths. Eaon keeps the entire index on disk in the user's own
 * data directory, because this is a BYOK app whose whole premise is that
 * nothing leaves the machine except calls to the provider you chose. Only the
 * chunk text of *changed* files is ever sent anywhere, and only to the
 * embedding provider the user picked.
 *
 * Shared with Cursor: per-file content hashing so a re-index only touches what
 * actually changed, syntax-aware chunking rather than fixed-size windows, and
 * retrieving code from local disk at query time.
 *
 * Vectors live in a sidecar `.bin` (raw Float32) rather than the JSON manifest
 * — 30k chunks at 1536 dims is ~180 MB, which JSON/base64 handles badly.
 */

/* ------------------------------------------------------------------ layout */

const indexDir = (): string => {
  const dir = join(app.getPath('userData'), 'code-index')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const keyFor = (cwd: string): string => createHash('sha256').update(cwd).digest('hex').slice(0, 16)
const manifestPath = (cwd: string): string => join(indexDir(), `${keyFor(cwd)}.json`)
const vectorPath = (cwd: string): string => join(indexDir(), `${keyFor(cwd)}.bin`)

/* ------------------------------------------------------------------ tuning */

/** Files bigger than this are skipped — minified bundles poison an index. */
const MAX_FILE_BYTES = 512 * 1024
const MAX_CHUNK_LINES = 90
const MIN_CHUNK_LINES = 8
/** Lines repeated at a split point so a symbol cut in half is still findable. */
const CHUNK_OVERLAP_LINES = 6
/** Safety rail on very large monorepos; the UI reports when this trips. */
const MAX_CHUNKS = 50_000
/** Code files the index looks at, nearest the top first; reported as truncated like the chunk ceiling. */
const MAX_INDEX_FILES = 20_000
/**
 * Directory entries a walk reads before it stops. A home folder full of
 * photos and music has few code files, so the file cap alone would let a walk
 * read millions of entries before it tripped.
 */
const MAX_WALK_ENTRIES = 200_000

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts',
  '.swift', '.m', '.mm', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.scala', '.sh', '.bash',
  '.zsh', '.sql', '.html', '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.astro', '.json',
  '.yaml', '.yml', '.toml', '.md', '.mdx', '.txt', '.graphql', '.gql', '.proto', '.tf', '.lua', '.dart',
  '.ex', '.exs', '.erl', '.hs', '.clj', '.r', '.pl', '.gradle', '.cmake', '.dockerfile'
])

/** Always skipped, even when .gitignore does not mention them. */
const ALWAYS_IGNORE = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', 'target', '.next', '.nuxt',
  'venv', '.venv', '__pycache__', '.mypy_cache', '.pytest_cache', 'coverage', '.gradle',
  'Pods', 'DerivedData', '.idea', '.vscode-test', 'vendor', '.turbo', '.parcel-cache', '.cache'
])

const IGNORED_FILENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock',
  'composer.lock', 'Gemfile.lock', 'poetry.lock', '.DS_Store'
])

/**
 * Operating-system folders that hold nobody's project and can hold millions
 * of files, reached when a home folder or a drive is opened as the project.
 * Only names hardly any project gives a folder of its own: `System` or `dev`
 * would be skipped inside real projects too.
 */
const SYSTEM_FOLDERS = new Set([
  'Library', 'AppData', 'Program Files', 'Program Files (x86)', 'ProgramData',
  '$Recycle.Bin', 'System Volume Information'
])

/* ------------------------------------------------------------------- types */

interface Chunk {
  path: string
  startLine: number
  endLine: number
  /** Declaration names found in this chunk; drives symbol lookup and lexical scoring. */
  symbols: string[]
  text: string
}

interface IndexedFile {
  path: string
  hash: string
  size: number
  /**
   * With `size`, lets a rebuild skip reading a file whose size and mtime are
   * unchanged, the check git and make rely on. Absent in manifests from
   * before it was kept; those files are read and hashed once more.
   */
  mtimeMs?: number
  /** Position of this file's chunks inside the flat `chunks` array. */
  chunkStart: number
  chunkCount: number
}

interface Manifest {
  version: 2
  cwd: string
  /** Root hash over every file hash — an instant "did anything change?" check. */
  rootHash: string
  /** Set when chunks were embedded; a change here forces a full re-embed. */
  embeddingModel: string | null
  dimensions: number
  files: IndexedFile[]
  chunks: Chunk[]
  updatedAt: number
  truncated: boolean
}

/* ------------------------------------------------------------- gitignore */

interface IgnoreRule {
  /** Regex matched against the repo-relative POSIX path. */
  regex: RegExp
  negated: boolean
  directoryOnly: boolean
}

/**
 * Enough of the gitignore spec to be genuinely useful: comments, negation,
 * directory-only rules, anchored vs floating patterns, `*`, `?` and `**`.
 */
function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of content.split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const negated = line.startsWith('!')
    if (negated) line = line.slice(1)

    const directoryOnly = line.endsWith('/')
    if (directoryOnly) line = line.slice(0, -1)
    if (!line) continue

    // A slash anywhere but the end anchors the pattern to the repo root.
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)

    let source = ''
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '*') {
        if (line[i + 1] === '*') {
          source += '.*'
          i++
          if (line[i + 1] === '/') i++
        } else {
          source += '[^/]*'
        }
      } else if (char === '?') source += '[^/]'
      else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }

    rules.push({
      regex: new RegExp(anchored ? `^${source}(/.*)?$` : `(^|.*/)${source}(/.*)?$`),
      negated,
      directoryOnly
    })
  }
  return rules
}

/** Last matching rule wins, which is how git resolves negation. */
function isIgnored(relPath: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue
    if (rule.regex.test(relPath)) ignored = !rule.negated
  }
  return ignored
}

/* ---------------------------------------------------------------- chunking */

/**
 * Lines that plausibly begin a new top-level construct. Without tree-sitter
 * (a native module, and a rebuild burden for every Electron bump) this
 * regex-per-language-family pass is the pragmatic substitute: it finds the
 * boundaries that matter for chunk quality — function, class, type and block
 * openings — across the languages people actually point this at.
 */
const DECLARATION_RE = new RegExp(
  [
    // JS/TS: function, class, interface, type, enum, exported const arrow fns
    String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|declare)\s+(\w+)`,
    String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>`,
    // Python / Ruby
    String.raw`^\s*(?:async\s+)?def\s+(\w+)`,
    String.raw`^\s*(?:class|module)\s+(\w+)`,
    // Go / Rust
    String.raw`^\s*func\s+(?:\([^)]*\)\s*)?(\w+)`,
    String.raw`^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)`,
    String.raw`^\s*(?:pub\s+)?(?:struct|trait|impl|mod)\s+(\w+)`,
    // JVM / C-family / C#
    String.raw`^\s*(?:public|private|protected|internal|static|final|abstract|override|open|suspend|\s)*(?:class|interface|struct|enum|record|object|fun|void|def)\s+(\w+)`,
    // Swift
    String.raw`^\s*(?:@\w+\s+)*(?:public|private|internal|open|fileprivate|\s)*(?:func|class|struct|enum|protocol|extension)\s+(\w+)`,
    // Markdown headings, so docs chunk on sections
    String.raw`^(#{1,3})\s+(.+)$`
  ].join('|')
)

function symbolAt(line: string): string | null {
  const match = line.match(DECLARATION_RE)
  if (!match) return null
  // The alternation means exactly one capture group is populated; take it.
  for (let i = 1; i < match.length; i++) {
    const value = match[i]
    if (value && value !== '#' && !/^#+$/.test(value)) return value.trim()
  }
  return null
}

/**
 * Split a file at declaration boundaries, then even out the result: merge
 * runs shorter than MIN_CHUNK_LINES, and hard-split anything longer than
 * MAX_CHUNK_LINES with an overlap so a symbol straddling the cut is still
 * reachable from both sides.
 */
export function chunkFile(path: string, content: string): Chunk[] {
  const lines = content.split('\n')
  if (lines.length === 0) return []

  // 1. Boundary pass.
  const starts: number[] = [0]
  const symbolByLine = new Map<number, string>()
  for (let i = 0; i < lines.length; i++) {
    const symbol = symbolAt(lines[i])
    if (symbol) {
      symbolByLine.set(i, symbol)
      if (i > 0) starts.push(i)
    }
  }

  // 2. Merge boundaries that are too close together.
  const merged: number[] = []
  for (const start of starts) {
    if (merged.length === 0 || start - merged[merged.length - 1] >= MIN_CHUNK_LINES) merged.push(start)
  }

  // 3. Emit, hard-splitting anything oversized.
  const chunks: Chunk[] = []
  for (let i = 0; i < merged.length; i++) {
    const from = merged[i]
    const to = i + 1 < merged.length ? merged[i + 1] : lines.length
    for (let start = from; start < to; start += MAX_CHUNK_LINES) {
      const end = Math.min(start + MAX_CHUNK_LINES, to)
      // Reach back a few lines on continuation slices only.
      const withOverlap = start === from ? start : Math.max(from, start - CHUNK_OVERLAP_LINES)
      const text = lines.slice(withOverlap, end).join('\n')
      if (!text.trim()) continue

      const symbols: string[] = []
      for (let line = withOverlap; line < end; line++) {
        const symbol = symbolByLine.get(line)
        if (symbol) symbols.push(symbol)
      }

      chunks.push({
        path,
        startLine: withOverlap + 1,
        endLine: end,
        symbols,
        text
      })
    }
  }
  return chunks
}

/** What actually gets embedded — the path and symbols give the model anchors. */
function embeddingText(chunk: Chunk): string {
  const header = chunk.symbols.length > 0 ? `${chunk.path} — ${chunk.symbols.join(', ')}` : chunk.path
  return `${header}\n\n${chunk.text}`
}

/* ------------------------------------------------------------------- walk */

async function ignoreRules(cwd: string): Promise<IgnoreRule[]> {
  try {
    return parseGitignore(await readFile(join(cwd, '.gitignore'), 'utf8'))
  } catch {
    return [] // no .gitignore is normal
  }
}

/** Names no walk descends into or lists, whatever .gitignore says. */
const skippedName = (name: string): boolean =>
  (name.startsWith('.') && name !== '.github') || ALWAYS_IGNORE.has(name) || IGNORED_FILENAMES.has(name) || SYSTEM_FOLDERS.has(name)

/**
 * The files under `cwd` that `accept` takes, by the ignore rules both the
 * index and search use. Breadth-first and capped, so a huge folder (a home
 * folder, say) still ends quickly, with the files nearest the top.
 */
async function walkFiles(cwd: string, limit: number, accept: (name: string) => boolean): Promise<{ paths: string[]; truncated: boolean }> {
  const rules = await ignoreRules(cwd)
  const paths: string[] = []
  const queue: string[] = [cwd]
  let seen = 0
  for (let next = 0; next < queue.length; next++) {
    if (seen >= MAX_WALK_ENTRIES) return { paths, truncated: true }
    let entries
    try {
      entries = await readdir(queue[next], { withFileTypes: true })
    } catch {
      continue // unreadable directory (permissions, races) — skip it
    }
    seen += entries.length
    for (const entry of entries) {
      if (skippedName(entry.name)) continue
      const full = join(queue[next], entry.name)
      const rel = relative(cwd, full).split(sep).join('/')
      if (isIgnored(rel, entry.isDirectory(), rules)) continue
      if (entry.isDirectory()) queue.push(full)
      else if (entry.isFile() && accept(entry.name)) {
        if (paths.length >= limit) return { paths, truncated: true }
        paths.push(rel)
      }
    }
  }
  return { paths, truncated: false }
}

/** The code files the index covers, sorted, so the root hash does not depend on directory order. */
async function walk(cwd: string): Promise<{ paths: string[]; truncated: boolean }> {
  const found = await walkFiles(cwd, MAX_INDEX_FILES, (name) => CODE_EXTENSIONS.has(extname(name).toLowerCase()))
  return { paths: found.paths.sort(), truncated: found.truncated }
}

/**
 * Every file a search of the project should look at: the index's ignore
 * rules, without its extension and size filters, read fresh from disk. The
 * index is rebuilt rarely, so searching only what it lists hid every file
 * created since — including the agent's own — and every Makefile, .xml or
 * .plist.
 */
export function listProjectFiles(cwd: string, limit: number): Promise<{ paths: string[]; truncated: boolean }> {
  return walkFiles(cwd, limit, () => true)
}

/* --------------------------------------------------------------- persistence */

/**
 * The last manifest and vectors read, reused while their files are unchanged.
 * The manifest holds the text of every chunk (tens of MB on a big repo) and
 * is consulted on every agent turn — whether the search tools are offered —
 * and by every search; parsing it each time blocked the main process for
 * ~100 ms a turn. One entry each: only the open Work folder is hot.
 */
let manifestCache: { cwd: string; mtimeMs: number; size: number; manifest: Manifest | null } | null = null
let vectorCache: { cwd: string; mtimeMs: number; size: number; dimensions: number; vectors: Float32Array[] } | null = null

function loadManifest(cwd: string): Manifest | null {
  try {
    const file = manifestPath(cwd)
    if (!existsSync(file)) return null
    const info = statSync(file)
    if (manifestCache && manifestCache.cwd === cwd && manifestCache.mtimeMs === info.mtimeMs && manifestCache.size === info.size) {
      return manifestCache.manifest
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Manifest
    const manifest = parsed.version === 2 && parsed.cwd === cwd ? parsed : null
    manifestCache = { cwd, mtimeMs: info.mtimeMs, size: info.size, manifest }
    return manifest
  } catch {
    return null
  }
}

function loadVectors(cwd: string, count: number, dimensions: number): Float32Array[] | null {
  try {
    const file = vectorPath(cwd)
    if (!existsSync(file) || dimensions === 0) return null
    const info = statSync(file)
    if (info.size !== count * dimensions * 4) return null
    const cached = vectorCache
    if (cached && cached.cwd === cwd && cached.mtimeMs === info.mtimeMs && cached.size === info.size && cached.dimensions === dimensions) {
      return cached.vectors
    }
    const buffer = readFileSync(file)
    if (buffer.byteLength !== count * dimensions * 4) return null
    const all = new Float32Array(buffer.buffer, buffer.byteOffset, count * dimensions)
    const vectors: Float32Array[] = []
    for (let i = 0; i < count; i++) vectors.push(all.subarray(i * dimensions, (i + 1) * dimensions))
    vectorCache = { cwd, mtimeMs: info.mtimeMs, size: info.size, dimensions, vectors }
    return vectors
  } catch {
    return null
  }
}

/** Every write goes through here too, so a rewrite within the same millisecond is never served stale. */
function forgetCached(): void {
  manifestCache = null
  vectorCache = null
}

/**
 * Writes a build's manifest and vectors without blocking the main process —
 * on a big repo they are tens and hundreds of MB — into temporary files, then
 * swaps both in within one tick, so a search never reads half a manifest or
 * pairs a new manifest with the old vectors. `keep` leaves the vectors as
 * they are; null removes them. A build cancelled while writing swaps nothing.
 */
async function saveIndex(cwd: string, manifest: Manifest, vectors: Float32Array[] | null | 'keep', signal: AbortSignal): Promise<void> {
  const suffix = `.${randomBytes(4).toString('hex')}.tmp`
  const manifestTemp = manifestPath(cwd) + suffix
  const vectorTemp = vectorPath(cwd) + suffix
  try {
    await writeFile(manifestTemp, JSON.stringify(manifest))
    if (Array.isArray(vectors)) {
      const flat = new Float32Array(vectors.length * manifest.dimensions)
      vectors.forEach((vector, i) => flat.set(vector, i * manifest.dimensions))
      await writeFile(vectorTemp, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength))
    }
    if (signal.aborted) throw new Error('Indexing cancelled')
    renameSync(manifestTemp, manifestPath(cwd))
    if (Array.isArray(vectors)) renameSync(vectorTemp, vectorPath(cwd))
    else if (vectors === null && existsSync(vectorPath(cwd))) unlinkSync(vectorPath(cwd))
    forgetCached()
  } finally {
    // Only still there when the swap did not happen.
    await Promise.all([rm(manifestTemp, { force: true }), rm(vectorTemp, { force: true })]).catch(() => {})
  }
}

/* -------------------------------------------------------------- public API */

let currentRun: AbortController | null = null
let statusListener: ((status: IndexStatus) => void) | null = null
let lastStatus: IndexStatus = { state: 'idle', files: 0, chunks: 0, embedded: false }

export function setIndexStatusListener(listener: (status: IndexStatus) => void): void {
  statusListener = listener
}

function publish(status: IndexStatus): void {
  lastStatus = status
  statusListener?.(status)
}

/** Status derived purely from what is on disk, ignoring any in-flight run. */
function statusFromDisk(cwd: string | null): IndexStatus {
  if (!cwd) return { state: 'idle', files: 0, chunks: 0, embedded: false }
  const manifest = loadManifest(cwd)
  if (!manifest) return { state: 'idle', files: 0, chunks: 0, embedded: false }
  return {
    state: 'ready',
    files: manifest.files.length,
    chunks: manifest.chunks.length,
    embedded: manifest.embeddingModel !== null,
    updatedAt: manifest.updatedAt,
    truncated: manifest.truncated
  }
}

export function getIndexStatus(cwd: string | null): IndexStatus {
  // A live run is the more truthful answer for a *query*, but callers that have
  // just finished a run must use statusFromDisk directly — otherwise they read
  // back the "indexing" status they themselves published a moment ago.
  if (lastStatus.state === 'indexing') return lastStatus
  return statusFromDisk(cwd)
}

export function cancelIndexing(): void {
  currentRun?.abort()
  currentRun = null
}

export function clearIndex(cwd: string): void {
  forgetCached()
  for (const file of [manifestPath(cwd), vectorPath(cwd)]) {
    try {
      if (existsSync(file)) unlinkSync(file)
    } catch {
      /* best effort */
    }
  }
  publish({ state: 'idle', files: 0, chunks: 0, embedded: false })
}

/** The build under way, which a request for the same folder joins instead of restarting. */
let currentBuild: { cwd: string; force: boolean; run: AbortController; done: Promise<IndexStatus> } | null = null

/**
 * Build or refresh the index. Unchanged files keep their existing chunks and
 * vectors; only new or modified files are re-chunked and re-embedded — the
 * same incremental idea as Cursor's Merkle diff, done against a flat file-hash
 * map since there is no remote side to negotiate with.
 *
 * Every window asks for a build of its folder when it opens. One asking for
 * the folder already being built waits for that build: cancelling it and
 * starting over meant a second window threw away the first one's work. A
 * build of another folder, or a forced rebuild, still replaces it.
 */
export function buildIndex(cwd: string, force = false): Promise<IndexStatus> {
  const under = currentBuild
  if (under && under.run === currentRun && under.cwd === cwd && (under.force || !force)) return under.done
  cancelIndexing()
  const run = new AbortController()
  currentRun = run
  const done = runBuild(cwd, force, run)
  currentBuild = { cwd, force, run, done }
  return done
}

async function runBuild(cwd: string, force: boolean, run: AbortController): Promise<IndexStatus> {
  try {
    publish({ state: 'indexing', files: 0, chunks: 0, embedded: false, phase: 'Scanning files' })

    const walked = await walk(cwd)
    const previous = force ? null : loadManifest(cwd)
    const embeddingConfig = isEmbeddingConfigured() ? getEmbeddingConfig() : null
    const modelChanged = previous?.embeddingModel !== (embeddingConfig?.modelId ?? null)

    // Looked up once per file below; a linear search here made a rebuild quadratic in the file count.
    const previousFile = new Map(previous && !modelChanged ? previous.files.map((f) => [f.path, f] as const) : [])
    const previousChunks = previous && !modelChanged ? previous.chunks : []

    publish({ state: 'indexing', files: walked.paths.length, chunks: 0, embedded: false, phase: 'Reading files' })

    // One pass. A file whose size and mtime are unchanged keeps its hash and chunks without being
    // read; any other is read, hashed, and chunked if its content changed. Only chunks are kept, and
    // only up to the ceiling: holding the text of every file until the end could run a first build
    // of a big folder out of memory.
    const files: IndexedFile[] = []
    const chunks: Chunk[] = []
    /** Where each chunk sat in the previous build, so its vector carries over; null for a new one. */
    const carriedFrom: (number | null)[] = []
    let truncated = walked.truncated
    /** A file had to be read: new, changed, or from a manifest that has no mtimes yet. */
    let reread = false

    for (const path of walked.paths) {
      if (run.signal.aborted) throw new Error('Indexing cancelled')
      if (chunks.length >= MAX_CHUNKS) {
        truncated = true
        break
      }
      try {
        const info = await stat(join(cwd, path))
        if (info.size > MAX_FILE_BYTES) continue
        const before = previousFile.get(path)
        let hash: string
        let fresh: Chunk[] | null = null
        if (before && before.size === info.size && before.mtimeMs === info.mtimeMs) {
          hash = before.hash
        } else {
          const content = await readFile(join(cwd, path), 'utf8')
          // A NUL byte means this is really binary despite the extension.
          if (content.includes('\u0000')) continue
          // Only a file that is kept counts: a binary one is never recorded, and must not force a rewrite every time.
          reread = true
          hash = createHash('sha256').update(content).digest('hex')
          if (before?.hash !== hash) fresh = chunkFile(path, content)
        }
        const reused = !fresh && before ? before : null
        const fileChunks = reused ? previousChunks.slice(reused.chunkStart, reused.chunkStart + reused.chunkCount) : (fresh ?? [])
        files.push({ path, hash, size: info.size, mtimeMs: info.mtimeMs, chunkStart: chunks.length, chunkCount: fileChunks.length })
        chunks.push(...fileChunks)
        for (let i = 0; i < fileChunks.length; i++) carriedFrom.push(reused ? reused.chunkStart + i : null)
      } catch {
        continue
      }
    }

    if (run.signal.aborted) throw new Error('Indexing cancelled')
    const rootHash = createHash('sha256')
      .update(files.map(({ path, hash }) => `${path}:${hash}`).join('\n'))
      .digest('hex')

    if (previous && previous.rootHash === rootHash && previous.truncated === truncated && !modelChanged) {
      // Nothing changed. Files read only for want of a recorded mtime (an older manifest, or a
      // checkout that touched them) get it recorded, so the next launch need not read them again;
      // the chunks and vectors are the previous build's, as they were.
      if (reread) await saveIndex(cwd, { ...previous, files }, 'keep', run.signal)
      if (currentRun === run) currentRun = null
      const status = statusFromDisk(cwd)
      publish(status)
      return status
    }

    const previousVectors =
      previous && !modelChanged && previous.embeddingModel
        ? loadVectors(cwd, previous.chunks.length, previous.dimensions)
        : null
    /** Vector carried over from the previous build, or null if it must be embedded. */
    const carried: (Float32Array | null)[] = carriedFrom.map((from) => (from !== null && previousVectors ? (previousVectors[from] ?? null) : null))

    // Embed only what has no carried-over vector.
    let dimensions = previous?.dimensions ?? 0
    let finalVectors: Float32Array[] | null = null
    /** Set when embedding failed but the lexical index was still written. */
    let embeddingError: string | null = null

    if (embeddingConfig) {
      const pending: number[] = []
      carried.forEach((vector, i) => {
        if (!vector) pending.push(i)
      })

      if (pending.length > 0) {
        publish({
          state: 'indexing',
          files: files.length,
          chunks: chunks.length,
          embedded: false,
          phase: `Embedding 0/${pending.length}`
        })
        try {
          const fresh = await embedAll(
            pending.map((i) => embeddingText(chunks[i])),
            (done, total) =>
              publish({
                state: 'indexing',
                files: files.length,
                chunks: chunks.length,
                embedded: false,
                phase: `Embedding ${done}/${total}`
              }),
            run.signal
          )
          fresh.forEach((vector, i) => (carried[pending[i]] = vector))
          dimensions = fresh[0]?.length ?? dimensions
        } catch (error) {
          // A dead embedding provider (Ollama not running, expired key, rate
          // limit) must not cost the user their whole index. Keep the chunks
          // and fall back to keyword search, which still works — losing the
          // index entirely would be a far worse outcome than losing vectors.
          if (run.signal.aborted) throw error
          embeddingError = error instanceof Error ? error.message : String(error)
        }
      }

      if (carried.every((vector) => vector !== null) && dimensions > 0) {
        finalVectors = carried as Float32Array[]
      }
    }
    // Superseded or cancelled while embedding: the newer build owns the files.
    if (run.signal.aborted) throw new Error('Indexing cancelled')

    const manifest: Manifest = {
      version: 2,
      cwd,
      rootHash,
      embeddingModel: finalVectors ? (embeddingConfig?.modelId ?? null) : null,
      dimensions: finalVectors ? dimensions : 0,
      files,
      chunks,
      updatedAt: Date.now(),
      truncated
    }

    await saveIndex(cwd, manifest, finalVectors, run.signal)

    if (currentRun === run) currentRun = null
    const status: IndexStatus = {
      state: 'ready',
      files: files.length,
      chunks: chunks.length,
      embedded: finalVectors !== null,
      updatedAt: manifest.updatedAt,
      truncated,
      // Reported alongside a usable (keyword-only) index rather than as a
      // failure, so the user knows why search is not semantic.
      ...(embeddingError ? { error: `Keyword search only — embedding failed: ${embeddingError}` } : {})
    }
    publish(status)
    return status
  } catch (error) {
    // A newer build has started: it owns `currentRun` and the status line, so
    // this one bows out without clearing the one or overwriting the other.
    if (currentRun !== run && currentRun !== null) return lastStatus
    currentRun = null
    const message = error instanceof Error ? error.message : String(error)
    const status: IndexStatus = {
      state: message === 'Indexing cancelled' ? 'idle' : 'error',
      files: 0,
      chunks: 0,
      embedded: false,
      error: message === 'Indexing cancelled' ? undefined : message
    }
    publish(status)
    return status
  }
}

/* ------------------------------------------------------------------ search */

const STOPWORDS = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from', 'where', 'what', 'how', 'does', 'you', 'are'])

function queryTerms(query: string): string[] {
  // Split camelCase and snake_case too, so "getUserById" matches "get user id".
  const raw = query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
  return [...new Set(raw)]
}

/**
 * Keyword scoring used on its own when no embedding model is configured, and
 * fused with vector results when one is. Symbol and path hits weigh heaviest
 * because in code they are the strongest signal of what a chunk is *about*.
 */
function lexicalScores(chunks: Chunk[], query: string): Map<number, number> {
  const terms = queryTerms(query)
  const scores = new Map<number, number>()
  if (terms.length === 0) return scores

  chunks.forEach((chunk, i) => {
    const symbolText = chunk.symbols.join(' ').toLowerCase()
    const pathText = chunk.path.toLowerCase()
    const bodyText = chunk.text.toLowerCase()

    let score = 0
    for (const term of terms) {
      if (symbolText.includes(term)) score += 6
      if (pathText.includes(term)) score += 3
      const occurrences = bodyText.split(term).length - 1
      if (occurrences > 0) score += Math.min(3, 1 + Math.log2(occurrences))
    }
    if (score > 0) scores.set(i, score)
  })
  return scores
}

/** Reciprocal-rank fusion — the standard way to merge two ranked lists. */
function fuse(vectorRanked: number[], lexicalRanked: number[], k = 60): Map<number, number> {
  const fused = new Map<number, number>()
  const add = (list: number[], weight: number): void => {
    list.forEach((chunkIndex, rank) => {
      fused.set(chunkIndex, (fused.get(chunkIndex) ?? 0) + weight / (k + rank + 1))
    })
  }
  add(vectorRanked, 1)
  add(lexicalRanked, 1)
  return fused
}

export async function searchIndex(cwd: string, query: string, limit = 12, signal?: AbortSignal): Promise<SearchHit[]> {
  const manifest = loadManifest(cwd)
  if (!manifest || manifest.chunks.length === 0) {
    throw new Error('This project has not been indexed yet. Ask the user to run indexing, or use grep instead.')
  }

  const lexical = lexicalScores(manifest.chunks, query)
  const lexicalRanked = [...lexical.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([i]) => i)

  let vectorRanked: number[] = []
  if (manifest.embeddingModel && isEmbeddingConfigured()) {
    const vectors = loadVectors(cwd, manifest.chunks.length, manifest.dimensions)
    if (vectors) {
      const queryVector = await embedQuery(query, signal)
      const scored = vectors.map((vector, i) => [i, dot(queryVector, vector)] as const)
      vectorRanked = scored
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([i]) => i)
    }
  }

  const ordered =
    vectorRanked.length > 0
      ? [...fuse(vectorRanked, lexicalRanked).entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i)
      : lexicalRanked

  return ordered.slice(0, limit).map((i) => {
    const chunk = manifest.chunks[i]
    return {
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      symbols: chunk.symbols,
      text: chunk.text
    }
  })
}

/** Every indexed path — backs the `find_file` tool without a second disk walk. */
export function indexedPaths(cwd: string): string[] {
  return loadManifest(cwd)?.files.map((file) => file.path) ?? []
}

/** Chunks whose declarations include `name`, for jump-to-definition lookups. */
export function findSymbol(cwd: string, name: string, limit = 10): SearchHit[] {
  const manifest = loadManifest(cwd)
  if (!manifest) return []
  const needle = name.toLowerCase()
  const exact: SearchHit[] = []
  const partial: SearchHit[] = []

  for (const chunk of manifest.chunks) {
    for (const symbol of chunk.symbols) {
      const lower = symbol.toLowerCase()
      const hit: SearchHit = {
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        symbols: chunk.symbols,
        text: chunk.text
      }
      if (lower === needle) {
        exact.push(hit)
        break
      }
      if (lower.includes(needle)) {
        partial.push(hit)
        break
      }
    }
    if (exact.length >= limit) break
  }
  return [...exact, ...partial].slice(0, limit)
}
