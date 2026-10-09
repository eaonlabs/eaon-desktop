import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Feature } from './types'
import { store } from '../store'
import { adoptLoginShellPath } from '../shellEnv'
import { adeSessions, knownProjects, worktreesRoot } from './ade'
import * as git from './ade/git'
import { folderName, worktreeFolderFor } from '@shared/adeSessions'
import {
  REVIEW_FILE,
  TASK_FILE,
  foldedBody,
  githubRepoOf,
  parseReview,
  reviewPrompt,
  reviewTask,
  type PostReviewResult,
  type PrReview,
  type ReviewState,
  type ReviewTarget,
  type StartReviewResult
} from '@shared/prReview'

/**
 * Pull request review by an agent (shared/prReview.ts): the PR checked out in
 * a worktree as an ADE session, the agent's review read back, and posted to
 * GitHub when the person says so. GitHub is reached only through the `gh`
 * CLI they are signed in with, as the Pull requests page already does.
 */

const STATE_FILE = 'pr-reviews.json'

/** Runs a program, with input on stdin if given; its stdout, or an error with what it printed. */
function run(file: string, args: string[], options: { cwd?: string; input?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000)
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? `${file === 'gh' ? 'The GitHub CLI (gh)' : file} isn’t installed.` : e.message))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error((err || out).trim().split('\n').filter(Boolean).pop() ?? `${file} failed`))
    })
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

const gh = (args: string[], options?: { cwd?: string; input?: string; timeoutMs?: number }): Promise<string> => run('gh', args, options)

function ghError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/gh auth login|not logged in|authentication/i.test(message)) return 'The GitHub CLI isn’t signed in. Run “gh auth login” in a terminal, then try again.'
  return message
}

/* ------------------------------------------------------------------ state */

type Saved = Record<string, ReviewState>
const loadAll = (): Saved => store.getJson<Saved>(STATE_FILE, {}) ?? {}
const saveAll = (all: Saved): void => store.setJson(STATE_FILE, all)

/** The review the agent wrote in the worktree, if it has. */
function readReview(state: ReviewState): PrReview | null {
  try {
    return parseReview(JSON.parse(fs.readFileSync(path.join(state.cwd, REVIEW_FILE), 'utf8')))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ start */

async function target(url: string): Promise<ReviewTarget> {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url)
  if (!m) throw new Error('That isn’t a GitHub pull request link.')
  const [view, login] = await Promise.all([
    gh(['pr', 'view', url, '--json', 'number,title,url,baseRefName,headRefName,body,author']),
    gh(['api', 'user', '--jq', '.login']).catch(() => '')
  ])
  const pr = JSON.parse(view) as { number: number; title: string; url: string; baseRefName: string; headRefName: string; body: string; author?: { login?: string } }
  return {
    repo: m[1],
    number: pr.number,
    title: pr.title,
    url: pr.url,
    base: pr.baseRefName,
    head: pr.headRefName,
    body: pr.body ?? '',
    own: Boolean(login.trim()) && pr.author?.login === login.trim()
  }
}

/** A clone of `repo` on this computer: one the ADE knows, else one made under ~/Eaon/repos. */
async function localClone(repo: string): Promise<string> {
  const want = repo.toLowerCase()
  for (const dir of knownProjects()) {
    const info = await git.repoInfo(dir).catch(() => null)
    if (!info) continue
    const remote = await git.remoteUrl(info.root)
    if (remote && githubRepoOf(remote)?.toLowerCase() === want) return info.root
  }
  const [owner, name] = repo.split('/')
  const dir = path.join(os.homedir(), 'Eaon', 'repos', owner, name)
  if (fs.existsSync(path.join(dir, '.git'))) return dir
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  await gh(['repo', 'clone', repo, dir], { timeoutMs: 10 * 60_000 })
  return dir
}

/** `.eaon/` stays out of git in every worktree of the repository. */
async function excludeEaonFolder(dir: string): Promise<void> {
  const file = path.join(await git.commonDir(dir), 'info', 'exclude')
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (current.split('\n').some((line) => line.trim() === '.eaon/')) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}# Eaon's review notes\n.eaon/\n`)
}

