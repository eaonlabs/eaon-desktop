import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseBranches, parseCommits } from '@shared/chatCode'
import { capText, DIFF_CAP, MENTION_COMMITS, type GitMention, type GitRefs } from '@shared/chatContext'
import { problemOf, type Runner } from '../ade/runner'
import { defaultBranch } from '../ade/review'

/**
 * Git for the "@" menu's mentions (shared/chatContext.ts): which commits and
 * branches to offer, and a change, a branch or a commit as the text of its
 * diff. Plain git in the chat's folder, read only; nothing is staged,
 * switched or written.
 */

/** git's own name for the tree with nothing in it: what a repository with no commits is compared to. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** Past this many new files, the rest are left out of the uncommitted diff. */
const MAX_UNTRACKED = 40
/** A new file bigger than this (200 KB) isn't read into the diff. */
const MAX_UNTRACKED_BYTES = 200_000
const PLAIN = ['--no-color', '--no-ext-diff']
const DIFF_ARGS = [...PLAIN, '-M', '-U3']

export async function gitRefs(run: Runner, cwd: string): Promise<GitRefs> {
  const inside = await run(cwd, 'git', ['rev-parse', '--is-inside-work-tree'], 5000)
  if (!inside.ok) return { base: null, current: null, commits: [], branches: [], repo: false }
  const [current, base, log, local] = await Promise.all([
    run(cwd, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], 5000),
    defaultBranch(run, cwd),
    run(cwd, 'git', ['log', `-n${MENTION_COMMITS}`, '--no-color', '--format=%H%x00%h%x00%s%x00%ct%x00%an'], 10_000),
    run(cwd, 'git', ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)\t%(committerdate:unix)', 'refs/heads'], 10_000)
  ])
  return {
    repo: true,
    base: base?.name ?? null,
    current: current.ok ? current.stdout.trim() || null : null,
    commits: log.ok ? parseCommits(log.stdout, new Set()) : [],
    branches: parseBranches(local.ok ? local.stdout : '', '')
      .map((b) => b.name)
      .slice(0, 40)
  }
}

export type GitText = { ok: true; label: string; text: string; files: number; truncated: boolean } | { ok: false; error: string }

const fileCount = (diff: string): number => (diff.match(/^diff --git /gm) ?? []).length

function done(label: string, head: string, diff: string): GitText {
  const capped = capText(`${head}\n\n${diff}`, DIFF_CAP, 'diff')
  return { ok: true, label, text: capped.text, files: fileCount(diff), truncated: capped.truncated }
}

/** New files, as git would show them added: what `git diff` leaves out because they aren't tracked yet. */
async function untracked(run: Runner, cwd: string): Promise<string> {
  const list = await run(cwd, 'git', ['ls-files', '--others', '--exclude-standard', '-z'], 15_000)
  if (!list.ok) return ''
  let out = ''
  for (const file of list.stdout.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED)) {
    const info = await stat(join(cwd, file)).catch(() => null)
    if (!info?.isFile() || info.size > MAX_UNTRACKED_BYTES) continue
    // Exit 1 is "they differ", which is the point.
    const res = await run(cwd, 'git', ['diff', '--no-index', ...PLAIN, '--', '/dev/null', file], 15_000)
    out += res.stdout.endsWith('\n') || !res.stdout ? res.stdout : `${res.stdout}\n`
  }
  return out
}

async function uncommitted(run: Runner, cwd: string): Promise<GitText> {
  const head = await run(cwd, 'git', ['rev-parse', '--verify', '--quiet', 'HEAD'], 5000)
  if (!head.ok && (head.code === null || /not a git repository/i.test(head.stderr))) return { ok: false, error: problemOf(head, 'This folder isn’t in a git repository.') }
  const [diff, added, branch] = await Promise.all([
    run(cwd, 'git', ['diff', head.ok ? 'HEAD' : EMPTY_TREE, ...DIFF_ARGS, '--'], 30_000),
    untracked(run, cwd),
    run(cwd, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], 5000)
  ])
  if (!diff.ok) return { ok: false, error: problemOf(diff, 'git diff failed.') }
  const text = diff.stdout + added
  if (!text.trim()) return { ok: false, error: 'There are no uncommitted changes.' }
  const where = branch.ok && branch.stdout.trim() ? ` on branch ${branch.stdout.trim()}` : ''
  return done('Uncommitted changes', `The uncommitted changes in ${cwd}${where}, as git diff against the last commit, new files included:`, text)
}

async function branchDiff(run: Runner, cwd: string, name: string): Promise<GitText> {
  let ref = name
  if (!(await run(cwd, 'git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 5000)).ok) {
    ref = `origin/${name}`
    if (!(await run(cwd, 'git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 5000)).ok) return { ok: false, error: `There is no branch called ${name}.` }
  }
  const base = await defaultBranch(run, cwd)
  if (!base) return { ok: false, error: 'There is no main or master branch to compare it with.' }
  if (base.name === name) return { ok: false, error: `Changes are compared with ${base.name}, so there is nothing to show for it. Mention a commit instead.` }
  const mb = await run(cwd, 'git', ['merge-base', base.ref, ref], 10_000)
  const mergeBase = mb.ok ? mb.stdout.trim() : ''
  if (!mergeBase) return { ok: false, error: `${name} shares no history with ${base.name}.` }
  const [diff, log] = await Promise.all([
    run(cwd, 'git', ['diff', mergeBase, ref, ...DIFF_ARGS, '--'], 30_000),
    run(cwd, 'git', ['log', '-n30', '--no-color', '--format=%h %s', `${mergeBase}..${ref}`], 10_000)
  ])
  if (!diff.ok) return { ok: false, error: problemOf(diff, 'git diff failed.') }
  if (!diff.stdout.trim()) return { ok: false, error: `${name} has no changes compared with ${base.name}.` }
  const commits = log.ok ? log.stdout.split('\n').filter(Boolean) : []
  const head = [`The changes on branch ${name} compared with ${base.name} (since ${mergeBase.slice(0, 7)}), committed work only:`, ...commits.map((c) => `  ${c}`)].join('\n')
  return done(`Branch ${name}`, head, diff.stdout)
}

async function commitDiff(run: Runner, cwd: string, sha: string): Promise<GitText> {
  const res = await run(cwd, 'git', ['show', ...DIFF_ARGS, '--format=medium', '--stat', '--patch', sha, '--'], 30_000)
  if (!res.ok) return { ok: false, error: problemOf(res, 'git couldn’t show that commit.') }
  return done(`Commit ${sha.slice(0, 7)}`, `The commit ${sha.slice(0, 7)} in ${cwd}:`, res.stdout)
}

/** A git mention as the text of its diff, with a line first saying what it is. */
export function gitMentionText(run: Runner, cwd: string, mention: GitMention): Promise<GitText> {
  if (mention.kind === 'uncommitted') return uncommitted(run, cwd)
  if (mention.kind === 'branch') return branchDiff(run, cwd, mention.name)
  return commitDiff(run, cwd, mention.sha)
}
