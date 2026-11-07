import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { composeRules, cursorRule, withRules, type ProjectRules, type RuleSource } from '@shared/projectRules'
import type { StreamRequest } from '@shared/types'
import type { Runner } from '../ade/runner'

/**
 * Finds a project's rules files (shared/projectRules.ts) on disk.
 *
 * AGENTS.md comes first, then CLAUDE.md, GEMINI.md and CONTEXT.md, whichever
 * kind is found first, from the project's folder up to the top of its git
 * repository (a repository's rules apply to a folder inside it), nearest
 * first, so a repo that keeps CLAUDE.md as a copy of AGENTS.md isn't read
 * twice. The files other tools keep their rules in are read after them, from
 * the project's folder and the repository's top: .cursorrules, Cursor's
 * rules folder, .windsurfrules, .clinerules, Copilot's instructions and
 * Junie's guidelines. Read fresh on every turn, so an edit applies at once.
 */

const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'CONTEXT.md']
const OTHER_FILES = ['.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md', '.junie/guidelines.md']
/** Folders of rules, and the extensions read in each. */
const RULE_FOLDERS: { folder: string; ext: RegExp; cursor: boolean }[] = [
  { folder: '.cursor/rules', ext: /\.(mdc|md)$/i, cursor: true },
  { folder: '.clinerules', ext: /\.(md|txt)$/i, cursor: false }
]
/** A rules file bigger than this (200 KB) isn't one: nothing is read of it. */
const MAX_BYTES = 200_000
/** At most this many files from one rules folder. */
const MAX_IN_FOLDER = 30

/** The text of a regular file of a sensible size; null when it isn't one or can't be read. */
async function readRules(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size > MAX_BYTES) return null
  const text = await readFile(path, 'utf8').catch(() => null)
  return text !== null && !text.slice(0, 4000).includes('\0') ? text : null
}

/** The repository's top folder for `cwd`; null outside git. */
async function gitTop(run: Runner, cwd: string): Promise<string | null> {
  const res = await run(cwd, 'git', ['rev-parse', '--show-toplevel'], 5000)
  return res.ok ? res.stdout.trim() || null : null
}

/** How `cwd` names a file: relative, with forward slashes, so it reads the same everywhere. */
const nameFrom = (cwd: string, path: string): string => relative(cwd, path).split(sep).join('/')

export async function loadProjectRules(run: Runner, folder: string): Promise<ProjectRules> {
  // Symlinks resolved, as git reports the repository's top.
  const cwd = await realpath(resolve(folder)).catch(() => resolve(folder))
  const top = await gitTop(run, cwd)
  // A folder outside the repository (a symlink) is no part of it: only its own files.
  const stop = top && relative(top, cwd) !== '' && !relative(top, cwd).startsWith('..') ? resolve(top) : cwd
  const dirs = [...new Set([cwd, stop])]
  const sources: RuleSource[] = []
  const skipped: ProjectRules['skipped'] = []

  for (const name of AGENT_FILES) {
    const found: string[] = []
    for (let dir = cwd; ; dir = dirname(dir)) {
      if ((await stat(join(dir, name)).catch(() => null))?.isFile()) found.push(join(dir, name))
      if (dir === stop || dirname(dir) === dir) break
    }
    if (found.length === 0) continue
    for (const path of found) {
      const body = await readRules(path)
      if (body !== null) sources.push({ path, name: nameFrom(cwd, path), body })
    }
    if (sources.length > 0) break
  }

  for (const dir of dirs) {
    for (const rel of OTHER_FILES) {
      const path = join(dir, rel)
      const body = await readRules(path)
      if (body !== null) sources.push({ path, name: nameFrom(cwd, path), body })
    }
    for (const { folder: sub, ext, cursor } of RULE_FOLDERS) {
      const entries = await readdir(join(dir, sub), { withFileTypes: true }).catch(() => [])
      const names = entries
        .filter((e) => e.isFile() && ext.test(e.name))
        .map((e) => e.name)
        .sort()
        .slice(0, MAX_IN_FOLDER)
      for (const entry of names) {
        const path = join(dir, sub, entry)
        const raw = await readRules(path)
        if (raw === null) continue
        const name = nameFrom(cwd, path)
        if (!cursor) {
          sources.push({ path, name, body: raw })
          continue
        }
        const rule = cursorRule(raw)
        if (rule.applies) sources.push({ path, name, body: rule.body })
        else skipped.push({ name, path, reason: rule.reason })
      }
    }
  }
  return composeRules(sources, skipped)
}

/**
 * A Chat turn's instructions with the project's rules files added after the
 * ones typed into the project. Only a project chat on Eaon's own loop gets
 * them: an engine (Codex) reads AGENTS.md itself, and a worker's or the local
 * server's request has no project.
 */
export async function withProjectRules(
  run: Runner,
  request: Pick<StreamRequest, 'cwd' | 'engine' | 'rawSystem' | 'workerId' | 'projectInstructions'>
): Promise<string> {
  const typed = request.projectInstructions ?? ''
  if (!request.cwd || request.engine || request.rawSystem !== undefined || request.workerId) return typed
  try {
    return withRules(typed, await loadProjectRules(run, request.cwd))
  } catch (error) {
    // A folder that can't be read is no reason to fail the turn.
    console.warn('[chat-context] rules files:', error instanceof Error ? error.message : error)
    return typed
  }
}
