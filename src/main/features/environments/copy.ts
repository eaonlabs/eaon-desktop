import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import type { Readable } from 'node:stream'
import type { SshHost } from '@shared/adeRemote'
import { connectProblem, shQuote, sshBinary } from '../ade/ssh'
import { sshCallArgv, sshRun } from '../../remoteWork'

/**
 * A copy of a project here, made in a folder on another machine, for a
 * session that runs there (shared/environments.ts).
 *
 * A git repository goes over as git: a bundle of the branch (its history,
 * so the agent can log, diff and commit as at home), then the changes not
 * committed yet, then the new files git isn't told to ignore. The copy is a
 * repository of its own whose `origin` is the project's, and on the branch the
 * project is on (or a new one, for the ADE). Ignored files (.env, builds,
 * node_modules) stay here. A folder that isn't a repository goes over as its
 * files, less the usual dependency and cache folders.
 *
 * Nothing here changes the project: it is only read.
 */

export interface CopyRequest {
  host: SshHost
  /** The project folder here. */
  project: string
  /** The folder on the host the copy goes in; `~` is the remote user's home. Made if missing. */
  parent: string
  /** The copy's folder name in `parent`. */
  name: string
  /** A branch to start the copy on, new; otherwise the project's own. */
  branch?: string
  onStep?: (step: string) => void
  signal?: AbortSignal
}

export interface CopyResult {
  /** The copy's folder on the host, absolute: the project's own folder in it, when the project is a subfolder of a repository. */
  path: string
  /** The commit the copy started from, for bringing changes back; null for a folder that isn't a repository. */
  base: string | null
  branch: string | null
}

/** Folders a copy of plain files leaves out: they are rebuilt where the project runs. */
export const LEFT_OUT = ['node_modules', '.venv', 'venv', '__pycache__', '.DS_Store', '.next', '.turbo', '.cache', 'target', '.gradle']
/** A copy of plain files bigger than this stops: it is a project's dependencies or data, not the project. */
const MAX_FILES_BYTES = 2 * 1024 ** 3
/** Untracked files bigger than this are left behind (a video, a database dump). */
const MAX_UNTRACKED_FILE = 50 * 1024 ** 2

export class CopyError extends Error {}

interface Local {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<Local> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'buffer' }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0
      resolve({ ok: !error, code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') || (error?.message ?? '') })
    })
  })
}

/** A script for the host's `sh`, its values as `$1`, `$2`… so none is ever part of the script. */
export function shScript(script: string, args: string[]): string {
  return `sh -c ${shQuote(script)} sh ${args.map(shQuote).join(' ')}`.trim()
}

/** The folder made (if missing) and given back absolute, `~` and `~/x` being the remote user's home. */
const ENSURE = String.raw`
case $1 in
  "~") d=$HOME ;;
  "~/"*) d=$HOME/${'$'}{1#"~/"} ;;
  *) d=$1 ;;
esac
mkdir -p -- "$d" && cd -P -- "$d" && pwd -P
`

export async function ensureRemoteFolder(host: SshHost, folder: string, signal?: AbortSignal): Promise<string> {
  const result = await sshRun(host, shScript(ENSURE, [folder.trim() || '~']), { timeoutMs: 60_000, signal })
  const path = result.stdout.toString('utf8').trim().split('\n').pop() ?? ''
  if (result.code === 0 && path.startsWith('/')) return path
  throw new CopyError(connectProblem(host, { ok: false, code: result.code, stdout: '', stderr: result.stderr }, folder))
}

/**
 * Streams `source` into a command line on the host, counting what goes and
 * stopping past `limit`. Resolves once both ends are done.
 */
