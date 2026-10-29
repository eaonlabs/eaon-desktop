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
 * Under `root` (userData/claude-code):
 *   status-line.sh       the status line
 *   settings.json        what `--settings` loads: just that status line
 *   limits/<key>.json    the last report from each Claude Code folder
 *   limits/<key>.cmd     that folder's own status line, run after ours
 *
 * `<key>` names the folder Claude Code runs from (CLAUDE_CONFIG_DIR, or
 * "default"), so each account keeps its own figures.
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

/** A Claude Code folder's own status line (its settings.json), if it has a command one. */
function ownStatusLine(dir: string | null): { command: string; padding?: number } | null {
  const file = path.join(dir ?? path.join(os.homedir(), '.claude'), 'settings.json')
  try {
    const line = JSON.parse(fs.readFileSync(file, 'utf8'))?.statusLine
    if (line?.type !== 'command' || typeof line.command !== 'string' || !line.command.trim()) return null
    return { command: line.command, ...(typeof line.padding === 'number' ? { padding: line.padding } : {}) }
  } catch {
    return null
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
    const script = path.join(root, 'status-line.sh')
    put(script, SCRIPT, 0o700)
    let padding: number | undefined
    for (const dir of new Set(dirs.map((d) => d || null))) {
      const own = ownStatusLine(dir)
      const cmd = path.join(limits, `${reportKey(dir)}.cmd`)
      // Never our own line again, should it ever end up in theirs.
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

/** Its files' place in Eaon's data. */
export const claudeReportRoot = (userData: string): string => path.join(userData, 'claude-code')

/**
 * The folder Claude Code runs from for an account: its own, or for the
 * default account whatever CLAUDE_CONFIG_DIR Eaon's panes inherit.
 */
export const claudeFolder = (dir: string | null): string | null => dir ?? process.env.CLAUDE_CONFIG_DIR ?? null
