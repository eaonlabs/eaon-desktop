import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { remoteLocation, type SshHost } from '@shared/adeRemote'
import { remoteSpot } from '@shared/remotePath'
import { connectProblem, remoteCommandLine, sshArgv, sshBinary } from './features/ade/ssh'

/**
 * Working on a project that lives on another machine. A remote project's
 * folder is `ssh://<host id>/<folder>` (shared/adeRemote.ts); everything the
 * agent and the editor do to it is one `ssh` to that host running a small,
 * fixed shell script with the paths as arguments, so a file name is never
 * part of the script and can't run anything.
 *
 * Connecting is the user's own `ssh`: ~/.ssh/config, ssh-agent and the
 * Keychain. A background call can't ask for a password (BatchMode), so a key
 * that needs unlocking has to be in the agent. Calls to one host share a
 * connection (ControlMaster) so each costs a round trip, not a login. The
 * scripts are POSIX sh over coreutils: the host needs nothing installed.
 *
 * The project's folder is a boundary. The caller judges a path by its words
 * (shared/remotePath.ts); each script then resolves where the path really
 * leads, links followed, and refuses one that ends up outside the folder.
 */

/** A host and the folder a project is in on it. */
export interface RemoteProject {
  host: SshHost
  root: string
}

export class RemoteError extends Error {}

type HostFinder = (id: string) => Promise<SshHost | null>
let findHost: HostFinder | null = null

/** Tests (and anything without the ADE loaded) say where hosts come from. */
export function setHostFinder(finder: HostFinder | null): void {
  findHost = finder
}

/** The project a `ssh://` folder is: its host, found among ~/.ssh/config's and the ones added in Eaon. */
export async function openRemote(cwd: string): Promise<RemoteProject> {
  const place = remoteLocation(cwd)
  if (!place) throw new RemoteError(`${cwd} isn’t a folder on another machine.`)
  const find = findHost ?? (async (id: string) => (await import('./features/ade')).sshHosts.find(id))
  const host = await find(place.hostId)
  if (!host) throw new RemoteError('That SSH host isn’t in ~/.ssh/config or Eaon’s hosts any more. Edit the project to pick a host.')
  return { host, root: place.path }
}

/* ------------------------------------------------------------------- ssh */

/** Where connections are shared: short, because a socket's path can't be long, and the user's own. Null where ssh can't (Windows). */
function controlDir(): string | null {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null
  const dir = join('/tmp', `eaon-ssh-${process.getuid()}`)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const info = lstatSync(dir)
    return info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o077) === 0 ? dir : null
  } catch {
    return null
  }
}