function sendTo(host: SshHost, commandLine: string, source: Readable, opts: { signal?: AbortSignal; limit?: number; producer?: ReturnType<typeof spawn> } = {}): Promise<{ ok: boolean; stderr: string; bytes: number; tooBig: boolean }> {
  return new Promise((resolve) => {
    const ssh = spawn(sshBinary(), [...sshCallArgv(host), commandLine], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    let bytes = 0
    let tooBig = false
    let producerFailed = false
    let settled = false
    const stop = (): void => {
      source.destroy()
      opts.producer?.kill('SIGTERM')
      ssh.kill('SIGTERM')
    }
    const onAbort = (): void => stop()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    ssh.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString('utf8')
    })
    ssh.stdin?.on('error', () => undefined)
    source.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (opts.limit && bytes > opts.limit) {
        tooBig = true
        stop()
        return
      }
      if (!ssh.stdin?.write(chunk)) {
        source.pause()
        ssh.stdin?.once('drain', () => source.resume())
      }
    })
    source.on('end', () => ssh.stdin?.end())
    source.on('error', (error) => {
      producerFailed = true
      stderr += `\n${error.message}`
      ssh.stdin?.end()
    })
    opts.producer?.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString('utf8')
    })
    opts.producer?.on('close', (code) => {
      if (code !== 0) producerFailed = true
    })
    ssh.on('error', (error) => {
      stderr += (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ssh isn’t installed on this computer.' : error.message
    })
    ssh.on('close', (code) => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      // The producer's own end is waited for a moment, so its failure counts.
      const finish = (): void => resolve({ ok: code === 0 && !producerFailed && !tooBig && !opts.signal?.aborted, stderr: stderr.trim(), bytes, tooBig })
      if (opts.producer && opts.producer.exitCode === null) opts.producer.once('close', finish)
      else finish()
    })
  })
}

