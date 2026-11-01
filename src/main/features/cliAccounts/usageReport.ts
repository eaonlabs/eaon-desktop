import fs from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * A Claude plan's limits, as Claude Code itself reports them. Claude Code
 * hands a status line the plan's `rate_limits` after each reply, so the
 * Claude Code panes Eaon starts get one (terminals.ts adds `--settings` with
 * it): a small script that keeps that JSON where the usage meter reads it,
 * then shows the user's own status line, if they have one. Eaon never reads
 * Claude Code's sign-in or asks Anthropic anything itself (Anthropic's terms
 * for other apps), and nobody has to type /usage.
 *
 * Under `root` (~/.eaon/claude-usage, claudeReportRoot):
 *   status-line.sh       the status line
 *   settings.json        what `--settings` loads: just that status line
 *   limits/<key>.json    the last report from each Claude Code folder
 *   limits/<key>.cmd     that folder's own status line, run after ours
 *
 * `<key>` names the folder Claude Code runs from (CLAUDE_CONFIG_DIR, or
 * "default"), so each account keeps its own figures.
 *
 * Everywhere (Settings → Accounts, on by default): the same status line goes
 * in Claude Code's own settings (~/.claude/settings.json and each account's),
 * as Orca puts its own there, so every Claude Code session on this computer
 * reports — not only the ones Eaon starts. The status line that was there
 * runs after it (an Orca hook, a statusline script), is kept in
 *   previous-statuslines.json
 * and goes back when the switch goes off. Should Eaon's files go, Claude
 * Code's status line falls back to that one by itself.
 */

const SCRIPT = `#!/bin/sh
# Written by Eaon each time it starts Claude Code; changes here are replaced.
# Claude Code runs this as its status line in Eaon's terminals. It keeps the
# plan limits Claude Code passes it (rate_limits) where Eaon's usage meter
# reads them, then shows your own status line, if you have one.
dir=$1
input=$(cat)
key=$(printf '%s' "\${CLAUDE_CONFIG_DIR:-default}" | LC_ALL=C tr -c 'A-Za-z0-9' '_')
case $input in
  *'"rate_limits"'*)
    (umask 077 && printf '%s' "$input" > "$dir/.$key.$$" && mv -f "$dir/.$key.$$" "$dir/$key.json") 2>/dev/null
    ;;
esac
if [ -s "$dir/$key.cmd" ]; then
  printf '%s' "$input" | sh -c "$(cat "$dir/$key.cmd")"
fi
exit 0
`

/** The file name a Claude Code folder's report goes under: what `tr -c 'A-Za-z0-9' '_'` makes of its bytes. */
export function reportKey(dir: string | null): string {
  const bytes = Buffer.from(dir || 'default', 'utf8')
  let key = ''
  for (const byte of bytes) key += /[A-Za-z0-9]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : '_'
  return key
}

/** POSIX single quotes, for the command line inside settings.json. */
const sq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** Writes `file` only when it would change: this runs on every Claude Code start. */
function put(file: string, content: string, mode: number): void {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return
  } catch {
    /* not there yet */
  }
  fs.writeFileSync(file, content, { mode })
  fs.chmodSync(file, mode)
}

type StatusLine = { type: 'command'; command: string; padding?: number }

/** A Claude Code folder's settings file, through the link an extra account's is (cliAccounts/folders.ts SHARED). */
function settingsFile(dir: string | null): string {
  const file = path.join(dir ?? path.join(os.homedir(), '.claude'), 'settings.json')
  try {
    return fs.realpathSync(file)
  } catch {
    return file
  }
}

