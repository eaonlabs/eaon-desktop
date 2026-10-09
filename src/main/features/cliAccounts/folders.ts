import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliTool } from '@shared/cliAccounts'

/**
 * An extra account is a folder of its own that the CLI is pointed at
 * (CLAUDE_CONFIG_DIR, CODEX_HOME), so its login lives there and nowhere near
 * the default one's. Everything else — settings, instructions, skills,
 * plugins and past sessions — is linked back to the default folder, so
 * switching accounts changes who is signed in and nothing else: the same
 * setup, and `claude --resume` still finds yesterday's session.
 *
 * What is never linked is the login itself and the CLI's per-account state
 * (Claude Code's .claude.json, Codex's auth.json and databases).
 */

/** The CLI's own default folder, as the CLI itself works it out. */
export function defaultDir(tool: CliTool, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (tool === 'claude') return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  return env.CODEX_HOME || path.join(home, '.codex')
}

/** What an extra account shares with the default one, when the default has it. */
export const SHARED: Record<CliTool, string[]> = {
  claude: ['settings.json', 'CLAUDE.md', 'commands', 'agents', 'skills', 'plugins', 'output-styles', 'hooks', 'projects'],
  codex: ['config.toml', 'AGENTS.md', 'prompts', 'skills', 'rules', 'sessions', 'archived_sessions']
}

/**
 * Makes (or repairs) an account's folder: created if missing, with a link
 * for each shared thing the default folder has and this one doesn't. A
 * file the account has of its own is left alone.
 */
export function prepareFolder(tool: CliTool, dir: string, from: string = defaultDir(tool)): string[] {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const linked: string[] = []
  for (const name of SHARED[tool]) {
    const source = path.join(from, name)
    const target = path.join(dir, name)
    if (!exists(source) || exists(target) || isLink(target)) continue
    try {
      const directory = fs.statSync(source).isDirectory()
      fs.symlinkSync(source, target, directory && process.platform === 'win32' ? 'junction' : directory ? 'dir' : 'file')
      linked.push(name)
    } catch {
      /* not linked: the account just starts without it */
    }
  }
  return linked
}

/**
 * Deletes an account's folder — but only one Eaon made, under `root`. The
 * shared links are unlinked first so nothing they point at can go with it.
 */
export function removeFolder(dir: string, root: string): void {
  const resolved = path.resolve(dir)
  const base = path.resolve(root) + path.sep
  if (!resolved.startsWith(base)) throw new Error('Not a folder Eaon made for an account')
  if (!exists(resolved) && !isLink(resolved)) return
  for (const name of fs.readdirSync(resolved)) {
    const entry = path.join(resolved, name)
    if (isLink(entry)) fs.unlinkSync(entry)
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}

function exists(file: string): boolean {
  try {
    fs.statSync(file)
    return true
  } catch {
    return false
  }
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}
