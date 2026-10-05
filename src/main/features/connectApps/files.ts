import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, sep } from 'node:path'

/**
 * Reading and writing other apps' settings files. Every one of these files
 * belongs to the user and the app, not to Eaon, so:
 *
 * - a file that doesn't parse is refused, never guessed at or overwritten;
 * - the first time Eaon writes a file it keeps a copy (`<file>.eaon-backup`),
 *   and never replaces that copy afterwards, so it stays the user's original;
 * - writes go to a temporary file first and are renamed into place.
 */

export class ConfigError extends Error {}

/** `~/…` for a path under home, so the page shows what the user would type. */
export function tilde(path: string, home: string): string {
  const rel = relative(home, path)
  return rel && !rel.startsWith('..') && !rel.startsWith(sep) ? `~/${rel.split(sep).join('/')}` : path
}

export function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Copies the file aside once, before Eaon's first change to it. */
export function backupOnce(path: string): void {
  const backup = `${path}.eaon-backup`
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup)
}

export function writeText(path: string, text: string): void {
  backupOnce(path)
  writeOwnFile(path, text)
}

/**
 * Where a write to `path` should land: the file a symlink points to, so a
 * settings file kept in a dotfiles repo (`~/.claude/settings.json` →
 * `~/dotfiles/claude.json`) is changed in place rather than replaced by a
 * plain file that cuts the link.
 */
function writeTarget(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path
  } catch {
    return path
  }
}

/**
 * A file that is Eaon's own, written whole (a model catalog, a profile): no
 * backup of Eaon's last copy. Written beside the file and renamed into
 * place, keeping the file's permissions: these files hold the gateway's
 * key, and a settings file the user had made private must stay private. A
 * new one is made readable by the user only.
 */
export function writeOwnFile(path: string, text: string): void {
  const target = writeTarget(path)
  mkdirSync(dirname(target), { recursive: true })
  let mode = 0o600
  try {
    mode = statSync(target).mode & 0o777
  } catch {
    /* a new file */
  }
  const tmp = `${target}.eaon-tmp`
  writeFileSync(tmp, text, { encoding: 'utf8', mode })
  // The umask can loosen what writeFileSync was asked for; set it exactly.
  chmodSync(tmp, mode)
  renameSync(tmp, target)
}

export function removeFile(path: string): void {
  rmSync(path, { force: true })
}

export type Json = Record<string, unknown>

/** A JSON settings file, or `{}` when there is none. Comments or a syntax error are refused. */
export function readJson(path: string, home: string): Json {
  const text = readText(path)
  if (text === null || !text.trim()) return {}
  try {
    const value = JSON.parse(text) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Json
  } catch {
    /* refused below */
  }
  throw new ConfigError(
    `${tilde(path, home)} isn't plain JSON (it may have comments or a typo), so Eaon won't rewrite it. Fix it, or use Copy settings and add them by hand.`
  )
}

export function writeJson(path: string, value: Json): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * For disconnecting: writes `text`, unless that leaves nothing in a file
 * Eaon created. Such a file has no backup, since the backup is taken only of
 * a file that was already there, so it's removed instead.
 */
export function writeBack(path: string, text: string): void {
  if (!text.trim() || text.trim() === '{}') {
    if (!existsSync(`${path}.eaon-backup`)) return removeFile(path)
  }
  writeText(path, text)
}

export function writeJsonBack(path: string, value: Json): void {
  writeBack(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Follows `a.b.c` through nested objects; undefined when any step is missing. */
export function getPath(root: Json, path: string[]): unknown {
  let node: unknown = root
  for (const key of path) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
    node = (node as Json)[key]
  }
  return node
}

/** Sets `a.b.c`, making the objects on the way when they're missing. */
export function setPath(root: Json, path: string[], value: unknown): void {
  let node = root
  for (const key of path.slice(0, -1)) {
    const next = node[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) node[key] = {}
    node = node[key] as Json
  }
  node[path[path.length - 1]] = value
}

/** Removes `a.b.c`, and any object on the way that's left empty by it. */
export function deletePath(root: Json, path: string[]): void {
  const parents: Json[] = []
  let node: Json = root
  for (const key of path.slice(0, -1)) {
    const next = node[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) return
    parents.push(node)
    node = next as Json
  }
  delete node[path[path.length - 1]]
  for (let i = path.length - 2; i >= 0; i--) {
    const parent = parents[i]
    const child = parent[path[i]] as Json
    if (Object.keys(child).length > 0) break
    delete parent[path[i]]
  }
}