/** A Claude Code folder's own status line (its settings.json), if it has a command one. */
function ownStatusLine(dir: string | null): StatusLine | null {
  try {
    return asStatusLine(JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8'))?.statusLine)
  } catch {
    return null
  }
}

function asStatusLine(line: unknown): StatusLine | null {
  const l = line as Partial<StatusLine> | null
  if (l?.type !== 'command' || typeof l.command !== 'string' || !l.command.trim()) return null
  return { type: 'command', command: l.command, ...(typeof l.padding === 'number' ? { padding: l.padding } : {}) }
}

/** The status lines Eaon's took the place of, by settings file. */
const previousFile = (root: string): string => path.join(root, 'previous-statuslines.json')
function readPrevious(root: string): Record<string, StatusLine | null> {
  try {
    return JSON.parse(fs.readFileSync(previousFile(root), 'utf8')) ?? {}
  } catch {
    return {}
  }
}

/** Ours, in Claude Code's own settings: Eaon's status line, or the one it replaced when Eaon's files are gone. */
function everywhereLine(script: string, limits: string, previous: StatusLine | null): StatusLine {
  const fallback = previous ? `/bin/sh -c ${sq(previous.command)}` : 'cat >/dev/null'
  return {
    type: 'command',
    command: `if [ -r ${sq(script)} ]; then /bin/sh ${sq(script)} ${sq(limits)}; else ${fallback}; fi`,
    ...(previous?.padding !== undefined ? { padding: previous.padding } : {})
  }
}

/**
 * A status line Claude Code stopped between writing its report and renaming
 * it into place (a newer one starting cancels it) leaves `.<key>.<pid>`
 * behind. Ones older than a minute are no write in progress.
 */
function sweepStale(limits: string, now = Date.now()): void {
  for (const name of fs.readdirSync(limits)) {
    if (!/^\..+\.\d+$/.test(name)) continue
    const file = path.join(limits, name)
    try {
      if (now - fs.statSync(file).mtimeMs > 60_000) fs.rmSync(file, { force: true })
    } catch {
      // Renamed or removed meanwhile.
    }
  }
}

/**
 * Makes the status line ready for the Claude Code folders in `dirs` (null is
 * the default one) and returns the settings file to start Claude Code with.
 * Null where it can't be used: on Windows, whose panes have no POSIX shell to
 * run it, or when the files can't be written.
 */
export function prepareClaudeReport(root: string, dirs: (string | null)[], platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null
  try {
    const limits = path.join(root, 'limits')
    fs.mkdirSync(limits, { recursive: true, mode: 0o700 })
    sweepStale(limits)
    const script = path.join(root, 'status-line.sh')
    put(script, SCRIPT, 0o700)
    let padding: number | undefined
    const previous = readPrevious(root)
    for (const dir of new Set(dirs.map((d) => d || null))) {
      const found = ownStatusLine(dir)
      // Ours in their settings (everywhere): theirs is the one it replaced.
      const own = found?.command.includes(script) ? (previous[settingsFile(dir)] ?? null) : found
      const cmd = path.join(limits, `${reportKey(dir)}.cmd`)
      if (own && !own.command.includes(script)) {
        put(cmd, own.command, 0o600)
        if (dir === null && own.padding !== undefined) padding = own.padding
      } else fs.rmSync(cmd, { force: true })
    }
    const settings = path.join(root, 'settings.json')
    const statusLine = { type: 'command', command: `sh ${sq(script)} ${sq(limits)}`, ...(padding !== undefined ? { padding } : {}) }
    put(settings, `${JSON.stringify({ statusLine }, null, 2)}\n`, 0o600)
    return settings
  } catch (error) {
    console.error('[cli-accounts] the Claude Code status line could not be set up:', error)
    return null
  }
}

/**
 * Puts Eaon's status line in Claude Code's own settings for the folders in
 * `dirs` (or takes it out, `on` false, putting back what was there), so every
 * Claude Code session reports, as Orca's does. A settings file that isn't
 * JSON is left alone. Returns the files it changed.
 */
export function claudeReportEverywhere(root: string, dirs: (string | null)[], on: boolean, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return []
  const script = path.join(root, 'status-line.sh')
  const limits = path.join(root, 'limits')
  const previous = readPrevious(root)
  const changed: string[] = []
  for (const file of new Set(dirs.map((d) => settingsFile(d || null)))) {
    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}
      if (typeof settings !== 'object' || Array.isArray(settings)) continue
    } catch (error) {
      // No settings yet is fine (turning it on makes one); one we can't read stays as it is.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || !on) continue
    }
    const current = asStatusLine(settings.statusLine)
    const ours = Boolean(current?.command.includes(script))
    if (on === ours) continue
    if (on) {
      previous[file] = current
      settings.statusLine = everywhereLine(script, limits, current)
    } else {
      const before = previous[file]
      if (before) settings.statusLine = before
      else delete settings.statusLine
      delete previous[file]
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // Written in place: an extra account's settings is a link to the default's.
      fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
      changed.push(file)
    } catch (error) {
      console.error('[cli-accounts] Claude Code’s settings couldn’t be changed:', error)
    }
  }
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    fs.writeFileSync(previousFile(root), JSON.stringify(previous, null, 2), { mode: 0o600 })
  } catch {
    /* kept in memory only for now */
  }
  return changed
}

/** The last report from a Claude Code folder: the JSON its status line got, and when that was written. */
export async function readClaudeReport(root: string, dir: string | null): Promise<{ at: number; input: unknown } | null> {
  const file = path.join(root, 'limits', `${reportKey(dir)}.json`)
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    return { at: info.mtimeMs, input: JSON.parse(text) }
  } catch {
    return null
  }
}

/** Where the reports land, for watching. */
export const reportsDir = (root: string): string => path.join(root, 'limits')

/**
 * Its files' place: one for the user, not one per Eaon profile, since Claude
 * Code's settings (and so the status line in them) are the user's too, and a
 * second copy of Eaon (a beta beside the release) reads the same reports.
 * `EAON_CLAUDE_USAGE_DIR` moves it (tests, a scratch profile).
 */
export const claudeReportRoot = (): string => process.env.EAON_CLAUDE_USAGE_DIR || path.join(os.homedir(), '.eaon', 'claude-usage')

/**
 * The folder Claude Code runs from for an account: its own, or for the
 * default account whatever CLAUDE_CONFIG_DIR Eaon's panes inherit.
 */
export const claudeFolder = (dir: string | null): string | null => dir ?? process.env.CLAUDE_CONFIG_DIR ?? null