async function start(url: string): Promise<StartReviewResult> {
  try {
    await adoptLoginShellPath()
    const t = await target(url)
    const root = await localClone(t.repo)
    const ref = `refs/remotes/origin/eaon-pr/${t.number}`
    await git.fetchOrigin(root, `+pull/${t.number}/head:${ref}`)
    await git.fetchOrigin(root, t.base).catch(() => undefined)
    const dir = path.join(worktreesRoot(), worktreeFolderFor(folderName(root)), `review-pr-${t.number}`)
    if (fs.existsSync(dir)) await git.checkoutDetached(dir, ref)
    else {
      fs.mkdirSync(path.dirname(dir), { recursive: true })
      await git.addDetachedWorktree(root, dir, ref)
    }
    await excludeEaonFolder(dir)
    fs.mkdirSync(path.join(dir, '.eaon'), { recursive: true })
    // A review asked for again starts fresh.
    fs.rmSync(path.join(dir, REVIEW_FILE), { force: true })
    fs.writeFileSync(path.join(dir, TASK_FILE), reviewTask(t))
    const session = await adeSessions().track(dir, `Review #${t.number}: ${t.title}`, true)
    const state: ReviewState = { target: t, sessionId: session.id, cwd: dir, startedAt: Date.now(), review: null, postedUrl: null }
    const all = loadAll()
    all[t.url] = state
    saveAll(all)
    return { ok: true, state, prompt: reviewPrompt(t) }
  } catch (error) {
    return { ok: false, error: ghError(error) }
  }
}

/* ------------------------------------------------------------------ post */

async function post(url: string, edited: unknown): Promise<PostReviewResult> {
  const all = loadAll()
  const state = all[url]
  if (!state) return { ok: false, error: 'There’s no review of that pull request to post.' }
  const review = parseReview(edited)
  if (!review) return { ok: false, error: 'The review is empty. Write a summary or a comment first.' }
  try {
    await adoptLoginShellPath()
    const { repo, number, own } = state.target
    const head = JSON.parse(await gh(['pr', 'view', url, '--json', 'headRefOid'])) as { headRefOid: string }
    // GitHub refuses to let someone approve, or ask for changes on, their own pull request.
    const event = own ? 'COMMENT' : review.event
    const send = (body: object): Promise<string> =>
      gh(['api', `repos/${repo}/pulls/${number}/reviews`, '--method', 'POST', '--input', '-'], { input: JSON.stringify(body) })
    let answer: string
    try {
      answer = await send({
        commit_id: head.headRefOid,
        event,
        body: review.summary,
        comments: review.comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body }))
      })
    } catch (error) {
      // A comment on a line the diff doesn't show (422): the review goes as one comment rather than not at all.
      if (review.comments.length === 0 || !/422|Unprocessable|line|position|diff/i.test(String((error as Error).message))) throw error
      answer = await send({ commit_id: head.headRefOid, event, body: foldedBody(review) })
    }
    const posted = (JSON.parse(answer) as { html_url?: string }).html_url ?? url
    all[url] = { ...state, review, postedUrl: posted }
    saveAll(all)
    return { ok: true, url: posted }
  } catch (error) {
    return { ok: false, error: ghError(error) }
  }
}

export const prReviewFeature: Feature = {
  id: 'pr-review',
  register: ({ ipcMain }) => {
    const text = (value: unknown): string => {
      if (typeof value !== 'string' || !value || value.length > 2000) throw new Error('Expected a pull request link.')
      return value
    }
    ipcMain.handle('pr-review:start', (_e, url: unknown) => start(text(url)))
    ipcMain.handle('pr-review:post', (_e, url: unknown, review: unknown) => post(text(url), review))
    // Every review asked for, with what the agent has written so far.
    ipcMain.handle('pr-review:list', (): ReviewState[] =>
      Object.values(loadAll()).map((state) => ({ ...state, review: state.postedUrl ? state.review : (readReview(state) ?? state.review) }))
    )
  }
}