/** The project as git sees it, or null for a folder that isn't in a repository (or has no commit yet). */
async function repoOf(project: string): Promise<{ top: string; sub: string; head: string; branch: string | null; origin: string | null; name: string | null; email: string | null } | null> {
  const top = await git(project, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return null
  const head = await git(project, ['rev-parse', 'HEAD'])
  if (!head.ok) return null
  const root = top.stdout.trim()
  const [branch, origin, name, email] = await Promise.all([
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(root, ['remote', 'get-url', 'origin']),
    git(root, ['config', 'user.name']),
    git(root, ['config', 'user.email'])
  ])
  const sub = relative(root, project).split(sep).join('/')
  return {
    top: root,
    sub: sub.startsWith('..') ? '' : sub,
    head: head.stdout.trim(),
    branch: branch.ok ? branch.stdout.trim() || null : null,
    origin: origin.ok ? origin.stdout.trim() || null : null,
    name: name.ok ? name.stdout.trim() || null : null,
    email: email.ok ? email.stdout.trim() || null : null
  }
}

/**
 * The copy, made from the bundle: on the project's branch (or a new one),
 * `origin` set to the project's, the committer the user's, the bundle gone.
 * `$1` the folder it goes in, `$2` its name, `$3` the bundle, `$4` the branch
 * to check out (empty: the bundle's HEAD), `$5` a new branch (or empty), `$6`
 * origin's URL, `$7` and `$8` the committer.
 */
const CLONE = String.raw`
set -e
cd -P -- "$1"
if [ -e "$2" ]; then echo "$1/$2 is already there." >&2; exit 96; fi
git clone -q --no-hardlinks -- "$3" "$2" 2>&1 >/dev/null | grep -v 'warning: remote HEAD' >&2 || true
[ -d "$2/.git" ] || { echo "git couldn't make the copy." >&2; exit 95; }
rm -f -- "$3"
cd -- "$2"
if [ -n "$4" ] && git rev-parse -q --verify "refs/remotes/origin/$4" >/dev/null; then git checkout -q -B "$4" "refs/remotes/origin/$4"; fi
if [ -n "$5" ]; then git checkout -q -b "$5"; fi
git remote remove origin 2>/dev/null || true
if [ -n "$6" ]; then git remote add origin "$6"; fi
if [ -n "$7" ]; then git config user.name "$7"; fi
if [ -n "$8" ]; then git config user.email "$8"; fi
pwd -P
`

export async function copyProject(req: CopyRequest): Promise<CopyResult> {
  const step = req.onStep ?? (() => undefined)
  const { host } = req
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(req.name)) throw new CopyError(`“${req.name}” can’t be a folder name.`)

  step(`Connecting to ${host.label}`)
  const parent = await ensureRemoteFolder(host, req.parent, req.signal)
  const repo = await repoOf(req.project)

  if (!repo) {
    step(`Copying ${basename(req.project)}`)
    const dest = `${parent}/${req.name}`
    const tar = spawn('tar', ['-cf', '-', ...LEFT_OUT.map((f) => `--exclude=${f}`), '.'], { cwd: req.project, env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const sent = await sendTo(host, shScript('mkdir -p -- "$1" && tar -xf - -C "$1" 2>/dev/null; [ -d "$1" ]', [dest]), tar.stdout!, { signal: req.signal, limit: MAX_FILES_BYTES, producer: tar })
    if (sent.tooBig) throw new CopyError(`${basename(req.project)} is over 2 GB without its dependency folders. Make it a git repository (only what git tracks is copied), or use a smaller folder.`)
    if (!sent.ok) throw new CopyError(sent.stderr || `The files didn’t copy to ${host.label}.`)
    return { path: dest, base: null, branch: null }
  }

  // The branch and its history, as a bundle on its way through a temp file.
  step('Packing the repository')
  const scratch = await mkdtemp(join(tmpdir(), 'eaon-copy-'))
  try {
    const bundle = join(scratch, 'project.bundle')
    const refs = repo.branch ? [`refs/heads/${repo.branch}`, 'HEAD'] : ['HEAD']
    const packed = await git(repo.top, ['bundle', 'create', bundle, ...refs], 10 * 60_000)
    if (!packed.ok) throw new CopyError(`git couldn’t pack ${basename(repo.top)}: ${packed.stderr.trim().split('\n').pop() ?? ''}`)
    const size = (await stat(bundle)).size
    step(`Sending ${basename(repo.top)} (${megabytes(size)})`)
    const remoteBundle = `${parent}/.eaon-${req.name}.bundle`
    const sent = await sendTo(host, shScript('cat > "$1"', [remoteBundle]), createReadStream(bundle), { signal: req.signal })
    if (!sent.ok) throw new CopyError(sent.stderr || `The repository didn’t reach ${host.label}.`)

    step('Checking out the copy')
    const made = await sshRun(host, shScript(CLONE, [parent, req.name, remoteBundle, repo.branch ?? '', req.branch ?? '', repo.origin ?? '', repo.name ?? '', repo.email ?? '']), {
      timeoutMs: 10 * 60_000,
      signal: req.signal
    })
    const dest = made.stdout.toString('utf8').trim().split('\n').pop() ?? ''
    if (made.code !== 0 || !dest.startsWith('/')) {
      if (made.stderr.includes('not found') && made.stderr.includes('git')) throw new CopyError(`git isn’t installed on ${host.label}. Install it there, then try again.`)
      throw new CopyError(made.stderr.trim().split('\n').pop() || `The copy couldn’t be made on ${host.label}.`)
    }

    // What isn't committed yet: changes to tracked files, as a patch.
    const diff = await git(repo.top, ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff'])
    if (diff.ok && diff.stdout.trim()) {
      step('Bringing over uncommitted changes')
      const patch = join(scratch, 'changes.patch')
      await writeFile(patch, diff.stdout)
      const applied = await sendTo(host, shScript('cd -- "$1" && git apply --whitespace=nowarn', [dest]), createReadStream(patch), { signal: req.signal })
      if (!applied.ok) throw new CopyError(`The uncommitted changes didn’t apply on ${host.label}: ${applied.stderr.split('\n').pop() ?? ''}`)
    }

    // New files git isn't told to ignore, less any that are huge.
    const untracked = await git(repo.top, ['ls-files', '-z', '--others', '--exclude-standard'])
    const files = untracked.ok ? untracked.stdout.split('\0').filter(Boolean) : []
    const kept: string[] = []
    for (const file of files) {
      const info = await stat(join(repo.top, file)).catch(() => null)
      if (info?.isFile() && info.size <= MAX_UNTRACKED_FILE) kept.push(file)
    }
    if (kept.length > 0) {
      step(`Bringing over ${kept.length === 1 ? 'a new file' : `${kept.length} new files`}`)
      const list = join(scratch, 'files')
      await writeFile(list, `${kept.join('\0')}\0`)
      const tar = spawn('tar', ['-cf', '-', '--null', '-T', list], { cwd: repo.top, env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
      const sentFiles = await sendTo(host, shScript('tar -xf - -C "$1"', [dest]), tar.stdout!, { signal: req.signal, limit: MAX_FILES_BYTES, producer: tar })
      if (!sentFiles.ok) throw new CopyError(`The new files didn’t copy to ${host.label}: ${sentFiles.stderr.split('\n').pop() ?? ''}`)
    }

    return { path: repo.sub ? `${dest}/${repo.sub}` : dest, base: repo.head, branch: req.branch ?? repo.branch }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

const megabytes = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`)
