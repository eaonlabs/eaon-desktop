/**
 * Copying a project's ignored files (.env, local config) into a new worktree.
 *
 * A worktree is a fresh checkout, so it has none of the files git ignores: the
 * agent in it can't run the app without its .env. These are the rules for
 * which of those files are copied, and the limits that keep this from
 * becoming a copy of node_modules. The plan is made here from the list of
 * ignored files; main reads the list from git and does the copying.
 *
 * Only files git ignores are ever candidates, so nothing a checkout already
 * has is replaced.
 */

/** What the settings hold: whether the New session dialog ticks it, and which files count. */
export interface WorktreeCopySettings {
  /** Ticked by default in the New session dialog (it is always a choice there). */
  enabled: boolean
  /** One pattern per entry; see `patternMatches`. */
  patterns: string[]
}

/** `.env` and its variants, at any depth: the config most projects keep out of git. */
export const DEFAULT_COPY_PATTERNS = ['.env', '.env.*']

export const DEFAULT_COPY_SETTINGS: WorktreeCopySettings = { enabled: false, patterns: DEFAULT_COPY_PATTERNS }

/** A file bigger than this isn't config; it's data or a build, and is left out. */
export const COPY_MAX_FILE_BYTES = 1_000_000
/** The most files, and the most bytes in all, one new worktree gets. */
export const COPY_MAX_FILES = 100
export const COPY_MAX_TOTAL_BYTES = 10_000_000

/** Dependency and build folders: never copied from, however a pattern reads. */
export const NEVER_COPIED = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  'coverage',
  '.gradle',
  'Pods',
  'vendor'
])

export interface CopyCandidate {
  /** Relative to the project, with `/` between the parts. */
  path: string
  size: number
}

export interface CopySkip {
  path: string
  reason: string
}

export interface CopyPlan {
  /** What is to be copied, in path order. */
  copy: CopyCandidate[]
  /** Files that matched a pattern and were left out, and why. */
  skipped: CopySkip[]
}

/** What was done: the files copied (relative paths) and the ones left out or that failed. */
export interface CopyReport {
  copied: string[]
  skipped: CopySkip[]
}

/** Patterns from a settings box: one per line; blank lines and `#` comments dropped. A leading `!` (negation) isn't supported and is dropped. */
export function parsePatterns(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
}

const globSource = (glob: string): string =>
  glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?'
      if (part === '**') return '.*'
      if (part === '*') return '[^/]*'
      if (part === '?') return '[^/]'
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    })
    .join('')

/**
 * Whether `file` (a path relative to the project) is one `pattern` names, as a
 * `.gitignore` line would read it:
 * - `.env*`, no slash: any file or folder of that name, at any depth
 * - `config/*.local.json`, a slash: from the project's root; `**` crosses folders
 * - `secrets/`, a trailing slash: everything inside a folder of that name
 * A folder that matches takes everything under it.
 */
export function patternMatches(pattern: string, file: string): boolean {
  let p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!p) return false
  const parts = file.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length === 0) return false
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/')
  p = p.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!p) return false
  const re = new RegExp(`^${globSource(p)}$`)
  if (!anchored) return parts.some((part) => re.test(part))
  // From the root: the whole path, or the path of any folder above the file.
  for (let n = 1; n <= parts.length; n++) if (re.test(parts.slice(0, n).join('/'))) return true
  return false
}

/** Whether a path goes through a folder that is never copied from. */
export const inNeverCopied = (file: string): boolean => file.split('/').slice(0, -1).some((part) => NEVER_COPIED.has(part))

/**
 * What to copy of the ignored files `candidates`, for `patterns`: the ones a
 * pattern names, less the dependency folders, big files, and whatever is past
 * the file and size limits. Files no pattern names aren't mentioned at all.
 */
export function planCopy(candidates: CopyCandidate[], patterns: string[]): CopyPlan {
  const named = candidates.filter((c) => patterns.some((p) => patternMatches(p, c.path))).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const plan: CopyPlan = { copy: [], skipped: [] }
  let total = 0
  for (const file of named) {
    if (inNeverCopied(file.path)) plan.skipped.push({ path: file.path, reason: 'in a dependency or build folder' })
    else if (file.size > COPY_MAX_FILE_BYTES) plan.skipped.push({ path: file.path, reason: 'over 1 MB' })
    else if (plan.copy.length >= COPY_MAX_FILES) plan.skipped.push({ path: file.path, reason: `more than ${COPY_MAX_FILES} files` })
    else if (total + file.size > COPY_MAX_TOTAL_BYTES) plan.skipped.push({ path: file.path, reason: 'over 10 MB in all' })
    else {
      plan.copy.push(file)
      total += file.size
    }
  }
  return plan
}

/** The settings as stored, made current: anything missing or the wrong shape falls back to the defaults. */
export function cleanCopySettings(raw: unknown): WorktreeCopySettings {
  const v = raw as Partial<WorktreeCopySettings> | null
  const patterns = Array.isArray(v?.patterns)
    ? v.patterns.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean).slice(0, 50)
    : null
  return { enabled: v?.enabled === true, patterns: patterns ?? [...DEFAULT_COPY_PATTERNS] }
}

/** A list of copied files as a sentence for a notice: the first few by name, then how many more. */
export function copiedSummary(files: string[], shown = 4): string {
  if (files.length === 0) return ''
  const names = files.slice(0, shown).join(', ')
  return files.length > shown ? `${names} and ${files.length - shown} more` : names
}