/** `ssh`'s arguments for a background call: the usual, and a shared connection kept for two minutes. */
export function sshCallArgv(host: SshHost, dir: string | null = controlDir()): string[] {
  const share = dir ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${dir}/%C`, '-o', 'ControlPersist=120'] : []
  return [...share, ...sshArgv(host, { interactive: false })]
}

export interface SshResult {
  code: number | null
  stdout: Buffer
  stderr: string
  /** More than `maxBytes` came out; the rest was dropped. */
  truncated: boolean
  timedOut: boolean
  aborted: boolean
}

export interface SshOptions {
  stdin?: Buffer | string
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  /** Text as it arrives, for a command whose output is shown live. */
  onData?: (text: string) => void
}

/** Runs one command line on the host and waits for it. Never rejects: what went wrong is in the result. */
export function sshRun(host: SshHost, commandLine: string, opts: SshOptions = {}): Promise<SshResult> {
  const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024
  return new Promise((resolve) => {
    const result: SshResult = { code: null, stdout: Buffer.alloc(0), stderr: '', truncated: false, timedOut: false, aborted: false }
    if (opts.signal?.aborted) return resolve({ ...result, aborted: true })
    const child = spawn(sshBinary(), [...sshCallArgv(host), commandLine], { stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true })
    const out: Buffer[] = []
    let size = 0
    const err: Buffer[] = []
    let settled = false
    let hardKill: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
      child.kill('SIGTERM')
      hardKill ??= setTimeout(() => child.kill('SIGKILL'), 2000)
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          result.timedOut = true
          stop()
        }, opts.timeoutMs)
      : undefined
    const onAbort = (): void => {
      result.aborted = true
      stop()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const done = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(hardKill)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ ...result, code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      opts.onData?.(chunk.toString('utf8'))
      if (size >= maxBytes) {
        result.truncated = true
        return
      }
      const room = maxBytes - size
      out.push(room < chunk.length ? chunk.subarray(0, room) : chunk)
      size += Math.min(room, chunk.length)
      if (room < chunk.length) result.truncated = true
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      opts.onData?.(chunk.toString('utf8'))
      if (err.reduce((n, b) => n + b.length, 0) < 64 * 1024) err.push(chunk)
    })
    child.on('error', (error) => {
      err.push(Buffer.from((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ssh isn’t installed on this computer.' : error.message))
      done(null)
    })
    child.on('close', (code, signal) => done(signal ? null : code))
    if (opts.stdin !== undefined) {
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(opts.stdin)
    }
  })
}

/* --------------------------------------------------------------- scripts */

/**
 * Every script starts with this: `$1` is the project's folder (made real), and
 * `inroot PATH` says whether PATH, links followed, is the folder or inside
 * it. A path that doesn't exist yet is judged by its nearest folder that does.
 */
const PRELUDE = String.raw`
root=$(cd -P -- "$1" 2>/dev/null && pwd -P) || exit 97
shift
resolve() {
  p=$1; n=0
  while [ -L "$p" ] && [ "$n" -lt 40 ]; do
    l=$(readlink -- "$p") || break
    case $l in /*) p=$l ;; *) p=$(dirname -- "$p")/$l ;; esac
    n=$((n+1))
  done
  tl=; a=$p
  while [ ! -e "$a" ] && [ "$a" != / ]; do tl=/$(basename -- "$a")$tl; a=$(dirname -- "$a"); done
  if [ -d "$a" ]; then b=$(cd -P -- "$a" && pwd -P); else b=$(cd -P -- "$(dirname -- "$a")" && pwd -P)/$(basename -- "$a"); fi
  case $b in /) b= ;; esac
  printf '%s%s' "$b" "$tl"
}
inroot() {
  [ "$root" = / ] && return 0
  r=$(resolve "$1") || return 1
  case $r in "$root"|"$root"/*) return 0 ;; esac
  return 1
}
mtime() { stat -c %Y -- "$1" 2>/dev/null || stat -f %m -- "$1" 2>/dev/null || echo 0; }
`

/** A `$` for the shell's `${…}`, which a template literal would otherwise read as its own. */
const D = '$'

/** Exit codes the scripts use for what the caller turns into words. */
const OUTSIDE = 97
const NOT_A_FILE = 98
const MISSING = 99
const EXISTS = 96
const IS_ROOT = 93

/** One entry per record: kind, size, name, NUL-separated, then a closing `n` record with the count. */
const LIST = String.raw`
d=$1; lim=$2
inroot "$d" || exit 97
[ -d "$d" ] || exit 98
n=0
for f in "$d"/* "$d"/.[!.]* "$d"/..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  n=$((n+1))
  [ "$n" -le "$lim" ] || continue
  b=${D}{f##*/}
  if [ -d "$f" ]; then printf 'd\0\0%s\0' "$b"; else s=$(wc -c < "$f" 2>/dev/null | tr -d ' \t'); printf 'f\0%s\0%s\0' "${D}{s:-0}" "$b"; fi
done
printf 'n\0%s\0\0' "$n"
`

const READ = String.raw`
f=$1; max=$2
inroot "$f" || exit 97
[ -e "$f" ] || exit 99
[ -d "$f" ] && exit 98
size=$(wc -c < "$f" | tr -d ' \t')
printf '%s\t%s\n' "$size" "$(mtime "$f")"
head -c "$max" -- "$f"
`

const WRITE = String.raw`
f=$1
inroot "$f" || exit 97
[ -d "$f" ] && exit 98
mkdir -p -- "$(dirname -- "$f")" || exit 95
cat > "$f" || exit 94
printf '%s\n' "$(mtime "$f")"
`

const MOVE = String.raw`
a=$1; b=$2
inroot "$a" && inroot "$b" || exit 97
[ -e "$a" ] || [ -L "$a" ] || exit 99
[ "$(resolve "$a")" = "$root" ] && exit 93
[ -e "$b" ] && exit 96
mkdir -p -- "$(dirname -- "$b")" && mv -- "$a" "$b"
`

/** The remote Trash: a folder in the host user's home the agent can't empty, so a delete can be taken back. */
const TRASH = String.raw`
a=$1
inroot "$a" || exit 97
[ -e "$a" ] || [ -L "$a" ] || exit 99
[ "$(resolve "$a")" = "$root" ] && exit 93
t=${D}{HOME:?}/.eaon-trash/$(date +%Y%m%d-%H%M%S)-$$
mkdir -p -- "$t" && mv -- "$a" "$t/" && printf '%s\n' "$t"
`

const RUN = String.raw`
cd "$root" || exit 97
cmd=$1; secs=$2
export CI=1 FORCE_COLOR=0 NO_COLOR=1 PAGER=cat GIT_PAGER=cat GIT_TERMINAL_PROMPT=0
sh0=sh; flags=-c
if command -v bash >/dev/null 2>&1; then sh0=bash; flags=-lc; fi
if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 "$secs" "$sh0" "$flags" "$cmd"; fi
exec "$sh0" "$flags" "$cmd"
`

const BACKGROUND = String.raw`
cd "$root" || exit 97
cmd=$1
d=${D}{HOME:?}/.eaon-remote
mkdir -p -- "$d" || exit 95
log=$d/bg-$(date +%s)-$$.log
sh0=sh; flags=-c
if command -v bash >/dev/null 2>&1; then sh0=bash; flags=-lc; fi
( trap '' HUP; exec "$sh0" "$flags" "$cmd" ) > "$log" 2>&1 < /dev/null &
pid=$!
sleep 1
if kill -0 "$pid" 2>/dev/null; then alive=1; else alive=0; fi
printf '%s\n%s\n%s\n' "$alive" "$pid" "$log"
head -c 4000 "$log"
`

/** Lines of `path:line:text`, the best search the host has: ripgrep, then git, then grep. */
const GREP = String.raw`
cd "$root" || exit 97
pat=$1; cs=$2; lim=$3
ic=-i; [ "$cs" = 1 ] && ic=
{
  if command -v rg >/dev/null 2>&1; then rg -n --no-heading --color never -g '!node_modules' -g '!.git' $ic -e "$pat" -- .
  elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git grep -n -I -E --no-color $ic --untracked --exclude-standard -e "$pat" -- .
  else grep -rInE $ic --exclude-dir=node_modules --exclude-dir=.git -e "$pat" .
  fi
} 2>/dev/null | head -n "$lim"
`

/** The project's files, one a line: git's list (ignored files left out), or every file but the dependencies'. */
const FILES = String.raw`
cd "$root" || exit 97
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files -co --exclude-standard
else find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | sed 's|^\./||'
fi 2>/dev/null | head -n "$1"
`

/* ----------------------------------------------------------------- calls */

/** Runs a script in the project's folder; `args` follow the folder as `$1`, `$2`…. */
async function script(project: RemoteProject, body: string, args: string[], opts: SshOptions = {}): Promise<SshResult> {
  const line = remoteCommandLine(null, 'sh', ['-c', PRELUDE + body, 'sh', project.root, ...args])
  const res = await sshRun(project.host, line, { timeoutMs: 30_000, ...opts })
  if (res.aborted) throw new Error('aborted')
  if (res.timedOut) throw new RemoteError(`${project.host.label} didn’t answer in time.`)
  // 255 is ssh's own failure; null means it never ran.
  if (res.code === 255 || res.code === null) {
    throw new RemoteError(connectProblem(project.host, { ok: false, code: res.code, stdout: '', stderr: res.stderr }))
  }
  return res
}

/** The words for a script's exit code, or null when it succeeded. */
function failure(res: SshResult, what: string): string | null {
  switch (res.code) {
    case 0:
      return null
    case OUTSIDE:
      return `${what} is outside the project’s folder on the host. The agent works inside it only.`
    case MISSING:
      return `${what} doesn’t exist.`
    case NOT_A_FILE:
      return `${what} is a folder, not a file.`
    case EXISTS:
      return `${what} already exists.`
    case IS_ROOT:
      return 'That is the project’s own folder.'
    default:
      return res.stderr.trim().split('\n').filter(Boolean).pop() ?? `${what} couldn’t be done on the host (exit ${res.code}).`
  }
}

const expect = (res: SshResult, what: string): void => {
  const problem = failure(res, what)
  if (problem) throw new RemoteError(problem)
}

export interface RemoteEntry {
  name: string
  directory: boolean
  size: number
}

/** A folder's entries (unsorted), at most `limit`, and how many there are in all. */
export async function remoteList(project: RemoteProject, path: string, limit: number, signal?: AbortSignal): Promise<{ entries: RemoteEntry[]; total: number }> {
  const res = await script(project, LIST, [path, String(limit)], { signal })
  expect(res, path)
  const parts = res.stdout.toString('utf8').split('\0')
  const entries: RemoteEntry[] = []
  let total = 0
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i] === 'n') total = Number(parts[i + 1]) || 0
    else if (parts[i] === 'd' || parts[i] === 'f') entries.push({ directory: parts[i] === 'd', size: Number(parts[i + 1]) || 0, name: parts[i + 2] })
  }
  return { entries, total: Math.max(total, entries.length) }
}

