import { parseCommits, type ChatCommits } from '@shared/chatCode'
import { FILE_COMMITS_SHOWN, parseBlame, type LineBlameResult } from '@shared/fileHistory'
import { problemOf, type Runner } from './runner'

/**
 * A file's own history and who last changed a line of it, from git, for the
 * editor. `file` is a path git takes from `cwd`: relative, inside the repository.
 */

/** The commits that touched the file, newest first, following it across renames; the ones its upstream doesn't have yet are marked. */
export async function fileCommits(run: Runner, cwd: string, file: string): Promise<ChatCommits> {
  const log = await run(cwd, 'git', ['log', '--follow', `-n${FILE_COMMITS_SHOWN}`, '--no-color', '--format=%H%x00%h%x00%s%x00%ct%x00%an', '--', file], 15_000)
  if (!log.ok) return { ok: false, error: problemOf(log, 'git couldn’t read this file’s history.') }
  const ahead = await run(cwd, 'git', ['rev-list', '@{upstream}..HEAD'], 5000)
  return { ok: true, commits: parseCommits(log.stdout, new Set(ahead.ok ? ahead.stdout.split('\n').filter(Boolean) : [])) }
}

/** Who last changed one line (1-based) of the file as it is on disk, or why git can't say (not tracked, no commits yet). */
export async function lineBlame(run: Runner, cwd: string, file: string, line: number): Promise<LineBlameResult> {
  const res = await run(cwd, 'git', ['blame', '-L', `${line},${line}`, '--porcelain', '--', file], 15_000)
  if (!res.ok) return { ok: false, error: problemOf(res, 'git has no blame for this line.') }
  const blame = parseBlame(res.stdout)
  return blame ? { ok: true, blame } : { ok: false, error: 'git has no blame for this line.' }
}
