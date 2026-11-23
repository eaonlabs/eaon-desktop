import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SshHost } from '@shared/adeRemote'
import type { BringBackResult } from '@shared/environments'
import { connectProblem } from '../ade/ssh'
import { sshRun } from '../../remoteWork'
import { shScript } from './copy'

/**
 * What a session did on another machine, brought back to the project here as
 * a branch of its own: its commits, and anything it hadn't committed as one
 * commit on top ("Uncommitted work from …"). The project's checkout, its
 * branch and its files aren't touched: the branch is only made (or moved, if
 * it was brought back before), for the user to look at, merge or push.
 *
 * On the machine, the uncommitted work is written with a scratch index, so
 * the copy's own index and files stay as the agent left them.
 */

/**
 * `$1` the copy, `$2` the commit it started from, `$3` the message for the
 * uncommitted work, `$4` where to write the bundle. Prints the tip, or SAME
 * when nothing changed since the copy was made.
 */
const PACK = String.raw`
cd -P -- "$1" 2>/dev/null || exit 97
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 96
idx=$(mktemp) || exit 1
cp -- "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || :
GIT_INDEX_FILE=$idx git add -A -- . >/dev/null 2>&1 || { rm -f -- "$idx"; exit 1; }
tree=$(GIT_INDEX_FILE=$idx git write-tree) || { rm -f -- "$idx"; exit 1; }
rm -f -- "$idx"
head=$(git rev-parse HEAD) || exit 1
if [ "$tree" = "$(git rev-parse 'HEAD^{tree}')" ]; then
  tip=$head
else
  name=$(git config user.name || echo Eaon)
  email=$(git config user.email || echo eaon@localhost)
  tip=$(GIT_AUTHOR_NAME=$name GIT_AUTHOR_EMAIL=$email GIT_COMMITTER_NAME=$name GIT_COMMITTER_EMAIL=$email git commit-tree "$tree" -p "$head" -m "$3") || exit 1
fi
if [ "$tip" = "$2" ]; then echo SAME; exit 0; fi
git update-ref refs/eaon/bring-back "$tip" || exit 1
if [ -n "$2" ] && git cat-file -e "$2^{commit}" 2>/dev/null; then
  git bundle create "$4" refs/eaon/bring-back "^$2" >/dev/null 2>&1 || exit 1
else
  git bundle create "$4" refs/eaon/bring-back >/dev/null 2>&1 || exit 1
fi
echo "$tip"
`

function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error?.message ?? '') })
    )
  })
}

/** A branch name git takes, from a session's name: `eaon/<slug>`. */
export function bringBackBranch(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[-.]{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48)
    .replace(/[-.]+$/, '')
  return `eaon/${slug || 'cloud'}`
}

export async function bringBack(opts: { host: SshHost; remote: string; project: string; base: string | null; branch: string; where: string }): Promise<BringBackResult> {
  const { host, project } = opts
  const top = await git(project, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return { ok: false, error: `${project} isn’t a git repository here, so the changes can’t come back as a branch.` }
  const root = top.stdout.trim()
  const current = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (current.ok && current.stdout.trim() === opts.branch) {
    return { ok: false, error: `The project is on ${opts.branch} here. Switch to another branch, then bring the changes back again.` }
  }

  const remoteBundle = `/tmp/eaon-bring-back-${process.pid}-${Date.now()}.bundle`
  const packed = await sshRun(host, shScript(PACK, [opts.remote, opts.base ?? '', `Uncommitted work from ${opts.where}`, remoteBundle]), { timeoutMs: 5 * 60_000 })
  const said = packed.stdout.toString('utf8').trim().split('\n').pop() ?? ''
  if (packed.code === 97) return { ok: false, error: `The session’s folder isn’t on ${host.label} any more.` }
  if (packed.code === 96) return { ok: false, error: `The session’s folder on ${host.label} isn’t a git repository.` }
  if (packed.code !== 0) return { ok: false, error: connectProblem(host, { ok: false, code: packed.code, stdout: '', stderr: packed.stderr }) }
  if (said === 'SAME') return { ok: false, error: `Nothing has changed on ${opts.where} since the session started.` }

  const fetched = await sshRun(host, shScript('cat -- "$1" && rm -f -- "$1"', [remoteBundle]), { timeoutMs: 10 * 60_000, maxBytes: 1024 ** 3 })
  if (fetched.code !== 0 || fetched.truncated) return { ok: false, error: `The changes didn’t come back from ${host.label}: ${fetched.stderr.trim().split('\n').pop() ?? 'too big'}` }

  const scratch = await mkdtemp(join(tmpdir(), 'eaon-back-'))
  try {
    const file = join(scratch, 'changes.bundle')
    await writeFile(file, fetched.stdout)
    const got = await git(root, ['fetch', '--quiet', '--no-tags', file, `+refs/eaon/bring-back:refs/heads/${opts.branch}`])
    if (!got.ok) {
      if (/prerequisite|missing/i.test(got.stderr)) return { ok: false, error: 'The project here no longer has the commit the session started from, so the changes can’t be added to it.' }
      return { ok: false, error: `git couldn’t take the changes: ${got.stderr.trim().split('\n').pop() ?? ''}` }
    }
    const range = opts.base ? `${opts.base}..${opts.branch}` : opts.branch
    const [count, names] = await Promise.all([
      git(root, ['rev-list', '--count', range]),
      opts.base ? git(root, ['diff', '--name-only', opts.base, opts.branch]) : Promise.resolve({ ok: false, stdout: '', stderr: '' })
    ])
    const commits = count.ok ? Number(count.stdout.trim()) || 0 : 0
    const files = names.ok ? names.stdout.split('\n').filter(Boolean).length : 0
    const changed = files ? `${files} ${files === 1 ? 'file' : 'files'} changed` : `${commits} ${commits === 1 ? 'commit' : 'commits'}`
    return { ok: true, branch: opts.branch, commits, files, message: `The changes are on the branch ${opts.branch} in this project (${changed}). Your checkout wasn’t touched.` }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}