export interface RemoteFile {
  /** The file's size on the host; `bytes` may hold less of it. */
  size: number
  modified: number
  bytes: Buffer
}

/** A file's first `max` bytes and its size and modified time. */
export async function remoteRead(project: RemoteProject, path: string, max: number, signal?: AbortSignal): Promise<RemoteFile> {
  const res = await script(project, READ, [path, String(max)], { signal, maxBytes: max + 4096 })
  expect(res, path)
  const newline = res.stdout.indexOf(10)
  const [size, modified] = res.stdout.subarray(0, newline).toString('utf8').split('\t').map(Number)
  return { size: size || 0, modified: (modified || 0) * 1000, bytes: res.stdout.subarray(newline + 1) }
}

/** Writes a file (and the folders above it); returns its new modified time. */
export async function remoteWrite(project: RemoteProject, path: string, content: Buffer | string, signal?: AbortSignal): Promise<number> {
  const res = await script(project, WRITE, [path], { stdin: content, signal, timeoutMs: 120_000 })
  expect(res, path)
  return (Number(res.stdout.toString('utf8').trim()) || 0) * 1000
}

export async function remoteMove(project: RemoteProject, from: string, to: string): Promise<void> {
  const res = await script(project, MOVE, [from, to])
  if (res.code === EXISTS) throw new RemoteError(`${to} already exists.`)
  expect(res, from)
}

