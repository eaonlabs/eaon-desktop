import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * The project's own instructions for agents, as opencode and Claude Code
 * read them: the nearest AGENTS.md (or CLAUDE.md, or the older CONTEXT.md)
 * between the working folder and the top of its git repository, plus one
 * personal file for every project. They go into the system prompt as the
 * chat's project instructions, so the agent follows the repo's conventions
 * without being told each time.
 */

const NAMES = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md']
const GLOBAL = [join(homedir(), '.config', 'eaon', 'AGENTS.md'), join(homedir(), '.eaon', 'AGENTS.md'), join(homedir(), '.claude', 'CLAUDE.md')]
const MAX_CHARS = 40_000

export interface Instructions {
  /** The files read, nearest first, then the personal one. */
  files: string[]
  text: string
}

/** A folder's git root doesn't change while we run; asking git is a process start, so it is asked once. */
const roots = new Map<string, string | null>()
function gitRoot(cwd: string): string | null {
  if (!roots.has(cwd)) {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 3000 })
    roots.set(cwd, result.status === 0 ? result.stdout.trim() || null : null)
  }
  return roots.get(cwd) ?? null
}

/** Every `name` from `cwd` up to `stop`, nearest first. */
function findUp(name: string, cwd: string, stop: string): string[] {
  const out: string[] = []
  let dir = resolve(cwd)
  for (;;) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) out.push(candidate)
    if (dir === stop) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

const cache = new Map<string, { at: number; value: Instructions }>()

export function loadInstructions(cwd: string): Instructions {
  const cached = cache.get(cwd)
  if (cached && Date.now() - cached.at < 10_000) return cached.value
  const stop = gitRoot(cwd) ?? resolve(cwd)
  const files: string[] = []
  // The first kind of file found wins, so AGENTS.md and CLAUDE.md aren't both stacked.
  for (const name of NAMES) {
    const found = findUp(name, cwd, stop)
    if (found.length) {
      files.push(...found)
      break
    }
  }
  const personal = GLOBAL.find((path) => existsSync(path))
  if (personal && !files.includes(personal)) files.push(personal)
  let text = ''
  for (const file of files) {
    let body = ''
    try {
      body = readFileSync(file, 'utf8').trim()
    } catch {
      continue
    }
    if (!body) continue
    const block = `Instructions from ${file}:\n${body}`
    if (text.length + block.length > MAX_CHARS) break
    text += (text ? '\n\n' : '') + block
  }
  const value = { files, text }
  cache.set(cwd, { at: Date.now(), value })
  return value
}