/** Moves a file or folder into the host user's ~/.eaon-trash; returns where it went. */
export async function remoteTrash(project: RemoteProject, path: string): Promise<string> {
  const res = await script(project, TRASH, [path])
  expect(res, path)
  return res.stdout.toString('utf8').trim()
}

/** Search results as the host found them, `path:line:text`, unfiltered. */
export async function remoteGrep(project: RemoteProject, pattern: string, caseSensitive: boolean, lines: number, signal?: AbortSignal): Promise<string[]> {
  // The fallbacks read extended regular expressions, which have no \d.
  const portable = pattern.replace(/\\d/g, '[0-9]').replace(/\\D/g, '[^0-9]')
  const res = await script(project, GREP, [portable, caseSensitive ? '1' : '0', String(lines)], { signal, timeoutMs: 60_000 })
  return res.stdout
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/^\.\//, ''))
}

/** The project's files, relative, at most `limit`. */
export async function remoteFiles(project: RemoteProject, limit: number, signal?: AbortSignal): Promise<{ paths: string[]; truncated: boolean }> {
  const res = await script(project, FILES, [String(limit + 1)], { signal, timeoutMs: 60_000 })
  const paths = res.stdout.toString('utf8').split('\n').filter(Boolean)
  return { paths: paths.slice(0, limit), truncated: paths.length > limit }
}

/** Runs a command on the host in the project's folder, output shown live as `onData` is given it. */
export async function remoteRun(project: RemoteProject, command: string, seconds: number, opts: { signal: AbortSignal; onData: (text: string) => void }): Promise<{ code: number | null; timedOut: boolean }> {
  const line = remoteCommandLine(null, 'sh', ['-c', PRELUDE + RUN, 'sh', project.root, command, String(seconds)])
  // The host's own `timeout` stops the command at `seconds`; this one is for a host without it, and for a hung connection.
  const res = await sshRun(project.host, line, { signal: opts.signal, timeoutMs: (seconds + 10) * 1000, onData: opts.onData, maxBytes: 64 * 1024 * 1024 })
  if (res.aborted) throw new Error('aborted')
  if (res.code === 255 || (res.code === null && !res.timedOut)) {
    throw new RemoteError(connectProblem(project.host, { ok: false, code: res.code, stdout: '', stderr: res.stderr }))
  }
  if (res.code === OUTSIDE) throw new RemoteError(`The project’s folder isn’t there on ${project.host.label} any more.`)
  return { code: res.code, timedOut: res.timedOut || res.code === 124 }
}

export interface RemoteBackground {
  alive: boolean
  pid: number
  log: string
  early: string
}

/** Starts a command that keeps running after the call (a dev server), its output in a log on the host. */
export async function remoteBackground(project: RemoteProject, command: string): Promise<RemoteBackground> {
  const res = await script(project, BACKGROUND, [command], { timeoutMs: 30_000 })
  if (res.code === OUTSIDE) throw new RemoteError(`The project’s folder isn’t there on ${project.host.label} any more.`)
  if (res.code !== 0) throw new RemoteError(failure(res, 'The command') ?? 'The command didn’t start.')
  const text = res.stdout.toString('utf8')
  const [alive, pid, log] = text.split('\n')
  return { alive: alive === '1', pid: Number(pid) || 0, log, early: text.split('\n').slice(3).join('\n') }
}

/** Where a path the agent wrote lies on the host, or why it can't be used. */
export function remotePlace(cwd: string, target: string): { path: string; root: string } {
  const spot = remoteSpot(cwd, target)
  if (!spot) throw new RemoteError(`${cwd} isn’t a folder on another machine.`)
  if (!spot.inside) throw new RemoteError(`"${target}" is outside the project’s folder on the host. The agent works inside it only; use a path relative to the project.`)
  return { path: spot.path, root: spot.root }
}
